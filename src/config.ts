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
  /** Serve GET /:playlistId/manifest.json from the in-memory cache for this long (ms) without re-running yt-dlp. */
  manifestCacheTtlMs: number
  /** How long (ms) to wait after a failed manifest fetch before a public request may retry. */
  manifestRetryDelayMs: number
  /**
   * How the Media Endpoint (`GET /:playlistId/:position.mp4`) delivers VOD videos.
   * - "redirect": only 302-redirect to youtube.com.
   * - "relay-redirect": try "relay"; if the relay would return 502, 302-redirect to youtube.com instead.
   * - "proxy": the backend downloads and caches the video with yt-dlp and serves the bytes itself.
   *   This avoids the restricted yt-dlp bundled with VRChat failing to resolve direct googlevideo.com links,
   *   but needs ffmpeg and enough disk space. The response blocks until the download finishes,
   *   so it may exceed the client timeout.
   * - "hybrid": serve cached files directly like "proxy"; when not cached (or the TTL expired),
   *   start the download in the background without blocking and immediately return the same 302 as
   *   "relay" ("redirect" only if resolution fails). The download is expected to be done by the time
   *   the client retries after its timeout, combining quick responses with "proxy"'s 403 avoidance.
   * - "relay": 302-redirect to the HLS master manifest URL resolved by yt-dlp.
   *   Stateless delivery with no ffmpeg or disk cache (also usable for Live videos).
   */
  mediaDeliveryMode:
    'redirect' | 'relay' | 'relay-redirect' | 'proxy' | 'hybrid'
  /**
   * Delivery mode of `GET /:playlistId/:position.mp4` for Live videos.
   * Independent of `mediaDeliveryMode`, so VOD and Live can use different modes.
   * If either side uses `relay-redirect`, the other must be `redirect` or `relay-redirect`.
   * `hybrid` does not support Live and is rejected at startup.
   */
  liveDeliveryMode: 'redirect' | 'relay' | 'relay-redirect' | 'proxy'
  /** Directory where ffmpeg writes the republished HLS files (playlist + segments) in Live `proxy` mode. */
  liveRelayOutDir: string
  /**
   * Grace period (ms) after the last access to a Live republish route before the ffmpeg process is stopped.
   * The constraint is the number of resident ffmpeg processes rather than disk space,
   * so this should be much shorter than `mediaCacheTtlMs`.
   */
  liveRelayIdleTtlMs: number
  /**
   * Maximum total size (bytes) of muxed VOD segments under `liveRelayOutDir`. They are kept until the idle TTL,
   * so when starting a new VOD republish or during the periodic sweep, entries are evicted oldest-access-first
   * while this limit is exceeded. Live republishes are not counted.
   */
  liveRelayMaxBytes: number
  /** Maximum video height (px) downloaded in "proxy" mode; the best YouTube format at or below this is chosen. */
  mediaMaxHeight: number
  /** Directory for downloaded video files and metadata in "proxy" mode. */
  mediaCacheDir: string
  /** Total cache size limit (bytes) in "proxy" mode; the excess is evicted LRU, oldest access first. */
  mediaCacheMaxBytes: number
  /** How long (ms) a downloaded file counts as fresh in "proxy" mode; after that it is re-downloaded on next access. */
  mediaCacheTtlMs: number
  /** Per-download yt-dlp timeout (ms) in "proxy" mode; separate from the playlist listing timeout because downloads take longer. */
  mediaDownloadTimeoutMs: number
  /**
   * Number of trusted reverse-proxy hops, passed to Express's `trust proxy`.
   * When resolving `req.ip` from `X-Forwarded-For`, this many entries counted from the socket peer are trusted.
   * Unconditional trust (`true`) is never used.
   */
  trustProxy: number
  playlists: PlaylistConfigEntry[]
}

/**
 * Reads `config/playlists.json`. A missing file means the allowlist is disabled
 * (`playlists: []`), so any playlistId can be requested without prior registration.
 * Any other read/parse failure (e.g. corrupt JSON) is still an error.
 */
function readServerConfig(configPath: string): ServerConfig {
  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      logger.warn(
        'config.playlist_file.missing',
        'Playlist allowlist is disabled because its config file was not found',
        { config_path: configPath }
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
      'config.playlist_allowlist.empty',
      'Playlist allowlist is disabled because no playlists are configured',
      { config_path: configPath }
    )
  }
  return parsed
}

function readMediaDeliveryMode(
  overrides: Partial<AppConfig>
): 'redirect' | 'relay' | 'relay-redirect' | 'proxy' | 'hybrid' {
  const raw =
    overrides.mediaDeliveryMode ??
    // An empty string (e.g. "MEDIA_DELIVERY_MODE=") also falls back to the default, hence ||.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    (process.env.MEDIA_DELIVERY_MODE?.trim() || 'redirect')
  if (
    raw !== 'redirect' &&
    raw !== 'relay' &&
    raw !== 'relay-redirect' &&
    raw !== 'proxy' &&
    raw !== 'hybrid'
  ) {
    throw new Error(
      `MEDIA_DELIVERY_MODE must be "redirect", "relay", "relay-redirect", "proxy" or "hybrid" (got: ${raw})`
    )
  }
  return raw
}

function readLiveDeliveryMode(
  overrides: Partial<AppConfig>
): 'redirect' | 'relay' | 'relay-redirect' | 'proxy' {
  const raw =
    overrides.liveDeliveryMode ??
    // An empty string (e.g. "LIVE_DELIVERY_MODE=") also falls back to the default, hence ||.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    (process.env.LIVE_DELIVERY_MODE?.trim() || 'redirect')
  if (
    raw !== 'redirect' &&
    raw !== 'relay' &&
    raw !== 'relay-redirect' &&
    raw !== 'proxy'
  ) {
    throw new Error(
      `LIVE_DELIVERY_MODE must be "redirect", "relay", "relay-redirect" or "proxy" (got: ${raw})`
    )
  }
  return raw
}

/** Numeric settings are range-checked before being compared or passed to timers. */
function readInteger(
  name: string,
  value: string | number | undefined,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER
): number {
  const raw = value ?? fallback
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const configPath =
    overrides.configPath ?? process.env.CONFIG_PATH ?? './config/playlists.json'
  const resolvedConfigPath = path.resolve(configPath)
  const serverConfig = readServerConfig(resolvedConfigPath)
  const mediaDeliveryMode = readMediaDeliveryMode(overrides)
  const liveDeliveryMode = readLiveDeliveryMode(overrides)

  if (
    (mediaDeliveryMode === 'relay-redirect' &&
      liveDeliveryMode !== 'redirect' &&
      liveDeliveryMode !== 'relay-redirect') ||
    (liveDeliveryMode === 'relay-redirect' &&
      mediaDeliveryMode !== 'redirect' &&
      mediaDeliveryMode !== 'relay-redirect')
  ) {
    throw new Error(
      'MEDIA_DELIVERY_MODE and LIVE_DELIVERY_MODE must both be "redirect" or "relay-redirect" when either uses "relay-redirect"'
    )
  }

  const playlists = overrides.playlists ?? serverConfig.playlists
  for (const [index, entry] of playlists.entries()) {
    if (entry.maxSlots === undefined) {
      continue
    }

    if (typeof entry.maxSlots !== 'number') {
      throw new TypeError(`playlists[${index}].maxSlots must be a number`)
    }
    readInteger(`playlists[${index}].maxSlots`, entry.maxSlots, 1000, 1)
  }

  return {
    port: readInteger(
      'PORT',
      overrides.port ?? process.env.PORT,
      8787,
      0,
      65_535
    ),
    configPath: resolvedConfigPath,
    dataDir: path.resolve(
      overrides.dataDir ?? process.env.DATA_DIR ?? './data'
    ),
    adminToken:
      overrides.adminToken ??
      // An empty string (e.g. "ADMIN_TOKEN=") also means auth disabled (null), hence ||.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      (process.env.ADMIN_TOKEN?.trim() || null),
    ytdlpPath: overrides.ytdlpPath ?? process.env.YTDLP_PATH ?? 'yt-dlp',
    defaultMaxSlots: readInteger(
      'DEFAULT_MAX_SLOTS',
      overrides.defaultMaxSlots ?? process.env.DEFAULT_MAX_SLOTS,
      1000,
      1
    ),
    ytdlpTimeoutMs: readInteger(
      'YTDLP_TIMEOUT_MS',
      overrides.ytdlpTimeoutMs ?? process.env.YTDLP_TIMEOUT_MS,
      60_000,
      1,
      2_147_483_647
    ),
    manifestCacheTtlMs: readInteger(
      'MANIFEST_CACHE_TTL_MS',
      overrides.manifestCacheTtlMs ?? process.env.MANIFEST_CACHE_TTL_MS,
      300_000,
      0
    ),
    manifestRetryDelayMs: readInteger(
      'MANIFEST_RETRY_DELAY_MS',
      overrides.manifestRetryDelayMs ?? process.env.MANIFEST_RETRY_DELAY_MS,
      30_000,
      0
    ),
    mediaDeliveryMode,
    liveDeliveryMode,
    liveRelayOutDir: path.resolve(
      overrides.liveRelayOutDir ??
        process.env.LIVE_RELAY_OUT_DIR ??
        './data/live'
    ),
    liveRelayIdleTtlMs: readInteger(
      'LIVE_RELAY_IDLE_TTL_MS',
      overrides.liveRelayIdleTtlMs ?? process.env.LIVE_RELAY_IDLE_TTL_MS,
      5 * 60 * 1000,
      0
    ),
    liveRelayMaxBytes: readInteger(
      'LIVE_RELAY_MAX_BYTES',
      overrides.liveRelayMaxBytes ?? process.env.LIVE_RELAY_MAX_BYTES,
      10 * 1024 * 1024 * 1024,
      0
    ),
    mediaMaxHeight: readInteger(
      'MEDIA_MAX_HEIGHT',
      overrides.mediaMaxHeight ?? process.env.MEDIA_MAX_HEIGHT,
      1080,
      1
    ),
    mediaCacheDir: path.resolve(
      overrides.mediaCacheDir ?? process.env.MEDIA_CACHE_DIR ?? './data/cache'
    ),
    mediaCacheMaxBytes: readInteger(
      'MEDIA_CACHE_MAX_BYTES',
      overrides.mediaCacheMaxBytes ?? process.env.MEDIA_CACHE_MAX_BYTES,
      10 * 1024 * 1024 * 1024,
      0
    ),
    mediaCacheTtlMs: readInteger(
      'MEDIA_CACHE_TTL_MS',
      overrides.mediaCacheTtlMs ?? process.env.MEDIA_CACHE_TTL_MS,
      6 * 60 * 60 * 1000,
      0
    ),
    mediaDownloadTimeoutMs: readInteger(
      'MEDIA_DOWNLOAD_TIMEOUT_MS',
      overrides.mediaDownloadTimeoutMs ?? process.env.MEDIA_DOWNLOAD_TIMEOUT_MS,
      600_000,
      1,
      2_147_483_647
    ),
    trustProxy: readInteger(
      'TRUST_PROXY',
      overrides.trustProxy ?? process.env.TRUST_PROXY,
      1,
      0
    ),
    playlists,
  }
}

export function maxSlotsFor(config: AppConfig, playlistId: string): number {
  const entry = config.playlists.find((p) => p.playlistId === playlistId)
  return entry?.maxSlots ?? config.defaultMaxSlots
}

// A YouTube playlistId (e.g. "PLxxxxxxxx") consists only of alphanumerics, `_` and `-`.
// With the allowlist disabled, any string reaches the Position Pool directory name
// (`encodeURIComponent(playlistId)`) and yt-dlp arguments. A playlistId of just "." is unchanged by
// `encodeURIComponent` and would turn `path.join(dataDir, '..')` into a path outside dataDir
// (path traversal), so reject it here.
export const PLAYLIST_ID_PATTERN = /^[\w-]+$/

// A YouTube videoId (11 chars, alphanumerics, `_` and `-`) must be format-checked because
// `encodeURIComponent` leaves `.` unchanged, so a videoId of '..' would escape to the parent
// directory via path.join (path traversal).
export const VIDEO_ID_PATTERN = /^[\w-]{11}$/

/**
 * Whether playlistId may be requested.
 * Always false if it does not match `PLAYLIST_ID_PATTERN`.
 * Otherwise true when `config.playlists` is empty (allowlist disabled), or when the playlistId is listed.
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
