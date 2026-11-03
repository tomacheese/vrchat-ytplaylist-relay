import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from './config'
import { KeyedMutex } from './lock'
import { logger } from './logger'
import { downloadVideo, YtdlpError } from './ytdlp'

/** Serializes cache downloads per videoId (prevents concurrent requests for the same video from downloading twice in "proxy" mode). */
const downloadMutex = new KeyedMutex()

/** Limits temporary downloads into the same cache directory to one at a time. */
const cacheFillMutex = new KeyedMutex()

/** Metadata of a cache entry persisted to disk per videoId. */
interface CacheEntryMeta {
  videoId: string
  sizeBytes: number
  /** When the video file was last downloaded (refreshed). Used for the TTL check. */
  downloadedAt: number
  /** When it was last read as a cache hit. Used for LRU eviction. */
  lastAccessedAt: number
}

function cacheFilePath(cacheDir: string, videoId: string): string {
  return path.join(cacheDir, `${encodeURIComponent(videoId)}.mp4`)
}

function cacheMetaPath(cacheDir: string, videoId: string): string {
  return path.join(cacheDir, `${encodeURIComponent(videoId)}.meta.json`)
}

/**
 * Writes to a tmp file, then renames. A rename on the same volume is atomic, so readers
 * never see partially written content (same approach as writeFileAtomic in manifest-store.ts).
 */
function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmpPath, content, 'utf8')
  fs.renameSync(tmpPath, filePath)
}

function loadMeta(cacheDir: string, videoId: string): CacheEntryMeta | null {
  const file = cacheMetaPath(cacheDir, videoId)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CacheEntryMeta
  } catch {
    // Treat corrupt metadata as a cache miss and recover by re-downloading.
    return null
  }
}

function persistMeta(cacheDir: string, meta: CacheEntryMeta): void {
  writeFileAtomic(
    cacheMetaPath(cacheDir, meta.videoId),
    JSON.stringify(meta, null, 2)
  )
}

/** Reads all metadata under cacheDir. Returns an empty array if the directory does not exist. */
function listAllMeta(cacheDir: string): CacheEntryMeta[] {
  if (!fs.existsSync(cacheDir)) return []
  const entries: CacheEntryMeta[] = []
  for (const name of fs.readdirSync(cacheDir)) {
    if (!name.endsWith('.meta.json')) continue
    try {
      entries.push(
        JSON.parse(
          fs.readFileSync(path.join(cacheDir, name), 'utf8')
        ) as CacheEntryMeta
      )
    } catch {
      // Exclude corrupt metadata from size accounting and eviction selection (the broken file itself stays, with little harm).
    }
  }
  return entries
}

/**
 * Pure function: when the total cache size exceeds maxBytes, picks the videoIds to evict, oldest last access first.
 * Returns an empty array if the total does not exceed it.
 */
export function selectEvictions(
  entries: CacheEntryMeta[],
  maxBytes: number
): string[] {
  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
  if (totalBytes <= maxBytes) return []

  const sortedByLru = entries.toSorted(
    (a, b) => a.lastAccessedAt - b.lastAccessedAt
  )
  const evictVideoIds: string[] = []
  let remaining = totalBytes
  for (const entry of sortedByLru) {
    if (remaining <= maxBytes) break
    evictVideoIds.push(entry.videoId)
    remaining -= entry.sizeBytes
  }
  return evictVideoIds
}

function runEviction(
  cacheDir: string,
  maxBytes: number,
  protectedVideoId: string
): void {
  const entries = listAllMeta(cacheDir)
  const protectedBytes =
    entries.find((entry) => entry.videoId === protectedVideoId)?.sizeBytes ?? 0
  const evictVideoIds = selectEvictions(
    entries.filter((entry) => entry.videoId !== protectedVideoId),
    maxBytes - protectedBytes
  )
  for (const videoId of evictVideoIds) {
    try {
      fs.rmSync(cacheFilePath(cacheDir, videoId), { force: true })
      fs.rmSync(cacheMetaPath(cacheDir, videoId), { force: true })
      logger.info(
        'media.cache.evicted',
        'Evicted cached video using LRU policy',
        { video_id: videoId, reason: 'cache_size_exceeded' }
      )
    } catch (err) {
      logger.warn(
        'media.cache.eviction_failed',
        'Failed to evict cached video',
        { video_id: videoId, error: err }
      )
    }
  }
}

/** Ignores the TTL. */
function hasCompletedEntry(
  meta: CacheEntryMeta | null,
  filePath: string
): meta is CacheEntryMeta {
  if (!meta) return false
  return fs.existsSync(filePath)
}

function isFresh(
  meta: CacheEntryMeta | null,
  filePath: string,
  ttlMs: number,
  now: number
): meta is CacheEntryMeta {
  if (!hasCompletedEntry(meta, filePath)) return false
  return now - meta.downloadedAt < ttlMs
}

/**
 * Returns the absolute path of the cached video file for a videoId only if it is fresh
 * (within the TTL, `mediaCacheTtlMs`), without starting a download. Returns `null` otherwise
 * (used to decide whether the "hybrid" delivery mode should fall back to redirect).
 */
export function peekFreshCache(
  config: AppConfig,
  videoId: string
): string | null {
  const filePath = cacheFilePath(config.mediaCacheDir, videoId)
  const now = Date.now()
  const meta = loadMeta(config.mediaCacheDir, videoId)
  if (!isFresh(meta, filePath, config.mediaCacheTtlMs, now)) return null
  persistMeta(config.mediaCacheDir, { ...meta, lastAccessedAt: now })
  return filePath
}

/**
 * Returns the cached video file's absolute path for a videoId, ignoring the TTL, if a download has ever completed.
 * Returns `null` only if none has completed.
 * Used by {@link getFreshOrStale} to keep serving the previously valid completed file
 * even while a TTL-expired entry is being re-downloaded ("stale-while-revalidate").
 */
export function peekStaleCache(
  config: AppConfig,
  videoId: string
): string | null {
  const filePath = cacheFilePath(config.mediaCacheDir, videoId)
  const now = Date.now()
  const meta = loadMeta(config.mediaCacheDir, videoId)
  if (!hasCompletedEntry(meta, filePath)) return null
  persistMeta(config.mediaCacheDir, { ...meta, lastAccessedAt: now })
  return filePath
}

/**
 * Downloads a videoId into the cache and returns its absolute path.
 * Skips the {@link peekFreshCache} check and goes straight to acquiring the mutex, because the caller
 * has already confirmed there is no fresh cache. This lets {@link triggerBackgroundDownload} start
 * without a second synchronous fs check.
 *
 * Concurrent calls for the same videoId are serialized by {@link downloadMutex}, so no duplicate download occurs.
 */
async function downloadAndCache(
  config: AppConfig,
  videoId: string
): Promise<string> {
  const filePath = cacheFilePath(config.mediaCacheDir, videoId)

  return downloadMutex.run(videoId, async () =>
    cacheFillMutex.run(config.mediaCacheDir, async () =>
      logger.withContext(
        {
          operation: 'media.cache.download',
          operation_id: logger.newOperationId(),
        },
        async () => {
          const startedAt = performance.now()
          let phase = 'prepare'
          try {
            // Another call may have finished the download while we waited for the mutex, so re-check.
            const recheckFresh = peekFreshCache(config, videoId)
            if (recheckFresh) return recheckFresh

            fs.mkdirSync(config.mediaCacheDir, { recursive: true })
            phase = 'download'
            await downloadVideo(videoId, filePath, {
              ytdlpPath: config.ytdlpPath,
              timeoutMs: config.mediaDownloadTimeoutMs,
              maxHeight: config.mediaMaxHeight,
              maxBytes: config.mediaCacheMaxBytes,
            })

            phase = 'verify'
            const stat = fs.statSync(filePath)
            const downloadedAt = Date.now()
            const newMeta: CacheEntryMeta = {
              videoId,
              sizeBytes: stat.size,
              downloadedAt,
              lastAccessedAt: downloadedAt,
            }
            phase = 'metadata'
            persistMeta(config.mediaCacheDir, newMeta)
            logger.info('media.cache.downloaded', 'Video cached', {
              video_id: videoId,
              size_bytes: stat.size,
              duration_ms: Math.round(performance.now() - startedAt),
            })

            phase = 'eviction'
            runEviction(
              config.mediaCacheDir,
              config.mediaCacheMaxBytes,
              videoId
            )
            return filePath
          } catch (err) {
            logger.error('media.cache.download_failed', 'Cache fill failed', {
              video_id: videoId,
              phase,
              duration_ms: Math.round(performance.now() - startedAt),
              error: err,
            })
            throw err
          }
        }
      )
    )
  )
}

/**
 * Returns the absolute path of the cached video file for a videoId.
 * If there is no cache or the TTL (`mediaCacheTtlMs`) has passed, re-download with yt-dlp first
 * (the "proxy" delivery Media Endpoint serves the result with `res.sendFile()`).
 */
export async function getOrDownload(
  config: AppConfig,
  videoId: string
): Promise<string> {
  const fresh = peekFreshCache(config, videoId)
  if (fresh) return fresh
  return downloadAndCache(config, videoId)
}

/**
 * Starts downloading a videoId but returns immediately without waiting for completion (used by the
 * "hybrid" delivery mode to return the redirect fallback first while fetching the latest version in the background).
 * The caller has already confirmed via {@link peekFreshCache} that there is no fresh cache, so this calls
 * {@link downloadAndCache} directly instead of re-checking (to avoid synchronous fs access before the 302).
 * Failures are only logged, not reported to the caller (it has already responded).
 * Even if the same videoId is already queued by {@link prefetchAll}, {@link downloadMutex} prevents
 * duplicate downloads, so there is no dedicated priority queue.
 */
export function triggerBackgroundDownload(
  config: AppConfig,
  videoId: string
): void {
  downloadAndCache(config, videoId).catch(() => undefined)
}

/**
 * Returns the cached video file for a videoId as-is if fresh (within TTL).
 * If the TTL has expired but a previously valid completed file exists ("stale-while-revalidate"),
 * return it anyway and start {@link triggerBackgroundDownload} in the background
 * (later requests get the new file). Returns `null` only if no download has ever completed
 * (callers treat that as "not cached", as before).
 *
 * Calling {@link peekFreshCache} / {@link peekStaleCache} naively would read the meta and run
 * `persistMeta` twice, so the meta is read once here and reused for both checks.
 */
export function getFreshOrStale(
  config: AppConfig,
  videoId: string
): string | null {
  const filePath = cacheFilePath(config.mediaCacheDir, videoId)
  const now = Date.now()
  const meta = loadMeta(config.mediaCacheDir, videoId)
  if (!hasCompletedEntry(meta, filePath)) return null

  persistMeta(config.mediaCacheDir, { ...meta, lastAccessedAt: now })
  if (now - meta.downloadedAt >= config.mediaCacheTtlMs) {
    triggerBackgroundDownload(config, videoId)
  }
  return filePath
}

/** How long the whole prefetch pauses after bot detection. ponytail: fixed 5 minutes, make it an env var if it needs to vary. */
const BOT_DETECTION_COOLDOWN_MS = 5 * 60 * 1000

/** Wait before retrying a transient error such as a timeout. */
const TRANSIENT_RETRY_DELAY_MS = 1000

/** Waits for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether the yt-dlp stderr shows a block by YouTube's bot detection.
 * This is a temporary IP block rather than a per-video problem, so it is handled with a prefetch-wide cooldown, not retries.
 */
function isBotDetectionError(err: unknown): boolean {
  return (
    err instanceof YtdlpError &&
    /Sign in to confirm you.re not a bot/.test(err.stderr)
  )
}

/** Whether the yt-dlp stderr shows a permanent video-unavailable error that retrying will not fix. */
function isPermanentVideoError(err: unknown): boolean {
  return (
    err instanceof YtdlpError &&
    /Video unavailable|Private video|This video is unavailable|This video has been removed/.test(
      err.stderr
    )
  )
}

/** Logs a prefetch failure. */
function logPrefetchFailure(videoId: string, err: unknown, suffix = ''): void {
  logger.warn('media.prefetch.failed', 'Video prefetch failed', {
    video_id: videoId,
    reason: suffix.trim() || undefined,
    error: err instanceof Error ? err : new Error(String(err)),
  })
}

/**
 * Pre-downloads multiple videoIds with limited concurrency (background prefetch after a Playlist Refresh).
 * Failures are only logged, never thrown, so one failure does not stop the other prefetches.
 *
 * Behavior by error class:
 * - Bot detection: no retry; skip the remaining videoIds for {@link BOT_DETECTION_COOLDOWN_MS}
 *   (rapid retries would invite further blocking; the rest is left to the next Refresh/Prefetch cycle).
 * - Permanent video-unavailable error: retrying is pointless, so give up immediately.
 * - Anything else (transient, e.g. timeout): retry once after a short wait.
 */
export async function prefetchAll(
  config: AppConfig,
  videoIds: string[],
  concurrency = 2
): Promise<void> {
  return logger.withContext(
    { operation: 'media.prefetch', operation_id: logger.newOperationId() },
    async () => {
      const startedAt = performance.now()
      let cursor = 0
      let cooldownUntil = 0

      // Errors from the first try and the retry go through the same classification, so the retry
      // cannot miss bot detection and skip the cooldown.
      /** Fetches a video, then retries, cools down or logs the failure depending on the error class. */
      async function attempt(videoId: string): Promise<void> {
        for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber++) {
          try {
            await getOrDownload(config, videoId)
            return
          } catch (err) {
            if (isBotDetectionError(err)) {
              cooldownUntil = Date.now() + BOT_DETECTION_COOLDOWN_MS
              logPrefetchFailure(
                videoId,
                err,
                ` (bot detection, pausing prefetch for ${BOT_DETECTION_COOLDOWN_MS / 1000}s)`
              )
              return
            }
            if (isPermanentVideoError(err)) {
              logPrefetchFailure(videoId, err)
              return
            }
            if (attemptNumber === 1) {
              logPrefetchFailure(videoId, err, ', retrying once')
              await sleep(TRANSIENT_RETRY_DELAY_MS)
              continue
            }
            logPrefetchFailure(videoId, err, ' after retry')
          }
        }
      }

      /** Takes the next video from the shared cursor, up to the given concurrency. */
      async function worker(): Promise<void> {
        while (cursor < videoIds.length) {
          const videoId = videoIds[cursor]
          cursor += 1
          if (Date.now() < cooldownUntil) {
            // Stop rather than `continue`, so the rest is not consumed synchronously with a flood of logs
            // (unprocessed videos are left to the next Refresh/Prefetch cycle).
            logger.warn(
              'media.prefetch.cooldown',
              'Prefetch cooldown is active; remaining videos were skipped',
              { video_id: videoId, cooldown_until: cooldownUntil }
            )
            return
          }
          await attempt(videoId)
        }
      }
      const workerCount = Math.min(concurrency, videoIds.length)
      await Promise.all(Array.from({ length: workerCount }, () => worker()))
      logger.info('media.prefetch.completed', 'Media prefetch completed', {
        video_count: videoIds.length,
        cooldown_active: Date.now() < cooldownUntil,
        duration_ms: Math.round(performance.now() - startedAt),
      })
    }
  )
}
