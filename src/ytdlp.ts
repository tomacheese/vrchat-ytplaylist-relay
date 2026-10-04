import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from './logger'
import type { YtdlpFlatEntry } from './types'

/** yt-dlp の起動・実行・出力解析のいずれかが失敗した際に投げる。`stderr` に yt-dlp の生出力を保持する。 */
export class YtdlpError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly code?: string | number
  ) {
    super(message)
    this.name = 'YtdlpError'
  }
}

/** {@link fetchPlaylistEntries} / {@link downloadVideo} / {@link resolveVideoJson} の実行オプション。 */
export interface RunYtdlpOptions {
  ytdlpPath: string
  timeoutMs: number
}

interface SpawnResult {
  stdout: string
  stderr: string
}

interface OutputLimit {
  directory: string
  maxBytes: number
}

function directorySize(directory: string): number {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .reduce((size, entry) => {
      if (!entry.isFile()) return size
      try {
        return size + fs.statSync(path.join(directory, entry.name)).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return size
        throw error
      }
    }, 0)
}

/** yt-dlp が起動した ffmpeg / JS runtime も同時に終了させる。 */
function killProcessTree(
  child: ChildProcess,
  complete: (error?: Error) => void
): void {
  if (child.pid === undefined) {
    complete()
    return
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    })
    let completed = false
    const timer = setTimeout(() => {
      if (completed) return
      completed = true
      killer.kill('SIGKILL')
      complete(new Error('Timed out terminating yt-dlp process tree'))
    }, 5000)
    const finish = (error?: Error): void => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      complete(error)
    }
    killer.once('error', finish)
    killer.once('close', (code) => {
      if (code === 0) finish()
      else finish(new Error('Failed to terminate yt-dlp process tree'))
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
    complete()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') complete()
    else complete(error instanceof Error ? error : new Error(String(error)))
  }
}

const activeChildren = new Set<ChildProcess>()
const terminationSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
let terminationSignal: NodeJS.Signals | null = null
let pendingTerminations = 0

function terminateProcessTree(
  child: ChildProcess,
  details: Record<string, unknown>
): void {
  pendingTerminations += 1
  killProcessTree(child, (error) => {
    if (error) {
      logger.error(
        'ytdlp.operation.failed',
        'Failed to terminate yt-dlp process tree',
        { operation: 'ytdlp.run', ...details, error }
      )
      child.kill('SIGKILL')
    }
    pendingTerminations -= 1
  })
}

function handleTermination(signal: NodeJS.Signals): void {
  terminationSignal ??= signal
  for (const child of activeChildren) {
    terminateProcessTree(child, {})
  }
}

function finishTermination(): void {
  if (terminationSignal === null || activeChildren.size > 0) return
  if (pendingTerminations > 0) {
    setTimeout(finishTermination, 10)
    return
  }
  const signal = terminationSignal
  for (const terminationSignalName of terminationSignals) {
    process.removeListener(terminationSignalName, handleTermination)
  }
  setImmediate(() => {
    terminationSignal = null
    process.kill(process.pid, signal)
  })
}

function trackChild(child: ChildProcess): void {
  if (activeChildren.size === 0) {
    for (const signal of terminationSignals) {
      process.on(signal, handleTermination)
    }
  }
  activeChildren.add(child)
  child.once('close', () => {
    activeChildren.delete(child)
    if (activeChildren.size === 0) {
      if (terminationSignal === null) {
        for (const signal of terminationSignals) {
          process.removeListener(signal, handleTermination)
        }
      } else {
        finishTermination()
      }
    }
  })
}

/**
 * yt-dlp を子プロセスとして起動し、Timeout 付きで標準出力・標準エラー出力を回収する共通処理。
 * `contextLabel` はエラーメッセージに埋め込む対象の説明 (例: "playlist xxx", "video yyy")。
 */
function runYtdlp(
  args: string[],
  options: RunYtdlpOptions,
  contextLabel: string,
  outputLimit?: OutputLimit
): Promise<SpawnResult> {
  const startedAt = performance.now()
  const operationId = logger.newOperationId()
  const [targetType, targetId] = contextLabel.split(' ', 2)
  return new Promise((resolve, reject) => {
    if (terminationSignal !== null) {
      reject(
        new YtdlpError(
          `Cannot start yt-dlp during ${terminationSignal}`,
          '',
          'ESHUTDOWN'
        )
      )
      return
    }
    const child = spawn(options.ytdlpPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    trackChild(child)

    let stdout = ''
    let stderr = ''
    let settled = false
    let operationError: YtdlpError | undefined

    const timer = setTimeout(() => {
      if (settled) return
      operationError = new YtdlpError(
        `yt-dlp timed out after ${options.timeoutMs}ms for ${contextLabel}`,
        stderr,
        'ETIMEDOUT'
      )
      terminateProcessTree(child, {
        operation_id: operationId,
        target_type: targetType,
        target_id: targetId,
      })
    }, options.timeoutMs)

    const sizeMonitor = outputLimit
      ? setInterval(() => {
          if (settled || operationError) return
          let size: number
          try {
            size = directorySize(outputLimit.directory)
          } catch (error) {
            operationError = new YtdlpError(
              'Failed to inspect yt-dlp temporary output',
              stderr,
              'EIO'
            )
            operationError.cause = error
            terminateProcessTree(child, {
              operation_id: operationId,
              target_type: targetType,
              target_id: targetId,
            })
            return
          }
          if (size <= outputLimit.maxBytes) return
          operationError = new YtdlpError(
            `Video exceeds the cache size limit (${outputLimit.maxBytes} bytes)`,
            stderr,
            'EFBIG'
          )
          terminateProcessTree(child, {
            operation_id: operationId,
            target_type: targetType,
            target_id: targetId,
          })
        }, 25)
      : undefined

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (sizeMonitor) clearInterval(sizeMonitor)
      const errorCode = (err as NodeJS.ErrnoException).code
      const error = new YtdlpError(
        `Failed to spawn yt-dlp (${options.ytdlpPath}): ${err.message}`,
        stderr,
        typeof errorCode === 'string' ? errorCode : undefined
      )
      logger.error('ytdlp.operation.failed', 'yt-dlp operation failed', {
        operation: 'ytdlp.run',
        operation_id: operationId,
        target_type: targetType,
        target_id: targetId,
        duration_ms: Math.round(performance.now() - startedAt),
        error,
      })
      reject(error)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (sizeMonitor) clearInterval(sizeMonitor)

      if (operationError) {
        logger.error('ytdlp.operation.failed', 'yt-dlp operation failed', {
          operation: 'ytdlp.run',
          operation_id: operationId,
          target_type: targetType,
          target_id: targetId,
          duration_ms: Math.round(performance.now() - startedAt),
          error: operationError,
        })
        reject(operationError)
        return
      }

      if (code !== 0) {
        const error = new YtdlpError(
          `yt-dlp exited with code ${code} for ${contextLabel}`,
          stderr,
          code ?? 'unknown'
        )
        logger.error('ytdlp.operation.failed', 'yt-dlp operation failed', {
          operation: 'ytdlp.run',
          operation_id: operationId,
          target_type: targetType,
          target_id: targetId,
          duration_ms: Math.round(performance.now() - startedAt),
          error,
        })
        reject(error)
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

/**
 * yt-dlp --flat-playlist -J で YouTube Playlist の順序・Video ID・Title を取得する。
 * `--flat-playlist` を使うことで各動画を個別に解析せず、Playlist ページの一覧だけを高速取得する。
 */
export async function fetchPlaylistEntries(
  playlistId: string,
  options: RunYtdlpOptions
): Promise<YtdlpFlatEntry[]> {
  const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`
  const args = [
    '--flat-playlist',
    '--dump-single-json',
    '--js-runtimes',
    'deno',
    '--ignore-no-formats-error',
    url,
  ]

  const { stdout, stderr } = await runYtdlp(
    args,
    options,
    `playlist ${playlistId}`
  )

  try {
    const parsed = JSON.parse(stdout) as { entries?: unknown[] }
    const entries = Array.isArray(parsed.entries) ? parsed.entries : []
    const result: YtdlpFlatEntry[] = []
    for (const raw of entries) {
      const entry = raw as { id?: unknown; title?: unknown; duration?: unknown }
      if (typeof entry.id !== 'string' || entry.id.length === 0) continue
      result.push({
        id: entry.id,
        title: typeof entry.title === 'string' ? entry.title : null,
        duration: typeof entry.duration === 'number' ? entry.duration : null,
      })
    }
    return result
  } catch (err) {
    throw new YtdlpError(
      `Failed to parse yt-dlp JSON output for playlist ${playlistId}: ${(err as Error).message}`,
      stderr
    )
  }
}

/**
 * videoId を yt-dlp (`-j`, `--no-playlist`) で解決し、パース済みの JSON (yt-dlp の InfoExtractor 出力) を返す。
 * `is_live` / `formats[]` の解釈は呼び出し元 (`live-resolve.ts`) の責務とし、ここでは yt-dlp
 * の実行と JSON パースのみを行う (`fetchPlaylistEntries` と同じ関心分離)。
 */
export async function resolveVideoJson(
  videoId: string,
  options: RunYtdlpOptions
): Promise<unknown> {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  const args = ['-j', '--no-playlist', '--js-runtimes', 'deno', url]

  const { stdout, stderr } = await runYtdlp(args, options, `video ${videoId}`)

  try {
    return JSON.parse(stdout) as unknown
  } catch (err) {
    throw new YtdlpError(
      `Failed to parse yt-dlp JSON output for video ${videoId}: ${(err as Error).message}`,
      stderr
    )
  }
}

/** {@link downloadVideo} の実行オプション。 */
export interface DownloadVideoOptions extends RunYtdlpOptions {
  /** ダウンロードする動画の最大高さ (px)。これ以下で最高画質のフォーマットを選ぶ。 */
  maxHeight: number
  /** 上限超過時は既存の配信用ファイルを置換せずに失敗させる。 */
  maxBytes?: number
}

/**
 * 指定した videoId の動画を yt-dlp でダウンロードし、`destPath` に mp4 として配置する ("proxy" 配信モード用)。
 *
 * - フォーマットは `maxHeight` 以下で最高画質のものを選ぶ。YouTube は progressive (映像+音声結合) の
 *   mp4 を提供しなくなっているため、映像 (DASH) + 音声 (DASH) を分けて取得し ffmpeg で結合する
 *   (`--merge-output-format mp4`)。単一フォーマットしか無い fallback 時のため `--remux-video mp4` も
 *   併用し、コンテナを再エンコードなしで mp4 に揃える (AVProVideoPlayer が mp4 以外を安定して再生できる保証がないため)。
 * - Download は `destPath` と同じディレクトリ配下の一時ディレクトリに行い、完了後に `fs.renameSync`
 *   で `destPath` へ atomic に配置する (読み手が書きかけのファイルを見ることを防ぐ)。
 */
export async function downloadVideo(
  videoId: string,
  destPath: string,
  options: DownloadVideoOptions
): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  const tmpDir = `${destPath}.download-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.mkdirSync(tmpDir, { recursive: true })

  try {
    const outputTemplate = path.join(tmpDir, 'video.%(ext)s')
    const args = [
      '-f',
      `bestvideo[height<=${options.maxHeight}]+bestaudio/best[height<=${options.maxHeight}]`,
      '--merge-output-format',
      'mp4',
      '--remux-video',
      'mp4',
      '--no-playlist',
      '--js-runtimes',
      'deno',
      '--no-part',
      '-o',
      outputTemplate,
      url,
    ]

    if (options.maxBytes !== undefined) {
      args.unshift('--max-filesize', String(options.maxBytes))
    }

    await runYtdlp(
      args,
      options,
      `video ${videoId}`,
      options.maxBytes === undefined
        ? undefined
        : { directory: tmpDir, maxBytes: options.maxBytes }
    )

    const producedPath = path.join(tmpDir, 'video.mp4')
    if (!fs.existsSync(producedPath)) {
      throw new YtdlpError(
        `yt-dlp did not produce an mp4 file for video ${videoId}`,
        ''
      )
    }

    if (
      options.maxBytes !== undefined &&
      fs.statSync(producedPath).size > options.maxBytes
    ) {
      throw new YtdlpError(
        `Video exceeds the cache size limit (${options.maxBytes} bytes)`,
        '',
        'EFBIG'
      )
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.renameSync(producedPath, destPath)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
