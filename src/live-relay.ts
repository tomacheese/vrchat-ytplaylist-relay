import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from './config'
import { KeyedMutex } from './lock'
import { logger } from './logger'
import { resolveVideoInfo } from './live-resolve'

/** Live 再公開の master playlist ファイル名 (`ensureLiveRelay` が返す outDir 配下に固定で置く)。 */
export const LIVE_PLAYLIST_FILE_NAME = 'live.m3u8'

/** ffmpeg `-f hls` が書き出す segment ファイル名のパターン (`live0.ts`, `live1.ts`, ...)。 */
const SEGMENT_FILE_PATTERN = /^live\d+\.ts$/

interface LiveRelayState {
  videoId: string
  ffmpegProcess: ChildProcess
  outDir: string
  /** 最初のセグメント書き出し完了後に non-null になる (視聴可能になったことを示す)。 */
  playlistPath: string | null
  startedAt: number
  lastAccessedAt: number
}

/** videoId 単位で同時 `ensureLiveRelay()` 呼び出しが二重に ffmpeg を起動しないようにする (media-cache.ts の downloadMutex と同じ考え方)。 */
const relayMutex = new KeyedMutex()

/** videoId ごとの実行中 Live 再公開状態。 */
const relays = new Map<string, LiveRelayState>()

/**
 * videoId の Live 再公開ファイル (playlist + segment) が置かれるディレクトリの絶対パスを返す。
 * `encodeURIComponent(videoId)` を使うのは `media-cache.ts` の `cacheFilePath()` と同じ
 * path traversal 対策 (Live 再公開ファイルの配信ルート (`routes/live.ts`) からも参照する)。
 */
export function liveRelayDirFor(config: AppConfig, videoId: string): string {
  return path.join(config.liveRelayOutDir, encodeURIComponent(videoId))
}

/**
 * outDir 配下に最初の segment ファイルが書き出されるまで待つ。既に存在していれば即座に解決する。
 * ffmpeg が実際にファイルを書き出すのを `fs.watch` で検知する (ポーリングより低遅延・低コスト)。
 */
function waitForFirstSegment(outDir: string): Promise<void> {
  return new Promise((resolve) => {
    const existing = fs.existsSync(outDir) ? fs.readdirSync(outDir) : []
    if (existing.some((name) => SEGMENT_FILE_PATTERN.test(name))) {
      resolve()
      return
    }
    const watcher = fs.watch(outDir, (_eventType, filename) => {
      if (filename && SEGMENT_FILE_PATTERN.test(filename)) {
        watcher.close()
        resolve()
      }
    })
  })
}

/**
 * videoId の Live 再公開状態を破棄する。ffmpeg プロセスを終了させ、再公開ファイルを削除する
 * (URL 失効・配信終了時の後始末、eviction、テスト用の強制停止のいずれからも呼ばれる)。
 */
export function stopLiveRelay(videoId: string): void {
  const state = relays.get(videoId)
  if (!state) return
  relays.delete(videoId)
  state.ffmpegProcess.kill('SIGTERM')
  fs.rmSync(state.outDir, { recursive: true, force: true })
}

/**
 * lastAccessedAt が idleTtlMs を超えている videoId の Live 再公開プロセスを止める。
 * ponytail: 専用の setInterval は持たず `ensureLiveRelay()` 呼び出しへインライン化する
 * (新規リクエストが来ない限り古いプロセスが残り得るが、本プロジェクトに setInterval ベースの
 * バックグラウンドジョブが無く、VOD の runEviction() も downloadAndCache() 完了時にインラインで
 * 呼ばれる既存パターンに揃える。専用ジョブが必要になったら追加する)。
 */
function evictIdleLiveRelays(idleTtlMs: number): void {
  const now = Date.now()
  for (const [videoId, state] of relays) {
    if (now - state.lastAccessedAt >= idleTtlMs) {
      stopLiveRelay(videoId)
    }
  }
}

/** videoId の Live 再公開ファイルの配信ルートへアクセスがあった際に呼ぶ (Task 4)。 */
export function touchLiveRelay(videoId: string): void {
  const state = relays.get(videoId)
  if (state) state.lastAccessedAt = Date.now()
}

/**
 * resolveVideoInfo() で得た HLS master manifest URL を ffmpeg でローカルに再公開する。
 * `-c copy` により再エンコードなしでコンテナのみ HLS に変換する (Docker 実機検証済みのコマンド)。
 */
function startFfmpeg(
  outDir: string,
  hlsMasterManifestUrl: string
): ChildProcess {
  const playlistPath = path.join(outDir, LIVE_PLAYLIST_FILE_NAME)
  return spawn('ffmpeg', [
    '-loglevel',
    'warning',
    '-i',
    hlsMasterManifestUrl,
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_list_size',
    '6',
    '-hls_flags',
    'delete_segments+append_list',
    playlistPath,
  ])
}

/** 新規に Live 再公開を起動する (呼び出し元で Map に既存 state が無いことを確認済みの前提)。 */
async function startLiveRelay(
  config: AppConfig,
  videoId: string
): Promise<LiveRelayState | { error: string }> {
  const info = await resolveVideoInfo(videoId, {
    ytdlpPath: config.ytdlpPath,
    timeoutMs: config.ytdlpTimeoutMs,
    cacheTtlMs: config.manifestCacheTtlMs,
  })
  if (!info.hlsMasterManifestUrl) {
    return { error: 'failed to resolve HLS manifest' }
  }

  const outDir = liveRelayDirFor(config, videoId)
  fs.mkdirSync(outDir, { recursive: true })
  const ffmpegProcess = startFfmpeg(outDir, info.hlsMasterManifestUrl)

  const now = Date.now()
  const state: LiveRelayState = {
    videoId,
    ffmpegProcess,
    outDir,
    playlistPath: null,
    startedAt: now,
    lastAccessedAt: now,
  }
  relays.set(videoId, state)

  ffmpegProcess.on('close', (code) => {
    // Map の現在値がこの close ハンドラの state と一致する場合のみ後始末する。stopLiveRelay() /
    // eviction が既に別の理由でこの videoId を削除・再起動済みの場合、ここで消してしまうと
    // 再起動後の新しい state・outDir を巻き込んで壊してしまう (outDir は videoId から決定的なため)。
    if (relays.get(videoId) !== state) return
    relays.delete(videoId)
    fs.rmSync(outDir, { recursive: true, force: true })
    logger.info(
      `live relay for video ${videoId} stopped (ffmpeg exit code ${code})`
    )
  })

  await waitForFirstSegment(outDir)
  state.playlistPath = path.join(outDir, LIVE_PLAYLIST_FILE_NAME)
  return state
}

/**
 * videoId の Live 再公開が実行中でなければ起動し、再公開先ディレクトリと master playlist の
 * ファイル名を返す。実行中ならそのまま返す (同一 videoId への同時アクセスで二重起動しない)。
 * まだ再公開が始まっていない場合は、最初のセグメントが書き出されるまで待ってから返す。
 */
export async function ensureLiveRelay(
  config: AppConfig,
  videoId: string
): Promise<{ outDir: string; playlistFileName: string } | { error: string }> {
  evictIdleLiveRelays(config.liveRelayIdleTtlMs)

  const existing = relays.get(videoId)
  if (existing) {
    existing.lastAccessedAt = Date.now()
    if (!existing.playlistPath) {
      await waitForFirstSegment(existing.outDir)
    }
    return {
      outDir: existing.outDir,
      playlistFileName: LIVE_PLAYLIST_FILE_NAME,
    }
  }

  return relayMutex.run(videoId, async () => {
    // Mutex 取得待ちの間に別の呼び出しが先に起動を終えている可能性があるため再チェックする
    // (media-cache.ts の downloadAndCache() と同じ理由)。
    const recheck = relays.get(videoId)
    if (recheck) {
      recheck.lastAccessedAt = Date.now()
      if (!recheck.playlistPath) {
        await waitForFirstSegment(recheck.outDir)
      }
      return {
        outDir: recheck.outDir,
        playlistFileName: LIVE_PLAYLIST_FILE_NAME,
      }
    }

    const result = await startLiveRelay(config, videoId)
    if ('error' in result) return result
    return { outDir: result.outDir, playlistFileName: LIVE_PLAYLIST_FILE_NAME }
  })
}
