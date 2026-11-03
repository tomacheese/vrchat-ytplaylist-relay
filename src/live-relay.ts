import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { VIDEO_ID_PATTERN } from './config'
import type { AppConfig } from './config'
import { KeyedMutex } from './lock'
import { logger } from './logger'
import { resolveVideoInfo } from './live-resolve'
import {
  ensureVodRelay,
  evictVodRelays,
  getVodRelay,
  touchVodRelay,
} from './vod-relay'

/** Fixed file name of the live master playlist, placed under the outDir returned by `ensureLiveRelay`. */
export const LIVE_PLAYLIST_FILE_NAME = 'live.m3u8'

/** Segment file name pattern written by ffmpeg `-f hls` (`live0.ts`, `live1.ts`, ...). */
const SEGMENT_FILE_PATTERN = /^live\d+\.ts$/

/** Grace period between SIGTERM and SIGKILL when stopping ffmpeg. */
const STOP_GRACE_MS = 5000

/**
 * Max wait for the first segment. Several times `-hls_time 4`, so `ensureLiveRelay` still
 * responds when ffmpeg hangs without exiting.
 */
const FIRST_SEGMENT_TIMEOUT_MS = 30_000

/** Per-videoId live relay state. */
interface LiveRelayState {
  videoId: string
  ffmpegProcess: ChildProcess
  outDir: string
  /** Non-null once the first segment is written (i.e. playable). */
  playlistPath: string | null
  startedAt: number
  operationId: string
  lastAccessedAt: number
  /**
   * Resolves if ffmpeg fails during startup (before the first segment).
   * Never resolved on success.
   */
  startupFailure: Promise<Error>
  /** Resolves when the ffmpeg process closes; `stopLiveRelay` waits on it before `fs.rm`. */
  exited: Promise<void>
}

/** Prevents concurrent `ensureLiveRelay()` calls for one videoId from spawning ffmpeg twice (same idea as downloadMutex in media-cache.ts). */
const relayMutex = new KeyedMutex()

/** Running live relays by videoId. */
const relays = new Map<string, LiveRelayState>()

/**
 * Absolute directory holding a videoId's relay files (playlist + segments).
 * `encodeURIComponent(videoId)` is the same path-traversal guard as `cacheFilePath()` in
 * `media-cache.ts` (also used by the serving route, `routes/live.ts`).
 * Throws if videoId does not match `VIDEO_ID_PATTERN`.
 */
export function liveRelayDirFor(config: AppConfig, videoId: string): string {
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    throw new Error(`Invalid videoId for live relay: ${videoId}`)
  }
  return path.join(config.liveRelayOutDir, encodeURIComponent(videoId))
}

/**
 * Waits until the first segment file appears in outDir (resolves immediately if present).
 * Uses `fs.watch` rather than polling for lower latency and cost.
 * Rejects if `failure` (spawn error or abnormal exit during startup) resolves first, or after
 * `FIRST_SEGMENT_TIMEOUT_MS` (independent of process exit, to cover an ffmpeg that hangs).
 */
async function waitForFirstSegment(
  outDir: string,
  failure: Promise<Error>
): Promise<void> {
  const existing = await fs.promises.readdir(outDir).catch(() => [])
  if (existing.some((name) => SEGMENT_FILE_PATTERN.test(name))) return

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const handles: {
      watcher?: fs.FSWatcher
      timer?: ReturnType<typeof setTimeout>
    } = {}

    function finish(action: () => void): void {
      if (settled) return
      settled = true
      if (handles.timer) clearTimeout(handles.timer)
      handles.watcher?.close()
      action()
    }

    handles.watcher = fs.watch(outDir, (_eventType, filename) => {
      if (!filename || !SEGMENT_FILE_PATTERN.test(filename)) return
      finish(resolve)
    })
    // Re-check after registering the watcher to close the race with a segment created between the first scan and the watch.
    fs.promises
      .readdir(outDir)
      .then((entries) => {
        if (entries.some((name) => SEGMENT_FILE_PATTERN.test(name))) {
          finish(resolve)
        }
      })
      .catch(() => undefined)
    handles.timer = setTimeout(() => {
      finish(() => {
        reject(
          new Error(
            `timed out after ${FIRST_SEGMENT_TIMEOUT_MS}ms waiting for the first HLS segment in ${outDir}`
          )
        )
      })
    }, FIRST_SEGMENT_TIMEOUT_MS)
    failure
      .then((err) => {
        finish(() => {
          reject(err)
        })
      })
      .catch(() => {
        // failure only ever resolves; the empty catch satisfies no-floating-promises.
      })
  })
}

/**
 * Waits for `state.exited` (`close` event) after SIGTERM was sent.
 * Switches to SIGKILL after `STOP_GRACE_MS` to avoid zombies.
 */
function waitForFfmpegExit(state: LiveRelayState): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.ffmpegProcess.kill('SIGKILL')
    }, STOP_GRACE_MS)
    state.exited
      .then(() => {
        clearTimeout(timer)
        resolve()
      })
      .catch(() => {
        // exited only ever resolves; the empty catch satisfies no-floating-promises.
      })
  })
}

/**
 * Tears down a videoId's live relay: SIGTERM, wait for the process to exit, then delete the
 * files (so a new process never shares an outDir with an old one still writing).
 * Called on URL expiry / stream end, eviction, and forced stops in tests.
 */
export async function stopLiveRelay(videoId: string): Promise<void> {
  const state = relays.get(videoId)
  if (!state) return
  relays.delete(videoId)
  state.ffmpegProcess.kill('SIGTERM')
  await waitForFfmpegExit(state)
  await fs.promises.rm(state.outDir, { recursive: true, force: true })
}

/**
 * Stops relays whose lastAccessedAt exceeds idleTtlMs.
 * Relays still starting (no first segment yet) are never treated as idle: lastAccessedAt is only
 * updated after startup, so a slow start would otherwise be evicted (startup failure itself is
 * handled by the `waitForFirstSegment` timeout).
 * ponytail: no dedicated setInterval here; evaluated inline in `ensureLiveRelay()` like VOD's
 * runEviction() in downloadAndCache(). Stale processes can linger until the next request;
 * add a background job if that matters.
 */
async function evictIdleLiveRelays(idleTtlMs: number): Promise<void> {
  const now = Date.now()
  const targets: string[] = []
  for (const [videoId, state] of relays) {
    if (state.playlistPath === null) continue
    if (now - state.lastAccessedAt >= idleTtlMs) {
      targets.push(videoId)
    }
  }
  await Promise.all(targets.map((videoId) => stopLiveRelay(videoId)))
}

/** One-time cleanup of relay directories left by a previous process. */
let orphanCleanup: Promise<void> | null = null

/** File names a relay generates, including leftover `input.m3u8` from an older VOD implementation. */
const RELAY_FILE_PATTERN =
  /^(?:live\.m3u8|input\.m3u8|live\d+\.ts|seg\d+\.ts|[av]\d+\.src)(?:\.tmp)?$/

/** Whether the directory contains only relay-generated files. False if unreadable. */
async function isRelayGeneratedDir(dir: string): Promise<boolean> {
  const entries = await fs.promises
    .readdir(dir, { withFileTypes: true })
    .catch(() => null)
  return (
    entries?.every(
      (entry) => entry.isFile() && RELAY_FILE_PATTERN.test(entry.name)
    ) ?? false
  )
}

/**
 * Deletes relay directories under `liveRelayOutDir` left by a previous process. Their segments
 * (whole-video for VOD) are referenced by no `relays` entry and never idle-evicted, so the first
 * call sweeps them. `LIVE_RELAY_OUT_DIR` may point at a non-dedicated path (e.g. `./data`), so
 * only directories named like a videoId (`VIDEO_ID_PATTERN`) and containing only relay-generated
 * files are removed. All callers await the same promise, so a new relay can't start mid-cleanup.
 */
function cleanupOrphanDirs(config: AppConfig): Promise<void> {
  orphanCleanup ??= (async () => {
    const entries = await fs.promises
      .readdir(config.liveRelayOutDir, { withFileTypes: true })
      .catch(() => [])
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !VIDEO_ID_PATTERN.test(entry.name) ||
        relays.has(entry.name)
      )
        continue
      const dir = path.join(config.liveRelayOutDir, entry.name)
      if (await isRelayGeneratedDir(dir)) {
        await fs.promises.rm(dir, { recursive: true, force: true })
      }
    }
  })()
  return orphanCleanup
}

/** Sweep interval. VOD keeps muxed segments, so idle deletion and the size cap must be evaluated even without requests. */
const SWEEP_INTERVAL_MS = 15_000

/** Latest config used by the periodic sweep; updated on every `ensureLiveRelay` call. */
let sweepConfig: AppConfig | null = null
let sweeper: ReturnType<typeof setInterval> | null = null

/**
 * Periodically runs live idle eviction (`evictIdleLiveRelays`) and VOD idle eviction / size cap
 * (`evictVodRelays`). The inline evaluation in `ensureLiveRelay` only runs on new requests, so
 * this frees disk after the last viewer leaves. `unref` keeps it from blocking process exit.
 */
function ensureSweeper(config: AppConfig): void {
  sweepConfig = config
  if (sweeper !== null) return
  sweeper = setInterval(() => {
    const current = sweepConfig
    if (current === null) return
    logger.withContext(
      {
        request_id: undefined,
        operation: 'relay.live.sweep',
        operation_id: logger.newOperationId(),
      },
      () => {
        evictIdleLiveRelays(current.liveRelayIdleTtlMs)
          .then(() => evictVodRelays(current))
          .catch((err: unknown) => {
            logger.warn('relay.live.sweep.failed', 'Live relay sweep failed', {
              error: err instanceof Error ? err : new Error(String(err)),
            })
          })
      }
    )
  }, SWEEP_INTERVAL_MS)
  sweeper.unref()
}

/** For tests: reset the periodic sweep and orphan-cleanup state. */
export function resetLiveRelaySweepForTests(): void {
  if (sweeper !== null) clearInterval(sweeper)
  sweeper = null
  sweepConfig = null
  orphanCleanup = null
}

/** Call when a relay file (live or VOD) is served. */
export function touchLiveRelay(videoId: string): void {
  touchVodRelay(videoId)
  const state = relays.get(videoId)
  if (state) state.lastAccessedAt = Date.now()
}

/**
 * Republishes a live HLS input locally with ffmpeg, keeping only a recent window.
 * `-c copy` only remuxes into HLS, no re-encode.
 * `temp_file` writes segments/playlist via temp file + rename so `fs.watch` in
 * `waitForFirstSegment` and `res.sendFile()` never see partial files (`.tmp` names don't match
 * the allowed pattern in `routes/live.ts`, so they are never served). stdout is unused
 * (`ignore`); only stderr is captured for logging.
 */
function startFfmpeg(outDir: string, input: string): ChildProcess {
  const playlistPath = path.join(outDir, LIVE_PLAYLIST_FILE_NAME)
  return spawn(
    'ffmpeg',
    [
      '-loglevel',
      'warning',
      '-i',
      input,
      '-c',
      'copy',
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_list_size',
      '6',
      '-hls_flags',
      'delete_segments+append_list+temp_file',
      playlistPath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
}

/**
 * Builds the `ensureLiveRelay` result: waits for the first segment if the state is still
 * starting (`playlistPath === null`), otherwise returns immediately. On startup failure, cleans up
 * with `stopLiveRelay` and returns an error.
 */
async function awaitPlayback(
  state: LiveRelayState
): Promise<{ outDir: string; playlistFileName: string } | { error: string }> {
  if (!state.playlistPath) {
    try {
      await waitForFirstSegment(state.outDir, state.startupFailure)
    } catch (err) {
      await stopLiveRelay(state.videoId)
      return {
        error: `failed to start live relay: ${(err as Error).message}`,
      }
    }
    state.playlistPath = path.join(state.outDir, LIVE_PLAYLIST_FILE_NAME)
  }
  return { outDir: state.outDir, playlistFileName: LIVE_PLAYLIST_FILE_NAME }
}

/** Starts a new live relay (caller has verified no state exists in the Map). */
async function startLiveRelay(
  config: AppConfig,
  videoId: string
): Promise<{ outDir: string; playlistFileName: string } | { error: string }> {
  // Validate before calling yt-dlp (resolveVideoInfo): avoids a pointless call for an invalid
  // videoId and guarantees every later path construction goes through this check.
  let outDir: string
  try {
    outDir = liveRelayDirFor(config, videoId)
  } catch (err) {
    return { error: (err as Error).message }
  }

  const info = await resolveVideoInfo(videoId, {
    ytdlpPath: config.ytdlpPath,
    timeoutMs: config.ytdlpTimeoutMs,
    cacheTtlMs: config.manifestCacheTtlMs,
  })
  if (!info.hlsMasterManifestUrl) {
    return { error: 'failed to resolve HLS manifest' }
  }

  // VOD without a single audio-bearing variant (hlsIsMaster): mux per segment on demand instead
  // of keeping an ffmpeg process alive (`vod-relay.ts`).
  if (info.hlsIsMaster && !info.isLive) {
    return ensureVodRelay(config, videoId, outDir, info.hlsMasterManifestUrl)
  }

  await fs.promises.mkdir(outDir, { recursive: true })
  const ffmpegProcess = startFfmpeg(outDir, info.hlsMasterManifestUrl)

  const { promise: startupFailure, resolve: signalStartupFailure } =
    Promise.withResolvers<Error>()
  const { promise: exited, resolve: signalExited }: PromiseWithResolvers<void> =
    Promise.withResolvers()

  const now = Date.now()
  const operationId = logger.newOperationId()
  const state: LiveRelayState = {
    videoId,
    ffmpegProcess,
    outDir,
    playlistPath: null,
    startedAt: now,
    operationId,
    lastAccessedAt: now,
    startupFailure,
    exited,
  }
  relays.set(videoId, state)
  logger.info('relay.live.lifecycle.started', 'Live relay started', {
    video_id: videoId,
    operation: 'relay.live',
    operation_id: operationId,
    process_id: ffmpegProcess.pid,
  })

  const STDERR_TAIL_MAX = 4000
  let stderrTail = ''
  ffmpegProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX)
  })

  // A spawn failure (e.g. ffmpeg binary missing) is reported via 'error'. Without a listener it
  // becomes an uncaught exception that kills the process, so always register one.
  ffmpegProcess.on('error', (err) => {
    logger.error('relay.live.lifecycle.failed', 'Failed to spawn ffmpeg', {
      video_id: videoId,
      operation: 'relay.live',
      operation_id: operationId,
      error: err,
    })
    signalStartupFailure(err)
    signalExited()
    if (relays.get(videoId) === state) {
      relays.delete(videoId)
      fs.promises
        .rm(outDir, { recursive: true, force: true })
        .catch((error: unknown) => {
          logger.warn(
            'relay.live.cleanup.failed',
            'Failed to remove live relay files',
            { video_id: videoId, error }
          )
        })
    }
  })

  ffmpegProcess.on('close', (code) => {
    signalExited()
    // Clean up only if the Map still holds this handler's state. If stopLiveRelay() / eviction
    // already removed or restarted this videoId, deleting here would clobber the new state and
    // outDir (outDir is deterministic per videoId).
    // A close caused by stopLiveRelay() never reaches here (already removed from the Map), so a
    // non-zero code here is always an unexpected exit.
    if (relays.get(videoId) !== state) return
    relays.delete(videoId)
    if (code === 0) {
      logger.info('relay.live.lifecycle.stopped', 'Live relay stopped', {
        video_id: videoId,
        operation: 'relay.live',
        operation_id: operationId,
        exit_code: code,
        duration_ms: Date.now() - state.startedAt,
      })
    } else {
      logger.error(
        'relay.live.lifecycle.failed',
        'ffmpeg exited unexpectedly',
        {
          video_id: videoId,
          operation: 'relay.live',
          operation_id: operationId,
          error: {
            type: 'FfmpegExitError',
            message: `ffmpeg exited with code ${String(code)}`,
            code: code ?? 'signal',
            stderr: stderrTail,
          },
          duration_ms: Date.now() - state.startedAt,
        }
      )
      signalStartupFailure(new Error(`ffmpeg exited with code ${String(code)}`))
    }
    fs.promises
      .rm(outDir, { recursive: true, force: true })
      .catch((error: unknown) => {
        logger.warn(
          'relay.live.cleanup.failed',
          'Failed to remove live relay files',
          { video_id: videoId, error }
        )
      })
  })

  return awaitPlayback(state)
}

/**
 * Starts the live relay for videoId if not running and returns its output directory and master
 * playlist file name; returns the existing one otherwise (concurrent calls don't double-start).
 * If the relay isn't playable yet, waits for the first segment before returning.
 */
export async function ensureLiveRelay(
  config: AppConfig,
  videoId: string
): Promise<{ outDir: string; playlistFileName: string } | { error: string }> {
  await cleanupOrphanDirs(config)
  ensureSweeper(config)
  await evictIdleLiveRelays(config.liveRelayIdleTtlMs)

  const existing = relays.get(videoId)
  if (existing) {
    existing.lastAccessedAt = Date.now()
    return awaitPlayback(existing)
  }
  const vod = getVodRelay(videoId)
  if (vod) return vod

  return relayMutex.run(videoId, async () => {
    // Re-check: another caller may have finished starting while we waited for the mutex
    // (same reason as downloadAndCache() in media-cache.ts).
    const recheck = relays.get(videoId)
    if (recheck) {
      recheck.lastAccessedAt = Date.now()
      return awaitPlayback(recheck)
    }

    return startLiveRelay(config, videoId)
  })
}
