import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from './config'
import { attr, fetchAvc1Master, toHttpsUrl } from './hls-filter'
import { logger } from './logger'

/** VOD relay playlist file name (served by the same route as live). */
const PLAYLIST_FILE_NAME = 'live.m3u8'

/** Time allowed to fetch and mux one segment. */
const SEGMENT_TIMEOUT_MS = 30_000

/** The parts of an HLS media playlist needed for muxing. */
interface ParsedPlaylist {
  /** `#EXT-X-MAP` init segment URL (fMP4); null for TS. */
  init: string | null
  segments: { url: string; duration: number }[]
}

/** Per-videoId VOD relay state. Segments are muxed one at a time on request. */
interface VodRelayState {
  operationId: string
  outDir: string
  video: ParsedPlaylist
  audio: ParsedPlaylist
  videoInit: Buffer | null
  audioInit: Buffer | null
  /** Start time (s) of each video segment: cumulative EXTINF of the video playlist. */
  videoStarts: number[]
  /** Start time (s) of each audio segment: cumulative EXTINF of the audio playlist, computed independently of video. */
  audioStarts: number[]
  done: Set<number>
  inflight: Map<number, Promise<string>>
  /** Total size of muxed segments (bytes). */
  bytes: number
  lastAccessedAt: number
}

const vods = new Map<string, VodRelayState>()

/** videoIds being torn down (awaiting in-flight segments / removing the directory). Re-creation waits for completion. */
const stopping = new Map<string, Promise<void>>()

/**
 * Extracts segment URLs and durations from an HLS media playlist, resolving URIs to https against `baseUrl`.
 * Byte ranges are unsupported (YouTube doesn't use them) and throw.
 */
export function parseMediaPlaylist(
  text: string,
  baseUrl: string
): ParsedPlaylist {
  const playlist: ParsedPlaylist = { init: null, segments: [] }
  let duration: number | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-BYTERANGE')) {
      throw new Error('byte range playlists are not supported')
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = attr(line, 'URI')
      if (uri === null || attr(line, 'BYTERANGE') !== null) {
        throw new Error('unsupported EXT-X-MAP')
      }
      playlist.init = toHttpsUrl(uri, baseUrl)
      if (playlist.init === null) throw new Error('invalid EXT-X-MAP URI')
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice('#EXTINF:'.length))
    } else if (line !== '' && !line.startsWith('#')) {
      const url = toHttpsUrl(line, baseUrl)
      if (duration === null || url === null || Number.isNaN(duration)) {
        throw new Error('invalid media playlist segment')
      }
      playlist.segments.push({ url, duration })
      duration = null
    }
  }
  if (playlist.segments.length === 0) throw new Error('empty media playlist')
  return playlist
}

/**
 * Builds a complete VOD playlist (with `#EXT-X-ENDLIST`) from the video segment durations.
 * Segments are muxed individually so continuity counters aren't contiguous; discontinuity is declared on all but the first.
 */
export function buildVodPlaylist(segments: { duration: number }[]): string {
  const target = Math.ceil(Math.max(...segments.map((s) => s.duration)))
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${String(target)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    ...segments.flatMap((s, i) => [
      ...(i === 0 ? [] : ['#EXT-X-DISCONTINUITY']),
      `#EXTINF:${s.duration.toFixed(3)},`,
      `seg${String(i)}.ts`,
    ]),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n')
}

/** Picks the video and audio media playlist URLs from the `fetchAvc1Master` result (one variant + audio rendition). */
function pickPlaylistUrls(master: string): { video: string; audio: string } {
  const lines = master.split('\n')
  const i = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF:'))
  const video = lines[i + 1]
  const media = lines.filter(
    (l) => l.startsWith('#EXT-X-MEDIA:') && attr(l, 'URI') !== null
  )
  const audio = (media.find((l) => attr(l, 'DEFAULT') === 'YES') ??
    media[0]) as string | undefined
  const audioUrl = audio === undefined ? null : attr(audio, 'URI')
  if (audioUrl === null || i === -1 || !video) {
    throw new Error('no separate audio rendition in the filtered master')
  }
  return { video, audio: audioUrl }
}

/** Segment start times (s) as the running sum of EXTINF. */
function segmentStarts(segments: { duration: number }[]): number[] {
  let start = 0
  return segments.map((s) => {
    const current = start
    start += s.duration
    return current
  })
}

/** Fetches a URL and returns the body. */
async function fetchBuffer(url: string, timeoutMs: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${String(res.status)} fetching ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Runs ffmpeg; resolves on success, rejects on failure or timeout. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000)
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, SEGMENT_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error('ffmpeg timed out'))
      else if (code === 0) resolve()
      else
        reject(new Error(`ffmpeg exited with code ${String(code)}: ${stderr}`))
    })
  })
}

/**
 * Fetches video and audio segment k and muxes them into one MPEG-TS with `-c copy`.
 * YouTube audio segments start at time 0, so the playlist start time is supplied instead.
 * EXTINF rounding can differ between video and audio per segment, so `-itsoffset` is set per
 * input from each stream's own cumulative start (`videoStarts`/`audioStarts`).
 * For fMP4, the init segment is prepended.
 */
async function produceSegment(
  state: VodRelayState,
  k: number,
  file: string
): Promise<void> {
  const [video, audio] = await Promise.all([
    fetchBuffer(state.video.segments[k].url, SEGMENT_TIMEOUT_MS),
    fetchBuffer(state.audio.segments[k].url, SEGMENT_TIMEOUT_MS),
  ])
  const videoSrc = path.join(state.outDir, `v${String(k)}.src`)
  const audioSrc = path.join(state.outDir, `a${String(k)}.src`)
  try {
    await Promise.all([
      fs.promises.writeFile(
        videoSrc,
        state.videoInit ? Buffer.concat([state.videoInit, video]) : video
      ),
      fs.promises.writeFile(
        audioSrc,
        state.audioInit ? Buffer.concat([state.audioInit, audio]) : audio
      ),
    ])
    await runFfmpeg([
      '-itsoffset',
      state.videoStarts[k].toFixed(3),
      '-i',
      videoSrc,
      '-itsoffset',
      state.audioStarts[k].toFixed(3),
      '-i',
      audioSrc,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      '-f',
      'mpegts',
      '-muxdelay',
      '0',
      '-muxpreload',
      '0',
      `${file}.tmp`,
    ])
    await fs.promises.rename(`${file}.tmp`, file)
    const { size } = await fs.promises.stat(file)
    state.bytes += size
  } finally {
    await Promise.all([
      fs.promises.rm(videoSrc, { force: true }),
      fs.promises.rm(audioSrc, { force: true }),
      fs.promises.rm(`${file}.tmp`, { force: true }),
    ])
  }
}

/** Returns the path of muxed segment k, creating it if needed; concurrent requests share one creation. */
function getSegment(state: VodRelayState, k: number): Promise<string> {
  const file = path.join(state.outDir, `seg${String(k)}.ts`)
  if (state.done.has(k)) return Promise.resolve(file)
  let pending = state.inflight.get(k)
  if (!pending) {
    pending = produceSegment(state, k, file)
      .then(() => {
        state.done.add(k)
        return file
      })
      .finally(() => {
        state.inflight.delete(k)
      })
    state.inflight.set(k, pending)
  }
  return pending
}

/** Tears down a videoId's VOD relay and deletes the muxed files. */
export function stopVodRelay(videoId: string): Promise<void> {
  const state = vods.get(videoId)
  if (!state) return stopping.get(videoId) ?? Promise.resolve()
  vods.delete(videoId)
  const done = (async () => {
    await Promise.allSettled(state.inflight.values())
    await fs.promises.rm(state.outDir, { recursive: true, force: true })
    logger.info('relay.vod.lifecycle.stopped', 'VOD relay stopped', {
      video_id: videoId,
      operation: 'relay.vod',
      operation_id: state.operationId,
      size_bytes: state.bytes,
    })
  })().finally(() => {
    stopping.delete(videoId)
  })
  stopping.set(videoId, done)
  return done
}

/**
 * Returns the path of VOD segment `index`, or null if there is no relay or the index is out of range.
 * Prefetches the next segment in the background to hide latency during continuous playback.
 */
export async function ensureVodSegment(
  videoId: string,
  index: number
): Promise<string | null> {
  const state = vods.get(videoId)
  if (!state || index >= state.video.segments.length) return null
  let file: string
  try {
    file = await getSegment(state, index)
  } catch (err) {
    logger.error('relay.vod.segment.failed', 'Failed to prepare VOD segment', {
      video_id: videoId,
      segment_index: index,
      operation: 'relay.vod.segment',
      operation_id: state.operationId,
      error: err instanceof Error ? err : new Error(String(err)),
    })
    // An expired source URL (403/410 etc.) won't recover on later requests; tear down so it can be re-created (URL re-resolved).
    if (
      /^HTTP 4\d\d /.test((err as Error).message) &&
      vods.get(videoId) === state
    ) {
      stopVodRelay(videoId).catch((error: unknown) => {
        logger.warn(
          'relay.vod.cleanup.failed',
          'Failed to stop VOD relay after a segment source error',
          { video_id: videoId, operation_id: state.operationId, error }
        )
      })
    }
    throw err
  }
  if (index + 1 < state.video.segments.length && vods.get(videoId) === state) {
    getSegment(state, index + 1).catch((err: unknown) => {
      logger.warn(
        'relay.vod.segment.prefetch_failed',
        'VOD relay segment prefetch failed',
        {
          video_id: videoId,
          segment_index: index + 1,
          operation_id: state.operationId,
          error: err instanceof Error ? err : new Error(String(err)),
        }
      )
    })
  }
  return file
}

/** Returns the destination of an existing VOD relay for videoId, updating its last access. */
export function getVodRelay(
  videoId: string
): { outDir: string; playlistFileName: string } | null {
  const state = vods.get(videoId)
  if (!state) return null
  state.lastAccessedAt = Date.now()
  return { outDir: state.outDir, playlistFileName: PLAYLIST_FILE_NAME }
}

/** Updates the last access time of a videoId's VOD relay. */
export function touchVodRelay(videoId: string): void {
  const state = vods.get(videoId)
  if (state) state.lastAccessedAt = Date.now()
}

/** Logs and swallows `stopVodRelay` failures so one failed removal doesn't stop the remaining teardowns. */
async function stopVodRelaySafely(videoId: string): Promise<void> {
  try {
    await stopVodRelay(videoId)
  } catch (err) {
    logger.warn('relay.vod.cleanup.failed', 'Failed to stop VOD relay', {
      video_id: videoId,
      error: err,
    })
  }
}

/**
 * Tears down VOD relays past the idle TTL, then, if the total size still exceeds
 * `liveRelayMaxBytes`, tears down the least recently accessed ones first.
 */
export async function evictVodRelays(config: AppConfig): Promise<void> {
  const now = Date.now()
  for (const [videoId, state] of vods) {
    if (now - state.lastAccessedAt >= config.liveRelayIdleTtlMs) {
      await stopVodRelaySafely(videoId)
    }
  }
  let total = 0
  for (const state of vods.values()) total += state.bytes
  const oldestFirst = [...vods].toSorted(
    ([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt
  )
  for (const [videoId, state] of oldestFirst) {
    if (total <= config.liveRelayMaxBytes) break
    total -= state.bytes
    logger.warn(
      'relay.vod.cache.evicted',
      'VOD relay exceeded its size limit',
      {
        video_id: videoId,
        reason: 'cache_size_exceeded',
        size_bytes: state.bytes,
        max_bytes: config.liveRelayMaxBytes,
        operation_id: state.operationId,
      }
    )
    await stopVodRelaySafely(videoId)
  }
}

/**
 * For a VOD whose audio is a separate rendition, builds a complete VOD playlist (with
 * `#EXT-X-ENDLIST`, durations from the original video segments' EXTINF). Segments are only made
 * on request, so initial latency is just fetching the playlists, and the player treats it as VOD
 * from the start and can seek. No ffmpeg process is kept running.
 */
export async function ensureVodRelay(
  config: AppConfig,
  videoId: string,
  outDir: string,
  masterUrl: string
): Promise<{ outDir: string; playlistFileName: string } | { error: string }> {
  const operationId = logger.newOperationId()
  const startedAt = performance.now()
  await stopping.get(videoId)
  const existing = getVodRelay(videoId)
  if (existing) return existing

  let state: VodRelayState
  try {
    const master = await fetchAvc1Master(masterUrl, config.ytdlpTimeoutMs)
    if (master === null) {
      return { error: `no AVC1 HLS variant found for video ${videoId}` }
    }
    const urls = pickPlaylistUrls(master)
    const [videoText, audioText] = await Promise.all([
      fetchBuffer(urls.video, config.ytdlpTimeoutMs),
      fetchBuffer(urls.audio, config.ytdlpTimeoutMs),
    ])
    const video = parseMediaPlaylist(videoText.toString('utf8'), urls.video)
    const audio = parseMediaPlaylist(audioText.toString('utf8'), urls.audio)
    if (video.segments.length !== audio.segments.length) {
      throw new Error('video and audio segment counts differ')
    }
    const [videoInit, audioInit] = await Promise.all([
      video.init === null
        ? null
        : fetchBuffer(video.init, config.ytdlpTimeoutMs),
      audio.init === null
        ? null
        : fetchBuffer(audio.init, config.ytdlpTimeoutMs),
    ])
    state = {
      operationId,
      outDir,
      video,
      audio,
      videoInit,
      audioInit,
      videoStarts: segmentStarts(video.segments),
      audioStarts: segmentStarts(audio.segments),
      done: new Set(),
      inflight: new Map(),
      bytes: 0,
      lastAccessedAt: Date.now(),
    }
  } catch (err) {
    logger.error(
      'relay.vod.preparation.failed',
      'Failed to prepare VOD relay',
      {
        video_id: videoId,
        operation: 'relay.vod.preparation',
        operation_id: operationId,
        duration_ms: Math.round(performance.now() - startedAt),
        error: err instanceof Error ? err : new Error(String(err)),
      }
    )
    return { error: 'failed to prepare VOD relay' }
  }

  await evictVodRelays(config)
  await fs.promises.mkdir(outDir, { recursive: true })
  await fs.promises.writeFile(
    path.join(outDir, PLAYLIST_FILE_NAME),
    buildVodPlaylist(state.video.segments)
  )
  vods.set(videoId, state)
  logger.info('relay.vod.preparation.completed', 'VOD relay prepared', {
    video_id: videoId,
    operation: 'relay.vod.preparation',
    operation_id: operationId,
    segment_count: state.video.segments.length,
    duration_ms: Math.round(performance.now() - startedAt),
  })
  return { outDir, playlistFileName: PLAYLIST_FILE_NAME }
}
