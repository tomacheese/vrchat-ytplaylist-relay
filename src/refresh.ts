import type { AppConfig } from './config'
import { isPlaylistAllowed, maxSlotsFor } from './config'
import { logger } from './logger'
import { KeyedMutex } from './lock'
import { resolveVideoInfo } from './live-resolve'
import { prefetchAll } from './media-cache'
import {
  buildManifest,
  listKnownPlaylistIds,
  loadSlotState,
  persistSlotState,
  recordFailure,
} from './manifest-store'
import type { Manifest } from './types'
import { fetchPlaylistEntries } from './ytdlp'

const refreshMutex = new KeyedMutex()
const relayWarmupMinDurationSeconds = 30 * 60
const relayWarmupConcurrency = 2
const relayWarmupLimitPerPlaylist = 8
const relayWarmupQueueLimit = 32
const relayWarmupQueue: {
  playlistId: string
  videoId: string
  requestId?: string
}[] = []
const scheduledRelayWarmups = new Set<string>()
let activeRelayWarmups = 0

/**
 * In-flight refreshes per playlistId, making Refresh single-flight.
 * `KeyedMutex` only serializes runs for the same playlistId and does not deduplicate them,
 * so without this, N concurrent requests (e.g. for an unresolved position) would run yt-dlp N times in sequence.
 */
const inFlightRefreshes = new Map<string, Promise<RefreshResult>>()

/** Most recently fetched Manifest per playlistId. Playlist data is kept only here in memory, never persisted to disk. */
interface CacheEntry {
  manifest: Manifest
  fetchedAt: number
}

/** In-memory Manifest cache; cleared on process restart. */
const manifestCache = new Map<string, CacheEntry>()

const recentFailures = new Map<string, { retryAt: number; error: string }>()
const recentFailureLimit = 256

function failureKey(config: AppConfig, playlistId: string): string {
  return `${config.dataDir}\0${playlistId}`
}

/** Bounds recentFailures so failures for invalid playlists requested only once are not kept forever. */
function pruneRecentFailures(): void {
  const now = Date.now()
  for (const [key, failure] of recentFailures) {
    if (failure.retryAt <= now) recentFailures.delete(key)
  }
  while (recentFailures.size > recentFailureLimit) {
    const oldest = recentFailures.keys().next().value
    if (oldest === undefined) break
    recentFailures.delete(oldest)
  }
}

function startRelayWarmups(config: AppConfig): void {
  while (
    activeRelayWarmups < relayWarmupConcurrency &&
    relayWarmupQueue.length > 0
  ) {
    const warmup = relayWarmupQueue.shift()
    if (!warmup) return
    activeRelayWarmups += 1
    const finishWarmup = () => {
      scheduledRelayWarmups.delete(warmup.videoId)
      activeRelayWarmups -= 1
      startRelayWarmups(config)
    }
    const operationId = logger.newOperationId()
    logger.withContext(
      {
        request_id: warmup.requestId,
        operation: 'relay.warmup',
        operation_id: operationId,
      },
      () => {
        const startedAt = performance.now()
        resolveVideoInfo(warmup.videoId, {
          ytdlpPath: config.ytdlpPath,
          timeoutMs: config.ytdlpTimeoutMs,
          cacheTtlMs: config.manifestCacheTtlMs,
        }).then(
          () => {
            logger.info('relay.warmup.completed', 'Relay warm-up completed', {
              playlist_id: warmup.playlistId,
              video_id: warmup.videoId,
              duration_ms: Math.round(performance.now() - startedAt),
            })
            finishWarmup()
          },
          (err: unknown) => {
            logger.warn('relay.warmup.failed', 'Relay warm-up failed', {
              playlist_id: warmup.playlistId,
              video_id: warmup.videoId,
              duration_ms: Math.round(performance.now() - startedAt),
              error: err instanceof Error ? err : new Error(String(err)),
            })
            finishWarmup()
          }
        )
      }
    )
  }
}

function scheduleRelayWarmups(
  config: AppConfig,
  playlistId: string,
  entries: Awaited<ReturnType<typeof fetchPlaylistEntries>>
): void {
  const longEntries = entries
    .filter(
      (entry) =>
        typeof entry.duration === 'number' &&
        Number.isFinite(entry.duration) &&
        entry.duration >= relayWarmupMinDurationSeconds
    )
    .toSorted((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, relayWarmupLimitPerPlaylist)

  for (const entry of longEntries) {
    if (scheduledRelayWarmups.has(entry.id)) continue
    if (relayWarmupQueue.length >= relayWarmupQueueLimit) {
      logger.warn('relay.warmup.skipped', 'Relay warm-up queue is full', {
        playlist_id: playlistId,
        video_id: entry.id,
      })
      continue
    }
    scheduledRelayWarmups.add(entry.id)
    relayWarmupQueue.push({
      playlistId,
      videoId: entry.id,
      requestId: logger.getContext().request_id,
    })
  }

  startRelayWarmups(config)
}

/** Refresh result for one Playlist. `error` holds the failure reason when `ok` is false. */
export interface RefreshResult {
  playlistId: string
  ok: boolean
  generation?: number
  trackCount?: number
  error?: string
}

/** Actual work of {@link refreshPlaylist}, separated from the single-flight Map handling. */
function runRefresh(
  config: AppConfig,
  playlistId: string,
  warmRelayVideos: boolean
): Promise<RefreshResult> {
  return refreshMutex.run(playlistId, async () =>
    logger.withContext(
      {
        operation: 'playlist.refresh',
        operation_id: logger.newOperationId(),
      },
      async () => {
        const startedAt = performance.now()
        const maxSlots = maxSlotsFor(config, playlistId)
        const now = Date.now()
        try {
          const entries = await fetchPlaylistEntries(playlistId, {
            ytdlpPath: config.ytdlpPath,
            timeoutMs: config.ytdlpTimeoutMs,
          })
          const previous = loadSlotState(config.dataDir, playlistId)
          const { state, manifest } = buildManifest(
            previous,
            playlistId,
            maxSlots,
            entries,
            now
          )
          persistSlotState(config.dataDir, state)
          manifestCache.set(playlistId, { manifest, fetchedAt: now })
          recentFailures.delete(failureKey(config, playlistId))
          logger.info(
            'playlist.refresh.completed',
            'Playlist refresh completed',
            {
              playlist_id: playlistId,
              generation: state.generation,
              track_count: entries.length,
              duration_ms: Math.round(performance.now() - startedAt),
            }
          )

          if (
            config.mediaDeliveryMode === 'proxy' ||
            config.mediaDeliveryMode === 'hybrid'
          ) {
            // Not awaited, to avoid blocking the response. A failure is only logged; on a cold cache
            // the Media Endpoint (getOrDownload / hybrid redirect fallback) downloads the file again,
            // so functionality is unaffected.
            // The trailing .catch() handles rejections, so no-floating-promises does not flag it.
            prefetchAll(
              config,
              entries.map((entry) => entry.id)
            ).catch((err: unknown) => {
              logger.error(
                'media.prefetch.failed',
                'Playlist media prefetch failed',
                {
                  playlist_id: playlistId,
                  error: err instanceof Error ? err : new Error(String(err)),
                }
              )
            })
          } else if (warmRelayVideos && config.mediaDeliveryMode === 'relay') {
            scheduleRelayWarmups(config, playlistId, entries)
          }

          return {
            playlistId,
            ok: true,
            generation: state.generation,
            trackCount: entries.length,
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error('playlist.refresh.failed', 'Playlist refresh failed', {
            playlist_id: playlistId,
            duration_ms: Math.round(performance.now() - startedAt),
            error: err instanceof Error ? err : new Error(message),
          })
          const failedAt = Date.now()
          recentFailures.set(failureKey(config, playlistId), {
            retryAt: failedAt + config.manifestRetryDelayMs,
            error: message,
          })
          pruneRecentFailures()
          try {
            recordFailure(
              config.dataDir,
              playlistId,
              maxSlots,
              message,
              failedAt
            )
          } catch (recordError) {
            logger.warn(
              'playlist.refresh.failure_record_failed',
              'Failed to persist playlist refresh failure',
              { playlist_id: playlistId, error: recordError }
            )
          }
          return { playlistId, ok: false, error: message }
        }
      }
    )
  )
}

/**
 * Runs yt-dlp to fetch one Playlist and updates the Position Pool (slots.json) and the in-memory cache.
 * Always runs yt-dlp regardless of TTL, so it serves both on-demand fetches for clients
 * ({@link getManifestForClient}) and forced refreshes by an admin (`/admin/refresh`, CLI).
 * Runs for the same playlistId are serialized by KeyedMutex and made single-flight via
 * `inFlightRefreshes` (later callers get the already-running Promise).
 * On failure the Position Pool state and memory cache are left unchanged; only the failure is recorded.
 */
export async function refreshPlaylist(
  config: AppConfig,
  playlistId: string,
  options: { warmRelayVideos?: boolean } = {}
): Promise<RefreshResult> {
  if (!isPlaylistAllowed(config, playlistId)) {
    return { playlistId, ok: false, error: `Unknown playlistId: ${playlistId}` }
  }

  const inFlight = inFlightRefreshes.get(playlistId)
  if (inFlight) return inFlight

  const promise = runRefresh(
    config,
    playlistId,
    options.warmRelayVideos ?? true
  ).finally(() => {
    inFlightRefreshes.delete(playlistId)
  })
  inFlightRefreshes.set(playlistId, promise)
  return promise
}

/**
 * Returns the playlistIds targeted by a bulk Refresh.
 * Uses the allowlist (`config.playlists`) when set; when it is disabled (empty) there is no
 * pre-registered list, so it falls back to playlistIds whose Position Pool state is persisted
 * (i.e. refreshed successfully at least once). It reads on-disk state rather than `manifestCache`
 * because the `pnpm refresh` CLI runs in a separate process from the server and shares no memory.
 */
function refreshAllTargets(config: AppConfig): string[] {
  if (config.playlists.length > 0) {
    return config.playlists.map((entry) => entry.playlistId)
  }
  return listKnownPlaylistIds(config.dataDir)
}

/**
 * Refreshes each target from {@link refreshAllTargets} in turn.
 * A failure for one Playlist does not prevent the others from being refreshed.
 * Used by `/admin/refresh` (forced cache invalidation and refetch) and the CLI.
 */
export async function refreshAll(
  config: AppConfig,
  options: { warmRelayVideos?: boolean } = {}
): Promise<RefreshResult[]> {
  const results: RefreshResult[] = []
  for (const playlistId of refreshAllTargets(config)) {
    // Run sequentially to avoid spawning many yt-dlp processes at once and hitting YouTube rate limits.
    results.push(await refreshPlaylist(config, playlistId, options))
  }
  return results
}

/**
 * Returns the Manifest for a client's `GET /:playlistId/manifest.json`.
 *
 * - If the memory cache is within TTL, returns it without running yt-dlp.
 * - If expired or missing, runs yt-dlp to fetch a fresh Manifest.
 * - If yt-dlp fails and a previous cache entry exists, returns it as stale
 *   (so the World can keep "the current Playlist" even when a Manifest fetch fails).
 *   If there has never been a cache entry, returns manifest: null (the caller should respond 503).
 *
 * @param playlistId must already be verified against config.playlists by the caller
 */
export async function getManifestForClient(
  config: AppConfig,
  playlistId: string
): Promise<{ manifest: Manifest | null; error?: string }> {
  const cached = manifestCache.get(playlistId)
  if (cached && Date.now() - cached.fetchedAt < config.manifestCacheTtlMs) {
    return { manifest: cached.manifest }
  }

  pruneRecentFailures()
  const failure = recentFailures.get(failureKey(config, playlistId))
  if (failure) {
    return { manifest: cached?.manifest ?? null, error: failure.error }
  }

  const result = await refreshPlaylist(config, playlistId)
  if (result.ok) {
    // manifestCache should already be updated when refreshPlaylist succeeds.
    const fresh = manifestCache.get(playlistId)
    return { manifest: fresh?.manifest ?? null }
  }

  if (cached) {
    logger.warn(
      'playlist.refresh.cache_served',
      'Serving stale cached manifest after refresh failed',
      { playlist_id: playlistId, stale: true, refresh_error: result.error }
    )
    return { manifest: cached.manifest, error: result.error }
  }
  return { manifest: null, error: result.error }
}

/**
 * Resolves a videoId from a position for the Media Endpoint (`GET /:playlistId/:position.mp4`).
 * If it is not yet in the persisted Position Pool state (first request, lost state, etc.),
 * it tries a Refresh (running yt-dlp) like the Manifest Endpoint and resolves again.
 * If a Refresh within the last `manifestCacheTtlMs` already failed to resolve it, Refresh is not
 * retried, so repeated requests for an invalid position do not hammer yt-dlp.
 * `reason` lets the caller (Router) tell a transient failure caused by a failed `refreshPlaylist`
 * (`refresh_failed`) from a position that truly does not exist in the Playlist (`not_found`).
 */
export async function resolveVideoIdForPosition(
  config: AppConfig,
  playlistId: string,
  position: number
): Promise<
  | { videoId: string }
  | { error: string; reason: 'not_found' | 'refresh_failed' }
> {
  const state = loadSlotState(config.dataDir, playlistId)
  const videoId = state?.slotToVideoId[String(position)]
  if (videoId) return { videoId }

  const recentlyRefreshed =
    state?.lastRefreshAt !== null &&
    state?.lastRefreshAt !== undefined &&
    Date.now() - state.lastRefreshAt < config.manifestCacheTtlMs
  if (recentlyRefreshed) {
    if (!state.lastRefreshOk && state.lastError) {
      return { error: state.lastError, reason: 'refresh_failed' }
    }
    return { error: 'unknown position', reason: 'not_found' }
  }

  const result = await refreshPlaylist(config, playlistId)
  if (!result.ok) {
    return { error: result.error ?? 'refresh failed', reason: 'refresh_failed' }
  }

  const refreshed = loadSlotState(config.dataDir, playlistId)
  const refreshedVideoId = refreshed?.slotToVideoId[String(position)]
  if (!refreshedVideoId) {
    return { error: 'unknown position', reason: 'not_found' }
  }
  return { videoId: refreshedVideoId }
}

/** Peeks at the cached Manifest without running yt-dlp (for `/health` trackCount). */
export function peekCachedManifest(playlistId: string): Manifest | null {
  return manifestCache.get(playlistId)?.manifest ?? null
}

/** For tests: seeds the memory cache with a Manifest directly, bypassing yt-dlp. */
export function primeManifestCacheForTests(
  playlistId: string,
  manifest: Manifest,
  fetchedAt: number = Date.now()
): void {
  manifestCache.set(playlistId, { manifest, fetchedAt })
}
