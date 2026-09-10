import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { VIDEO_ID_PATTERN } from './config'
import type { AppConfig } from './config'
import { KeyedMutex } from './lock'
import { logger } from './logger'
import { resolveVideoInfo } from './live-resolve'

/** Live 再公開の master playlist ファイル名 (`ensureLiveRelay` が返す outDir 配下に固定で置く)。 */
export const LIVE_PLAYLIST_FILE_NAME = 'live.m3u8'

/** ffmpeg `-f hls` が書き出す segment ファイル名のパターン (`live0.ts`, `live1.ts`, ...)。 */
const SEGMENT_FILE_PATTERN = /^live\d+\.ts$/

/** ffmpeg プロセスに SIGTERM を送ってから実際の終了を待つ猶予。超過時は SIGKILL へ切り替える。 */
const STOP_GRACE_MS = 5000

/**
 * `waitForFirstSegment` が最初の segment を待つ最大時間。`-hls_time 4` の数倍を確保し、
 * ffmpeg がプロセスを終了させずにハングした場合でも `ensureLiveRelay` が応答を返せるようにする。
 */
const FIRST_SEGMENT_TIMEOUT_MS = 30_000

/** videoId 単位の Live 再公開の実行状態。 */
interface LiveRelayState {
  videoId: string
  ffmpegProcess: ChildProcess
  outDir: string
  /** 最初のセグメント書き出し完了後に non-null になる (視聴可能になったことを示す)。 */
  playlistPath: string | null
  startedAt: number
  lastAccessedAt: number
  /**
   * ffmpeg が起動直後 (最初のセグメント書き出し前) に失敗したことを示す。
   * 成功した場合は誰も resolve しないまま放置される。
   */
  startupFailure: Promise<Error>
  /** ffmpeg プロセスの終了 (`close` イベント) を示す。`stopLiveRelay` が `fs.rm` の前に待ち合わせる。 */
  exited: Promise<void>
}

/** videoId 単位で同時 `ensureLiveRelay()` 呼び出しが二重に ffmpeg を起動しないようにする (media-cache.ts の downloadMutex と同じ考え方)。 */
const relayMutex = new KeyedMutex()

/** videoId ごとの実行中 Live 再公開状態。 */
const relays = new Map<string, LiveRelayState>()

/**
 * videoId の Live 再公開ファイル (playlist + segment) が置かれるディレクトリの絶対パスを返す。
 * `encodeURIComponent(videoId)` を使うのは `media-cache.ts` の `cacheFilePath()` と同じ
 * path traversal 対策 (Live 再公開ファイルの配信ルート (`routes/live.ts`) からも参照する)。
 * videoId が YouTube の形式 (`VIDEO_ID_PATTERN`) を満たさない場合はエラーを投げる。
 */
export function liveRelayDirFor(config: AppConfig, videoId: string): string {
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    throw new Error(`Invalid videoId for live relay: ${videoId}`)
  }
  return path.join(config.liveRelayOutDir, encodeURIComponent(videoId))
}

/**
 * outDir 配下に最初の segment ファイルが書き出されるまで待つ。既に存在していれば即座に解決する。
 * ffmpeg が実際にファイルを書き出すのを `fs.watch` で検知する (ポーリングより低遅延・低コスト)。
 * `failure` (ffmpeg の spawn エラー・起動中の異常終了を示す) が先に解決した場合、または
 * `FIRST_SEGMENT_TIMEOUT_MS` を超過した場合は reject する (ffmpeg がプロセスを終了させずに
 * ハングするケースにも対応するため、プロセスの終了とは独立したタイムアウトを設ける)。
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
        // failure は resolve のみで reject しない Promise だが、no-floating-promises 対策として
        // 空の catch を付与する。
      })
  })
}

/**
 * ffmpeg プロセスに SIGTERM を送った後、`state.exited` (`close` イベント) の解決を待つ。
 * `STOP_GRACE_MS` を超えても終了しない場合は SIGKILL へ切り替える (Zombie 化防止)。
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
        // exited は resolve のみで reject しない Promise だが、no-floating-promises 対策として
        // 空の catch を付与する。
      })
  })
}

/**
 * videoId の Live 再公開状態を破棄する。ffmpeg プロセスへ SIGTERM を送り、実際の終了を
 * 待ってから (旧プロセスが outDir へ書き込み中に新プロセスが同じ outDir を使い始める競合を
 * 防ぐため) 再公開ファイルを削除する
 * (URL 失効・配信終了時の後始末、eviction、テスト用の強制停止のいずれからも呼ばれる)。
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
 * lastAccessedAt が idleTtlMs を超えている videoId の Live 再公開プロセスを止める。
 * まだ最初のセグメントを書き出せていない (起動中の) relay は、起動にどれだけ時間がかかっていても
 * idle とはみなさない。lastAccessedAt は起動完了後にしか更新されないため、除外しないと起動が
 * 長引くほど誤って evict されやすくなってしまう (起動そのものの失敗は `waitForFirstSegment` の
 * タイムアウトが処理する)。
 * ponytail: 専用の setInterval は持たず `ensureLiveRelay()` 呼び出しへインライン化する
 * (新規リクエストが来ない限り古いプロセスが残り得るが、本プロジェクトに setInterval ベースの
 * バックグラウンドジョブが無く、VOD の runEviction() も downloadAndCache() 完了時にインラインで
 * 呼ばれる既存パターンに揃える。専用ジョブが必要になったら追加する)。
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

/** videoId の Live 再公開ファイルの配信ルートへアクセスがあった際に呼ぶ。 */
export function touchLiveRelay(videoId: string): void {
  const state = relays.get(videoId)
  if (state) state.lastAccessedAt = Date.now()
}

/**
 * resolveVideoInfo() で得た HLS manifest URL (AVC1 優先、無ければ master manifest URL) を
 * ffmpeg でローカルに再公開する。
 * `-c copy` により再エンコードなしでコンテナのみ HLS に変換する (Docker 実機検証済みのコマンド)。
 * `temp_file` フラグにより segment/playlist の書き込みを一時ファイル経由の rename にし、
 * `waitForFirstSegment` の `fs.watch` や `res.sendFile()` が書き込み途中のファイルを掴むのを防ぐ
 * (rename 前の `.tmp` サフィックス付きファイル名は `routes/live.ts` の許可パターンにマッチしないため、
 * 誤って配信されることもない)。stdout は使わないため `ignore` にし、stderr のみ監視してログに残す。
 */
function startFfmpeg(
  outDir: string,
  hlsMasterManifestUrl: string
): ChildProcess {
  const playlistPath = path.join(outDir, LIVE_PLAYLIST_FILE_NAME)
  return spawn(
    'ffmpeg',
    [
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
      'delete_segments+append_list+temp_file',
      playlistPath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
}

/**
 * 起動中 (`playlistPath === null`) の state であれば最初のセグメントを待ってから、
 * そうでなければ即座に、`ensureLiveRelay` の戻り値を組み立てる。起動失敗時は `stopLiveRelay`
 * で後始末してからエラーを返す。
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

/** 新規に Live 再公開を起動する (呼び出し元で Map に既存 state が無いことを確認済みの前提)。 */
async function startLiveRelay(
  config: AppConfig,
  videoId: string
): Promise<{ outDir: string; playlistFileName: string } | { error: string }> {
  // yt-dlp 呼び出し (resolveVideoInfo) の前に検証する。無効な videoId で無駄な呼び出しを
  // させないためと、以降のファイルパス構築のいずれもこの検証を経由させるため。
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

  await fs.promises.mkdir(outDir, { recursive: true })
  const ffmpegProcess = startFfmpeg(outDir, info.hlsMasterManifestUrl)

  const { promise: startupFailure, resolve: signalStartupFailure } =
    Promise.withResolvers<Error>()
  const { promise: exited, resolve: signalExited }: PromiseWithResolvers<void> =
    Promise.withResolvers()

  const now = Date.now()
  const state: LiveRelayState = {
    videoId,
    ffmpegProcess,
    outDir,
    playlistPath: null,
    startedAt: now,
    lastAccessedAt: now,
    startupFailure,
    exited,
  }
  relays.set(videoId, state)

  const STDERR_TAIL_MAX = 4000
  let stderrTail = ''
  ffmpegProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX)
    logger.warn(`live relay for video ${videoId} ffmpeg stderr: ${text.trim()}`)
  })

  // spawn 自体の失敗 (ffmpeg バイナリが無い等) は 'error' で通知される。リスナーが無いと
  // Node プロセス全体を落とす未処理例外になるため、必ず登録する。
  ffmpegProcess.on('error', (err) => {
    logger.error(
      `live relay for video ${videoId} failed to spawn ffmpeg: ${err.message}`
    )
    signalStartupFailure(err)
    signalExited()
    if (relays.get(videoId) === state) {
      relays.delete(videoId)
      fs.promises
        .rm(outDir, { recursive: true, force: true })
        .catch((error: unknown) => {
          logger.warn(
            `failed to remove live relay outDir ${outDir}: ${(error as Error).message}`
          )
        })
    }
  })

  ffmpegProcess.on('close', (code) => {
    signalExited()
    // Map の現在値がこの close ハンドラの state と一致する場合のみ後始末する。stopLiveRelay() /
    // eviction が既にこの videoId を削除・再起動済みの場合、ここで消してしまうと再起動後の
    // 新しい state・outDir を巻き込んで壊してしまう (outDir は videoId から決定的なため)。
    // stopLiveRelay() 起因の close はここに到達する前に Map から既に削除されているため、
    // このブロックに到達する non-zero code は常に stopLiveRelay() 以外が原因の異常終了である。
    if (relays.get(videoId) !== state) return
    relays.delete(videoId)
    if (code === 0) {
      logger.info(
        `live relay for video ${videoId} stopped (ffmpeg exit code ${code})`
      )
    } else {
      logger.error(
        `live relay for video ${videoId} ffmpeg exited unexpectedly with code ${code}${
          stderrTail ? `: ${stderrTail}` : ''
        }`
      )
      signalStartupFailure(new Error(`ffmpeg exited with code ${String(code)}`))
    }
    fs.promises
      .rm(outDir, { recursive: true, force: true })
      .catch((error: unknown) => {
        logger.warn(
          `failed to remove live relay outDir ${outDir}: ${(error as Error).message}`
        )
      })
  })

  return awaitPlayback(state)
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
  await evictIdleLiveRelays(config.liveRelayIdleTtlMs)

  const existing = relays.get(videoId)
  if (existing) {
    existing.lastAccessedAt = Date.now()
    return awaitPlayback(existing)
  }

  return relayMutex.run(videoId, async () => {
    // Mutex 取得待ちの間に別の呼び出しが先に起動を終えている可能性があるため再チェックする
    // (media-cache.ts の downloadAndCache() と同じ理由)。
    const recheck = relays.get(videoId)
    if (recheck) {
      recheck.lastAccessedAt = Date.now()
      return awaitPlayback(recheck)
    }

    return startLiveRelay(config, videoId)
  })
}
