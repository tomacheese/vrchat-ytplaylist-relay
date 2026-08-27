import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
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
   *   ffmpeg / 十分なディスク容量が必要になる。
   */
  deliveryMode: 'redirect' | 'proxy'
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

function readServerConfig(configPath: string): ServerConfig {
  const raw = fs.readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(raw) as ServerConfig
  if (!Array.isArray(parsed.playlists) || parsed.playlists.length === 0) {
    throw new Error(
      `Config at ${configPath} must contain a non-empty "playlists" array`
    )
  }
  for (const entry of parsed.playlists) {
    if (!entry.playlistId || typeof entry.playlistId !== 'string') {
      throw new Error(
        `Config at ${configPath} contains a playlist entry without a valid "playlistId"`
      )
    }
  }
  return parsed
}

function readDeliveryMode(overrides: Partial<AppConfig>): 'redirect' | 'proxy' {
  const raw =
    overrides.deliveryMode ??
    // 空文字列 ("MEDIA_DELIVERY_MODE=" のような未設定相当の指定) も既定値扱いにするため || を使う。
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    (process.env.MEDIA_DELIVERY_MODE?.trim() || 'redirect')
  if (raw !== 'redirect' && raw !== 'proxy') {
    throw new Error(
      `MEDIA_DELIVERY_MODE must be "redirect" or "proxy" (got: ${raw})`
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
