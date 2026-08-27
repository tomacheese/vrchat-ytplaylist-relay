import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { YtdlpFlatEntry } from './types'

/** yt-dlp の起動・実行・出力解析のいずれかが失敗した際に投げる。`stderr` に yt-dlp の生出力を保持する。 */
export class YtdlpError extends Error {
  constructor(
    message: string,
    public readonly stderr: string
  ) {
    super(message)
    this.name = 'YtdlpError'
  }
}

/** {@link fetchPlaylistEntries} / {@link downloadVideo} の実行オプション。 */
interface RunYtdlpOptions {
  ytdlpPath: string
  timeoutMs: number
}

interface SpawnResult {
  stdout: string
  stderr: string
}

/**
 * yt-dlp を子プロセスとして起動し、Timeout 付きで標準出力・標準エラー出力を回収する共通処理。
 * `contextLabel` はエラーメッセージに埋め込む対象の説明 (例: "playlist xxx", "video yyy")。
 */
function runYtdlp(
  args: string[],
  options: RunYtdlpOptions,
  contextLabel: string
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.ytdlpPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(
        new YtdlpError(
          `yt-dlp timed out after ${options.timeoutMs}ms for ${contextLabel}`,
          stderr
        )
      )
    }, options.timeoutMs)

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
      reject(
        new YtdlpError(
          `Failed to spawn yt-dlp (${options.ytdlpPath}): ${err.message}`,
          stderr
        )
      )
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (code !== 0) {
        reject(
          new YtdlpError(
            `yt-dlp exited with code ${code} for ${contextLabel}`,
            stderr
          )
        )
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

/** {@link downloadVideo} の実行オプション。 */
export interface DownloadVideoOptions extends RunYtdlpOptions {
  /** ダウンロードする動画の最大高さ (px)。これ以下で最高画質のフォーマットを選ぶ。 */
  maxHeight: number
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

    await runYtdlp(args, options, `video ${videoId}`)

    const producedPath = path.join(tmpDir, 'video.mp4')
    if (!fs.existsSync(producedPath)) {
      throw new YtdlpError(
        `yt-dlp did not produce an mp4 file for video ${videoId}`,
        ''
      )
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.renameSync(producedPath, destPath)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
