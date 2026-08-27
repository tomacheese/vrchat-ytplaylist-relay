import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import { logger } from './logger'
import type { PlaylistConfigEntry, ServerConfig } from './types'

export interface AppConfig {
  port: number
  configPath: string
  dataDir: string
  adminToken: string | null
  ytdlpPath: string
  defaultMaxSlots: number
  ytdlpTimeoutMs: number
  /** Client からの GET /:playlistId/manifest.json をこの期間 (ms) はメモリキャッシュで応答し、yt-dlp を再実行しない。 */
  manifestCacheTtlMs: number
  /**
   * Media Endpoint (`GET /:playlistId/:position.mp4`) の配信方式。
   * - "redirect": 従来通り youtube.com へ 302 Redirect するだけ (既定値)。
   * - "proxy": Backend 自身が yt-dlp で動画をダウンロード・キャッシュし、バイト列を直接配信する。
   *   VRChat 同梱の制限付き yt-dlp が googlevideo.com への直リンク解決に失敗する問題を回避できるが、
   *   ffmpeg / 十分なディスク容量が必要になる。ダウンロード完了まで応答をブロックするため、
   *   Client 側の Timeout に間に合わないことがある。
   * - "hybrid": キャッシュ済みなら "proxy" と同様にバイト列を直接配信し、未キャッシュ (または TTL 切れ)
   *   なら応答をブロックせずダウンロードを裏で開始しつつ即座に "redirect" と同様の 302 応答を返す。
   *   Client が Timeout 後に再リクエストしてきた頃にはダウンロードが完了している想定で、
   *   "redirect" の即応性と "proxy" の 403 回避を両立させる。
   */
  deliveryMode: 'redirect' | 'proxy' | 'hybrid'
  /** "proxy" モードでダウンロードする動画の最大高さ (px)。YouTube 側のフォーマットから、これ以下で最高画質のものを選ぶ。 */
  mediaMaxHeight: number
  /** "proxy" モードでダウンロード済み動画ファイル・メタデータを保存するディレクトリ。 */
  mediaCacheDir: string
  /** "proxy" モードのキャッシュ総容量上限 (bytes)。超過分は最終アクセスが古いものから LRU で削除する。 */
  mediaCacheMaxBytes: number
  /** "proxy" モードでダウンロード済みファイルを新鮮とみなす期間 (ms)。経過後は次回アクセス時に再ダウンロードする。 */
  mediaCacheTtlMs: number
  /** "proxy" モードでの yt-dlp 動画ダウンロード 1 本あたりのタイムアウト (ms)。Playlist 一覧取得より時間がかかるため別枠で持つ。 */
  mediaDownloadTimeoutMs: number
  playlists: PlaylistConfigEntry[]
}

/**
 * `config/playlists.json` を読み込む。ファイルが存在しない場合は allowlist 無効
 * (`playlists: []`) として扱う (事前登録なしで任意の playlistId を要求可能にするため)。
 * ファイルが存在するのに JSON 破損など他の理由で読み込めない場合は従来通りエラーにする。
 */
function readServerConfig(configPath: string): ServerConfig {
  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      logger.warn(
        `No config file found at ${configPath}; allowlist is disabled (any playlistId is accepted)`
      )
      return { playlists: [] }
    }
    throw err
  }
  const parsed = JSON.parse(raw) as ServerConfig
  if (!Array.isArray(parsed.playlists)) {
    throw new TypeError(
      `Config at ${configPath} must contain a "playlists" array`
    )
  }
  for (const entry of parsed.playlists) {
    if (!entry.playlistId || typeof entry.playlistId !== 'string') {
      throw new Error(
        `Config at ${configPath} contains a playlist entry without a valid "playlistId"`
      )
    }
  }
  if (parsed.playlists.length === 0) {
    logger.warn(
      `Config at ${configPath} has an empty "playlists" array; allowlist is disabled (any playlistId is accepted)`
    )
  }
  return parsed
}

function readDeliveryMode(
  overrides: Partial<AppConfig>
): 'redirect' | 'proxy' | 'hybrid' {
  const raw =
    overrides.deliveryMode ??
    // 空文字列 ("MEDIA_DELIVERY_MODE=" のような未設定相当の指定) も既定値扱いにするため || を使う。
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    (process.env.MEDIA_DELIVERY_MODE?.trim() || 'redirect')
  if (raw !== 'redirect' && raw !== 'proxy' && raw !== 'hybrid') {
    throw new Error(
      `MEDIA_DELIVERY_MODE must be "redirect", "proxy" or "hybrid" (got: ${raw})`
    )
  }
  return raw
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const configPath =
    overrides.configPath ?? process.env.CONFIG_PATH ?? './config/playlists.json'
  const resolvedConfigPath = path.resolve(configPath)
  const serverConfig = readServerConfig(resolvedConfigPath)

  return {
    port: overrides.port ?? Number(process.env.PORT ?? 8787),
    configPath: resolvedConfigPath,
    dataDir: path.resolve(
      overrides.dataDir ?? process.env.DATA_DIR ?? './data'
    ),
    adminToken:
      overrides.adminToken ??
      // 空文字列 ("ADMIN_TOKEN=" のような未設定相当の指定) も認証無効 (null) 扱いにするため || を使う。
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      (process.env.ADMIN_TOKEN?.trim() || null),
    ytdlpPath: overrides.ytdlpPath ?? process.env.YTDLP_PATH ?? 'yt-dlp',
    defaultMaxSlots:
      overrides.defaultMaxSlots ??
      Number(process.env.DEFAULT_MAX_SLOTS ?? 1000),
    ytdlpTimeoutMs:
      overrides.ytdlpTimeoutMs ??
      Number(process.env.YTDLP_TIMEOUT_MS ?? 60_000),
    manifestCacheTtlMs:
      overrides.manifestCacheTtlMs ??
      Number(process.env.MANIFEST_CACHE_TTL_MS ?? 300_000),
    deliveryMode: readDeliveryMode(overrides),
    mediaMaxHeight:
      overrides.mediaMaxHeight ?? Number(process.env.MEDIA_MAX_HEIGHT ?? 1080),
    mediaCacheDir: path.resolve(
      overrides.mediaCacheDir ?? process.env.MEDIA_CACHE_DIR ?? './data/cache'
    ),
    mediaCacheMaxBytes:
      overrides.mediaCacheMaxBytes ??
      Number(process.env.MEDIA_CACHE_MAX_BYTES ?? 10 * 1024 * 1024 * 1024),
    mediaCacheTtlMs:
      overrides.mediaCacheTtlMs ??
      Number(process.env.MEDIA_CACHE_TTL_MS ?? 6 * 60 * 60 * 1000),
    mediaDownloadTimeoutMs:
      overrides.mediaDownloadTimeoutMs ??
      Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS ?? 600_000),
    playlists: overrides.playlists ?? serverConfig.playlists,
  }
}

export function maxSlotsFor(config: AppConfig, playlistId: string): number {
  const entry = config.playlists.find((p) => p.playlistId === playlistId)
  return entry?.maxSlots ?? config.defaultMaxSlots
}

// YouTube の playlistId (例: "PLxxxxxxxx") は英数字・`_`・`-` のみで構成される。
// allowlist 無効時は任意の文字列がそのまま Position Pool のディレクトリ名
// (`encodeURIComponent(playlistId)`) や yt-dlp の引数に渡るため、ここで弾いておかないと
// "." だけの playlistId (`encodeURIComponent` で変化しない) が `path.join(dataDir, '..')` に
// 化けて dataDir の外にファイルを読み書きできてしまう (path traversal)。
const PLAYLIST_ID_PATTERN = /^[\w-]+$/

/**
 * playlistId が要求可能かどうかを判定する。
 * フォーマット (`PLAYLIST_ID_PATTERN`) を満たさないものは常に false。
 * それ以外は `config.playlists` が空 (allowlist 無効) なら true、そうでなければ一覧に
 * 含まれる playlistId のみ true を返す。
 */
export function isPlaylistAllowed(
  config: AppConfig,
  playlistId: string
): boolean {
  if (!PLAYLIST_ID_PATTERN.test(playlistId)) return false
  return (
    config.playlists.length === 0 ||
    config.playlists.some((p) => p.playlistId === playlistId)
  )
}
