import { logger } from './logger'
import type { RunYtdlpOptions } from './ytdlp'
import { resolveVideoJson } from './ytdlp'

/** Minimal info extracted from `yt-dlp -j` needed to choose the delivery method. */
export interface ResolvedVideoInfo {
  isLive: boolean
  /**
   * HLS manifest URL to serve: the highest-quality AVC1 (H.264) legacy TS variant that has audio,
   * else the raw YouTube HLS master manifest URL (see `extractHlsMasterManifestUrl`). Null if none.
   */
  hlsMasterManifestUrl: string | null
  /**
   * True when `hlsMasterManifestUrl` is the master manifest itself (no single variant with audio
   * could be chosen). In relay mode, VOD then muxes the master's AVC1 variant and audio rendition
   * into MPEG-TS per segment with ffmpeg (`vod-relay.ts`).
   */
  hlsIsMaster: boolean
}

/** Cache entry for `resolveVideoInfo`. */
interface CacheEntry {
  info: ResolvedVideoInfo
  fetchedAt: number
}

/**
 * Per-videoId resolve cache, same shape as `manifestCache` in `refresh.ts` (Map + fetchedAt).
 * Within the TTL yt-dlp is not re-run, limiting yt-dlp load from frequently hit positions in mixed modes.
 */
const resolveCache = new Map<string, CacheEntry>()
const inFlightResolutions = new Map<string, Promise<ResolvedVideoInfo>>()

/** Only the fields of the `yt-dlp -j` JSON needed to detect live. */
interface YtdlpVideoJson {
  is_live?: unknown
  formats?: unknown
}

/**
 * Picks, from `formats[]`, the highest-quality AVC1 (H.264) legacy TS variant URL that plays
 * reliably in VRChat (AVPro Video / Windows MediaFoundation). Handing over the raw YouTube HLS
 * master manifest (a multivariant playlist) leaves variant selection to VRChat's bundled yt-dlp /
 * AVPro, which can pick a VP9 + fMP4/CMAF variant that fails to play (a known bug reported on
 * the VRChat feedback board). Pinning a single variant server-side bypasses that fragile logic.
 *
 * Some legacy TS variants are video-only, so candidates with `acodec === 'none'` (yt-dlp's value
 * for formats without audio) are excluded. Otherwise the quality comparison could pick a silent
 * variant and relay playback would have no audio.
 *
 * With no candidate, falls back to the first `manifest_url` found (a master manifest that includes
 * non-AVC1 variants) and returns `{ url, isMaster: true }`. If the master has no AVC1 variant at
 * all, `isMaster` is false and the caller 302s to the URL as before (nothing to narrow down).
 * For VOD with AVC1 variants but none with audio, `isMaster` is true and the caller narrows to
 * AVC1 + audio and muxes per segment (`hls-filter.ts` / `vod-relay.ts`).
 * When falling back without muxing (no AVC1, or live), logs a warning with `videoId`, since the
 * known playback bug may be hit and operators should be able to detect it.
 */
function extractHlsMasterManifestUrl(
  videoId: string,
  formats: unknown,
  isLive: boolean
): { url: string | null; isMaster: boolean } {
  if (!Array.isArray(formats)) return { url: null, isMaster: false }

  let bestAvc1Url: string | null = null
  let bestAvc1Height = -1
  let fallbackManifestUrl: string | null = null
  let hasAvc1 = false

  for (const format of formats) {
    if (typeof format !== 'object' || format === null) continue
    const {
      protocol,
      manifest_url: manifestUrl,
      vcodec,
      acodec,
      url,
      height,
    } = format as {
      protocol?: unknown
      manifest_url?: unknown
      vcodec?: unknown
      acodec?: unknown
      url?: unknown
      height?: unknown
    }
    if (protocol !== 'm3u8_native') continue

    if (typeof manifestUrl === 'string' && fallbackManifestUrl === null) {
      fallbackManifestUrl = manifestUrl
    }

    if (typeof vcodec === 'string' && vcodec.startsWith('avc1')) hasAvc1 = true

    if (
      acodec !== 'none' &&
      typeof url === 'string' &&
      typeof height === 'number' &&
      typeof vcodec === 'string' &&
      vcodec.startsWith('avc1') &&
      height > bestAvc1Height
    ) {
      bestAvc1Url = url
      bestAvc1Height = height
    }
  }

  if (
    bestAvc1Url === null &&
    fallbackManifestUrl !== null &&
    (!hasAvc1 || isLive)
  ) {
    logger.warn(
      'media.hls_variant.fallback',
      'No AVC1 HLS variant was found; using the master manifest URL',
      { video_id: videoId, fallback: 'master_manifest' }
    )
  }

  return bestAvc1Url === null
    ? {
        url: fallbackManifestUrl,
        isMaster: fallbackManifestUrl !== null && hasAvc1,
      }
    : { url: bestAvc1Url, isMaster: false }
}

/**
 * Resolves videoId with yt-dlp (`-j`, `--no-playlist`) to get the live flag and the HLS master
 * manifest URL. Called from `relay` mode (VOD and live) and wherever the live flag itself is
 * needed (when `mediaDeliveryMode !== liveDeliveryMode`).
 *
 * Repeated calls for one videoId within `cacheTtlMs` run yt-dlp once. If yt-dlp fails, the error
 * propagates and nothing is cached, so a transient error doesn't keep returning 502 for long.
 */
export async function resolveVideoInfo(
  videoId: string,
  options: RunYtdlpOptions & { cacheTtlMs: number }
): Promise<ResolvedVideoInfo> {
  const cached = resolveCache.get(videoId)
  if (cached && Date.now() - cached.fetchedAt < options.cacheTtlMs) {
    return cached.info
  }

  const inFlight = inFlightResolutions.get(videoId)
  if (inFlight) return inFlight

  const promise = (async () => {
    const raw = (await resolveVideoJson(videoId, options)) as YtdlpVideoJson
    const isLive = raw.is_live === true
    const hls = extractHlsMasterManifestUrl(videoId, raw.formats, isLive)
    const info: ResolvedVideoInfo = {
      isLive,
      hlsMasterManifestUrl: hls.url,
      hlsIsMaster: hls.isMaster,
    }
    resolveCache.set(videoId, { info, fetchedAt: Date.now() })
    return info
  })()
  inFlightResolutions.set(videoId, promise)
  try {
    return await promise
  } finally {
    if (inFlightResolutions.get(videoId) === promise) {
      inFlightResolutions.delete(videoId)
    }
  }
}

/** For tests: clears the cache. */
export function clearResolveCache(): void {
  resolveCache.clear()
  inFlightResolutions.clear()
}
