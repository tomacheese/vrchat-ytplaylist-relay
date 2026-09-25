import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from './config'
import { attr, fetchAvc1Master, toHttpsUrl } from './hls-filter'
import { logger } from './logger'

/** VOD の再公開 playlist のファイル名 (Live と同じ配信ルートで配る)。 */
const PLAYLIST_FILE_NAME = 'live.m3u8'

/** segment 1 個の取得・多重化に許す時間。 */
const SEGMENT_TIMEOUT_MS = 30_000

/** HLS メディア playlist の、多重化に必要な部分。 */
interface ParsedPlaylist {
  /** `#EXT-X-MAP` の初期化セグメント URL (fMP4 の場合)。TS なら null。 */
  init: string | null
  segments: { url: string; duration: number }[]
}

/** videoId 単位の VOD 再公開状態。segment は要求されたときに 1 個ずつ多重化する。 */
interface VodRelayState {
  operationId: string
  outDir: string
  video: ParsedPlaylist
  audio: ParsedPlaylist
  videoInit: Buffer | null
  audioInit: Buffer | null
  /** 映像側の各 segment の開始時刻 (秒。映像 playlist 上の EXTINF の累計)。 */
  videoStarts: number[]
  /** 音声側の各 segment の開始時刻 (秒。音声 playlist 上の EXTINF の累計)。映像とは独立して計算する。 */
  audioStarts: number[]
  done: Set<number>
  inflight: Map<number, Promise<string>>
  /** 多重化済み segment の合計サイズ (bytes)。 */
  bytes: number
  lastAccessedAt: number
}

const vods = new Map<string, VodRelayState>()

/** 破棄中 (作成中の segment の完了待ち・ディレクトリ削除中) の videoId。再作成は完了まで待たせる。 */
const stopping = new Map<string, Promise<void>>()

/**
 * HLS メディア playlist から segment の URL と長さを取り出す。URI は `baseUrl` を基準に https へ解決する。
 * byte range は YouTube では使われないため未対応として例外にする。
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
 * 映像 segment の長さから、`#EXT-X-ENDLIST` 付きの完全な VOD playlist を組み立てる。
 * segment は個別に多重化され continuity counter が連続しないため、先頭以外に discontinuity を宣言する。
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

/** `fetchAvc1Master` の結果 (variant 1 本 + 音声 rendition) から映像・音声のメディア playlist URL を選ぶ。 */
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

/** 各 segment の開始時刻 (秒) を、EXTINF の累計として 1 回の走査で求める。 */
function segmentStarts(segments: { duration: number }[]): number[] {
  let start = 0
  return segments.map((s) => {
    const current = start
    start += s.duration
    return current
  })
}

/** URL を取得して本文を返す。 */
async function fetchBuffer(url: string, timeoutMs: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${String(res.status)} fetching ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/** ffmpeg を実行し、正常終了で resolve、異常終了・タイムアウトで reject する。 */
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
 * 映像・音声の segment k を取得し、`-c copy` で MPEG-TS 1 個に多重化する。
 * YouTube の音声 segment は時刻が 0 から始まるため、元の時刻は使わず playlist 上の開始時刻を与える。
 * 映像と音声で EXTINF の丸めが segment ごとに一致しないことがあるため、`-itsoffset` を入力ごとに
 * 指定し、各ストリーム自身の累計 (`videoStarts`/`audioStarts`) で独立に offset する。
 * fMP4 は初期化セグメントを先頭に付ける。
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

/** segment k の多重化済みファイルのパスを返す。未作成なら作成し、同時要求は 1 回の作成に合流させる。 */
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

/** videoId の VOD 再公開を破棄し、多重化済みファイルを削除する。 */
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
 * VOD の segment `index` の多重化済みファイルのパスを返す。再公開が無い、または範囲外なら null。
 * 連続再生の待ち時間を隠すため、次の segment を裏で先に作る。
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
    // 取得元 URL の失効 (403/410 等) は以降の要求でも直らないため、再作成 (URL の再解決) できるよう破棄する。
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

/** videoId の VOD 再公開が既にあれば、最終アクセスを更新して配信先を返す。 */
export function getVodRelay(
  videoId: string
): { outDir: string; playlistFileName: string } | null {
  const state = vods.get(videoId)
  if (!state) return null
  state.lastAccessedAt = Date.now()
  return { outDir: state.outDir, playlistFileName: PLAYLIST_FILE_NAME }
}

/** videoId の VOD 再公開の最終アクセスを更新する。 */
export function touchVodRelay(videoId: string): void {
  const state = vods.get(videoId)
  if (state) state.lastAccessedAt = Date.now()
}

/** `stopVodRelay` の失敗をログに残して握りつぶす。1 件の削除失敗で残りの破棄を止めないため。 */
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
 * idle TTL を超えた VOD 再公開を破棄し、なお合計サイズが `liveRelayMaxBytes` を超えていれば
 * 最終アクセスが古いものから破棄する。
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
 * 音声が別 rendition の VOD について、完全な VOD playlist (`#EXT-X-ENDLIST` 付き、長さは元の映像 segment の
 * EXTINF) を作って返す。segment は要求されるまで作らないため、初回の待ち時間は playlist の取得だけで済み、
 * プレイヤーは最初から VOD として扱えて Seek できる。ffmpeg プロセスは常駐させない。
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
