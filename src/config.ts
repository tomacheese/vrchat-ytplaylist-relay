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
   *   なら応答をブロックせずダウンロードを裏で開始しつつ即座に "relay" (解決失敗時のみ "redirect")
   *   と同様の 302 応答を返す。Client が Timeout 後に再リクエストしてきた頃にはダウンロードが
   *   完了している想定で、即応性と "proxy" の 403 回避を両立させる。
   * - "relay": Backend が yt-dlp で解決した HLS master manifest URL へ 302 Redirect する。
   *   ffmpeg・ディスクキャッシュを使わないステートレスな配信方式 (Live 動画にも共通で使える)。
   */
  mediaDeliveryMode: 'redirect' | 'relay' | 'proxy' | 'hybrid'
  /**
   * Live (配信中) 動画向けの `GET /:playlistId/:position.mp4` 配信方式。
   * `mediaDeliveryMode` と独立して設定でき、VOD/Live で異なる方式を選べる。
   * `hybrid` は Live 未対応のため指定不可 (起動時エラー)。既定値は "redirect" (現状維持)。
   */
  liveDeliveryMode: 'redirect' | 'relay' | 'proxy'
  /** Live `proxy` モードで ffmpeg が HLS 再公開ファイル (playlist + segment) を書き出すディレクトリ。 */
  liveRelayOutDir: string
  /**
   * Live 再公開ファイルの配信ルートへのアクセスが途絶えてから、ffmpeg プロセスを停止するまでの
   * 猶予期間 (ms)。ディスク容量ではなく常駐 ffmpeg プロセス数が制約になるため、
   * `mediaCacheTtlMs` (既定 6 時間) より大幅に短い既定値 (5 分) にする。
   */
  liveRelayIdleTtlMs: number
  /**
   * VOD の多重化済み segment (`liveRelayOutDir` 配下) の合計サイズの上限 (bytes)。idle TTL まで保持するため、
   * 新しい VOD 再公開を起動する際や周期スイープでこの上限を超えていれば、最終アクセスが最も古いものから破棄する。Live の再公開は対象外。
   */
  liveRelayMaxBytes: number
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
  /**
   * Express の `trust proxy` 設定に渡す、信頼するリバースプロキシのホップ数。
   * `X-Forwarded-For` から `req.ip` を解決する際、ソケットの接続元から遡ってこの数だけの
   * エントリを信頼する。無条件信頼 (`true`) は行わない。
   */
  trustProxy: number
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

function readMediaDeliveryMode(
  overrides: Partial<AppConfig>
): 'redirect' | 'relay' | 'proxy' | 'hybrid' {
  const raw =
    overrides.mediaDeliveryMode ??
    // 空文字列 ("MEDIA_DELIVERY_MODE=" のような未設定相当の指定) も既定値扱いにするため || を使う。
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    (process.env.MEDIA_DELIVERY_MODE?.trim() || 'redirect')
  if (
    raw !== 'redirect' &&
    raw !== 'relay' &&
    raw !== 'proxy' &&
    raw !== 'hybrid'
  ) {
    throw new Error(
      `MEDIA_DELIVERY_MODE must be "redirect", "relay", "proxy" or "hybrid" (got: ${raw})`
    )
  }
  return raw
}

function readLiveDeliveryMode(
  overrides: Partial<AppConfig>
): 'redirect' | 'relay' | 'proxy' {
  const raw =
    overrides.liveDeliveryMode ??
    // 空文字列 ("LIVE_DELIVERY_MODE=" のような未設定相当の指定) も既定値扱いにするため || を使う。
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    (process.env.LIVE_DELIVERY_MODE?.trim() || 'redirect')
  if (raw !== 'redirect' && raw !== 'relay' && raw !== 'proxy') {
    throw new Error(
      `LIVE_DELIVERY_MODE must be "redirect", "relay" or "proxy" (got: ${raw})`
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
    mediaDeliveryMode: readMediaDeliveryMode(overrides),
    liveDeliveryMode: readLiveDeliveryMode(overrides),
    liveRelayOutDir: path.resolve(
      overrides.liveRelayOutDir ??
        process.env.LIVE_RELAY_OUT_DIR ??
        './data/live'
    ),
    liveRelayIdleTtlMs:
      overrides.liveRelayIdleTtlMs ??
      Number(process.env.LIVE_RELAY_IDLE_TTL_MS ?? 5 * 60 * 1000),
    liveRelayMaxBytes:
      overrides.liveRelayMaxBytes ??
      Number(process.env.LIVE_RELAY_MAX_BYTES ?? 10 * 1024 * 1024 * 1024),
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
    trustProxy: overrides.trustProxy ?? Number(process.env.TRUST_PROXY ?? 1),
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
export const PLAYLIST_ID_PATTERN = /^[\w-]+$/

// YouTube の videoId (11 文字、英数字・`_`・`-` のみ) は encodeURIComponent で `.` が変化しない。
// そのため、この形式チェックをしないと videoId '..' が path.join で
// 親ディレクトリへ抜けてしまう (path traversal)。
export const VIDEO_ID_PATTERN = /^[\w-]{11}$/

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
