import { Router } from 'express'
import type { AppConfig } from '../config'
import { resolveAndServe } from '../media-delivery'

// Wraps the character class of VIDEO_ID_PATTERN (config.ts) in a capture group and
// accepts the id with or without a trailing `.mp4` extension.
const VIDEO_ID_PARAM_PATTERN = /^([\w-]{11})(?:\.mp4)?$/

/**
 * GET /video/{videoId}
 * GET /video/{videoId}.mp4
 *
 * Plays by videoId directly, without going through a Playlist/position. Accepts the id with or without
 * the `.mp4` extension. Delivery mode selection shares `resolveAndServe` (../media-delivery), following the same
 * redirect/relay/proxy/hybrid logic as the existing Media Endpoint (../routes/media).
 */
export function videoRouter(config: AppConfig): Router {
  const router = Router()

  router.get('/video/:videoIdParam', (req, res) => {
    const match = VIDEO_ID_PARAM_PATTERN.exec(req.params.videoIdParam)
    if (!match) {
      res.status(404).json({ error: 'invalid videoId' })
      return
    }
    const videoId = match[1]

    resolveAndServe(
      config,
      videoId,
      {
        buildRedirectPath: (file) =>
          `/live/${encodeURIComponent(videoId)}/${encodeURIComponent(file)}`,
      },
      res
    )
  })

  return router
}
