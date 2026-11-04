import { Router } from 'express'
import type { AppConfig } from '../config'

/**
 * GET /
 *
 * Simple status display so a direct visit from a browser or connectivity check does not get `Cannot GET /`.
 * Includes no auth or configuration secrets (ADMIN_TOKEN etc.); only information safe to expose.
 */
export function rootRouter(config: AppConfig): Router {
  const router = Router()

  router.get('/', (_req, res) => {
    res.status(200).json({
      name: 'vrchat-ytplaylist-relay',
      status: 'ok',
      mediaDeliveryMode: config.mediaDeliveryMode,
      liveDeliveryMode: config.liveDeliveryMode,
      playlists: config.playlists.map((p) => p.playlistId),
      endpoints: {
        health: '/health',
        manifest: '/:playlistId/manifest.json',
        media: '/:playlistId/:position.mp4',
      },
    })
  })

  return router
}
