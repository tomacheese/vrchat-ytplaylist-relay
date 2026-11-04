import path from 'node:path'
import type { Response } from 'express'
import type { AppConfig } from './config'
import { ensureLiveRelay } from './live-relay'
import { resolveVideoInfo } from './live-resolve'
import type { ResolvedVideoInfo } from './live-resolve'
import {
  getFreshOrStale,
  getOrDownload,
  triggerBackgroundDownload,
} from './media-cache'
import { logger } from './logger'

/**
 * Info for building the redirect URL to the republished-file route in Live proxy mode.
 * `buildRedirectPath` may return `null` if it cannot build one (e.g. `media.ts` revalidation of
 * `PLAYLIST_ID_PATTERN` failed).
 * In that case `resolveAndServe` responds 404 (`{ error: 'unknown playlistId' }`).
 */
export interface LiveProxyTarget {
  buildRedirectPath: (playlistFileName: string) => string | null
}

/**
 * 302-redirects to the YouTube watch URL for the resolved videoId.
 * Shared by the "redirect" mode itself and as the fallback when "hybrid" fails to resolve the HLS manifest.
 */
function redirectToYoutube(res: Response, videoId: string): void {
  res.redirect(
    302,
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  )
}

/** Resolves a videoId using the yt-dlp options from `config` (thin wrapper over `resolveVideoInfo`). */
function resolveVideoInfoFor(
  config: AppConfig,
  videoId: string
): Promise<ResolvedVideoInfo> {
  return resolveVideoInfo(videoId, {
    ytdlpPath: config.ytdlpPath,
    timeoutMs: config.ytdlpTimeoutMs,
    cacheTtlMs: config.manifestCacheTtlMs,
  })
}

/** VOD "proxy" delivery (unchanged from before Live support). */
function serveVodProxy(
  config: AppConfig,
  videoId: string,
  res: Response
): void {
  const cachedOrStalePath = getFreshOrStale(config, videoId)
  if (cachedOrStalePath) {
    res.sendFile(path.resolve(cachedOrStalePath))
    return
  }

  getOrDownload(config, videoId)
    .then((filePath) => {
      res.sendFile(path.resolve(filePath))
    })
    .catch((err: unknown) => {
      res.status(502).json({
        error: `failed to fetch video: ${(err as Error).message}`,
      })
      logger.error('media.delivery.failed', 'Failed to fetch video', {
        video_id: videoId,
        mode: 'proxy',
        error: err instanceof Error ? err : new Error(String(err)),
      })
    })
}

/**
 * Live "proxy" delivery: start the republish via ensureLiveRelay() and 302 to the republished-file
 * route built by `liveProxyTarget`. If `buildRedirectPath` returns `null` (e.g. the caller's playlistId
 * revalidation failed), respond 404. If starting the republish fails, respond 502, or call
 * `onFailure` instead when provided (hybrid falls back to redirect).
 */
function serveLiveProxy(
  config: AppConfig,
  videoId: string,
  liveProxyTarget: LiveProxyTarget,
  res: Response,
  onFailure?: () => void
): void {
  ensureLiveRelay(config, videoId)
    .then((result) => {
      if ('error' in result) {
        if (onFailure) {
          logger.warn(
            'media.delivery.fallback',
            'Live relay failed; using fallback',
            {
              video_id: videoId,
              mode: 'proxy',
              fallback: 'configured_redirect',
              error: result.error,
            }
          )
          onFailure()
          return
        }
        res.status(502).json({ error: result.error })
        return
      }
      const redirectPath = liveProxyTarget.buildRedirectPath(
        result.playlistFileName
      )
      if (redirectPath === null) {
        res.status(404).json({ error: 'unknown playlistId' })
        return
      }
      res.redirect(302, redirectPath)
    })
    .catch((err: unknown) => {
      if (onFailure) {
        logger.warn(
          'media.delivery.fallback',
          'Live relay failed; using fallback',
          {
            video_id: videoId,
            mode: 'proxy',
            fallback: 'configured_redirect',
            error: err instanceof Error ? err : new Error(String(err)),
          }
        )
        onFailure()
        return
      }
      res.status(502).json({
        error: `failed to start live relay: ${(err as Error).message}`,
      })
      logger.error('media.delivery.failed', 'Failed to start live relay', {
        video_id: videoId,
        mode: 'proxy',
        error: err instanceof Error ? err : new Error(String(err)),
      })
    })
}

/**
 * "relay" delivery. 502 if resolution failed.
 * If a single AVC1 variant with audio was found, 302 to its URL.
 * Otherwise (YouTube VOD keeps audio in a separate rendition and the AVC1 variant is video-only,
 * so AVPro would play silently) mux segments with audio into MPEG-TS via ffmpeg and serve them
 * (same route as Live "proxy"; see `vod-relay.ts`).
 */
function serveRelay(
  config: AppConfig,
  videoId: string,
  liveProxyTarget: LiveProxyTarget,
  info: ResolvedVideoInfo,
  res: Response,
  onRelayFailure?: () => void
): void {
  if (!info.hlsMasterManifestUrl) {
    if (onRelayFailure) {
      logger.warn('media.delivery.fallback', 'HLS manifest was unavailable', {
        video_id: videoId,
        mode: 'relay',
        fallback: 'configured_redirect',
      })
      onRelayFailure()
      return
    }
    res.status(502).json({ error: 'failed to resolve HLS manifest' })
    logger.error('media.delivery.failed', 'Failed to resolve HLS manifest', {
      video_id: videoId,
      mode: 'relay',
    })
    return
  }
  if (info.hlsIsMaster && !info.isLive) {
    serveLiveProxy(config, videoId, liveProxyTarget, res, onRelayFailure)
    return
  }
  res.redirect(302, info.hlsMasterManifestUrl)
}

/**
 * Picks the delivery mode for a videoId (redirect/relay/relay-redirect/proxy/hybrid, VOD vs Live)
 * and writes the response directly. Shared by `src/routes/media.ts` (via playlist/position)
 * and `src/routes/video.ts` (direct videoId).
 *
 * Behavior per `effectiveMode`:
 * - "redirect": serve no bytes; just 302-redirect to the YouTube video.
 *   VRChat's AVProVideoPlayer understands youtube.com URLs natively, but the restricted yt-dlp
 *   bundled with VRChat sometimes fails to resolve direct googlevideo.com links and cannot play.
 * - "relay": 302-redirect to the HLS manifest URL resolved by yt-dlp (a single AVC1 variant with audio).
 *   Without a single variant, Live redirects to YouTube's raw master manifest URL.
 *   For VOD the audio is a separate rendition and AVPro would play silently, so segments are muxed
 *   into MPEG-TS with audio and served (same republish route as Live "proxy"; a stateless 302 when
 *   a single variant exists).
 * - "relay-redirect": try "relay"; if resolution or relay setup fails, 302-redirect to the YouTube watch URL.
 * - "proxy" (VOD): the backend downloads and caches the video with yt-dlp (media-cache.ts)
 *   and serves the bytes itself. The response blocks until the download finishes,
 *   so it may exceed the client timeout.
 * - "proxy" (Live): the backend republishes the HLS locally with ffmpeg (live-relay.ts) and
 *   302-redirects to the route built by `liveProxyTarget`.
 * - "hybrid" (VOD only; not allowed for Live): serve cached files directly like "proxy".
 *   When not cached (or the TTL expired), start the download in the background without blocking
 *   and immediately return the same 302 as "relay". Only if resolution fails, fall back to a
 *   youtube.com redirect as in "redirect". The download is expected to be done by the time the
 *   client retries after its timeout.
 *
 * For both "proxy" (VOD) and "hybrid", while a TTL-expired file is being re-downloaded, the previously
 * valid completed cache file keeps being served ("stale-while-revalidate", `getFreshOrStale`),
 * with no blocking or redirect fallback. Once the re-download finishes, later requests get the new file.
 *
 * @param liveProxyTarget How to build the redirect URL to the republished-file route (Live "proxy", and
 *   "relay"/"hybrid" for VOD whose audio is a separate rendition). The redirect path differs by caller
 *   (playlist/position vs direct videoId), so the caller injects it.
 */
export function resolveAndServe(
  config: AppConfig,
  videoId: string,
  liveProxyTarget: LiveProxyTarget,
  res: Response
): void {
  logger.withContext(
    {
      operation: 'media.delivery',
      operation_id: logger.newOperationId(),
    },
    () => {
      const startedAt = performance.now()
      let effectiveMode = config.mediaDeliveryMode
      let isLive: boolean | undefined
      res.once('finish', () => {
        const fields = {
          video_id: videoId,
          mode: effectiveMode,
          is_live: isLive,
          status_code: res.statusCode,
          duration_ms: Math.round(performance.now() - startedAt),
        }
        if (res.statusCode >= 500) {
          logger.error(
            'media.delivery.completed',
            'Media delivery failed',
            fields
          )
        } else {
          logger.info(
            'media.delivery.completed',
            'Media delivery completed',
            fields
          )
        }
      })

      if (
        config.mediaDeliveryMode === 'proxy' ||
        config.mediaDeliveryMode === 'hybrid'
      ) {
        const cachedPath = getFreshOrStale(config, videoId)
        if (cachedPath) {
          isLive = false
          res.sendFile(path.resolve(cachedPath))
          return
        }
      }

      const skipLiveCheck =
        config.mediaDeliveryMode === config.liveDeliveryMode &&
        (config.mediaDeliveryMode === 'redirect' ||
          config.mediaDeliveryMode === 'relay')

      if (skipLiveCheck) {
        if (config.mediaDeliveryMode === 'redirect') {
          effectiveMode = 'redirect'
          redirectToYoutube(res, videoId)
          return
        }
        // "relay": the skip condition guarantees mediaDeliveryMode === 'relay' here,
        // but the resolved info (hlsMasterManifestUrl) has not been fetched yet, so resolve it now.
        resolveVideoInfoFor(config, videoId)
          .then((info) => {
            isLive = info.isLive
            effectiveMode = 'relay'
            serveRelay(config, videoId, liveProxyTarget, info, res)
          })
          .catch((err: unknown) => {
            res.status(502).json({
              error: `failed to resolve position: ${(err as Error).message}`,
            })
            logger.error('media.delivery.failed', 'Failed to resolve media', {
              video_id: videoId,
              mode: 'relay',
              error: err instanceof Error ? err : new Error(String(err)),
            })
          })
        return
      }

      resolveVideoInfoFor(config, videoId)
        .then((info) => {
          effectiveMode = info.isLive
            ? config.liveDeliveryMode
            : config.mediaDeliveryMode
          isLive = info.isLive

          switch (effectiveMode) {
            case 'redirect': {
              redirectToYoutube(res, videoId)
              return
            }
            case 'relay': {
              serveRelay(config, videoId, liveProxyTarget, info, res)
              return
            }
            case 'relay-redirect': {
              serveRelay(config, videoId, liveProxyTarget, info, res, () => {
                logger.warn(
                  'media.delivery.fallback',
                  'Relay failed; redirecting to YouTube',
                  {
                    video_id: videoId,
                    mode: 'relay-redirect',
                    fallback: 'youtube',
                  }
                )
                redirectToYoutube(res, videoId)
              })
              return
            }
            case 'proxy': {
              if (info.isLive) {
                serveLiveProxy(config, videoId, liveProxyTarget, res)
              } else {
                serveVodProxy(config, videoId, res)
              }
              return
            }
            case 'hybrid': {
              // liveDeliveryMode cannot be "hybrid" (validated in config.ts), so
              // effectiveMode is "hybrid" only when info.isLive === false.
              const cachedPath = getFreshOrStale(config, videoId)
              if (cachedPath) {
                res.sendFile(path.resolve(cachedPath))
                return
              }
              triggerBackgroundDownload(config, videoId)
              if (info.hlsMasterManifestUrl) {
                serveRelay(config, videoId, liveProxyTarget, info, res, () => {
                  logger.warn(
                    'media.delivery.fallback',
                    'Relay failed; redirecting to YouTube',
                    { video_id: videoId, mode: 'hybrid', fallback: 'youtube' }
                  )
                  redirectToYoutube(res, videoId)
                })
              } else {
                redirectToYoutube(res, videoId)
              }
            }
          }
        })
        .catch((err: unknown) => {
          if (
            config.mediaDeliveryMode === 'relay-redirect' ||
            config.liveDeliveryMode === 'relay-redirect'
          ) {
            logger.warn(
              'media.delivery.fallback',
              'Relay resolution failed; redirecting to YouTube',
              {
                video_id: videoId,
                mode: 'relay-redirect',
                fallback: 'youtube',
                error: err instanceof Error ? err : new Error(String(err)),
              }
            )
            redirectToYoutube(res, videoId)
            return
          }
          res.status(502).json({
            error: `failed to resolve position: ${(err as Error).message}`,
          })
          logger.error('media.delivery.failed', 'Failed to resolve media', {
            video_id: videoId,
            error: err instanceof Error ? err : new Error(String(err)),
          })
        })
    }
  )
}
