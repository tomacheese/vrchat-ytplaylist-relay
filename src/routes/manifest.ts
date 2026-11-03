import { Router } from 'express'
import { isPlaylistAllowed } from '../config'
import type { AppConfig } from '../config'
import { getManifestForClient } from '../refresh'

/**
 * GET /{playlistId}/manifest.json
 *
 * The backend does not persist Playlist contents to disk. On each client request it checks the TTL cache
 * and, if expired, fetches the YouTube Playlist with yt-dlp before responding (see {@link getManifestForClient}).
 */
export function manifestRouter(config: AppConfig): Router {
  const router = Router()

  router.get('/:playlistId/manifest.json', (req, res, next) => {
    const { playlistId } = req.params
    if (!isPlaylistAllowed(config, playlistId)) {
      res.status(404).json({ error: 'unknown playlistId' })
      return
    }

    // The function passed to the Router is not async; errors are handled by .catch(next) at the end of the
    // Promise chain (Express 4 handlers are expected to return void; avoids no-misused-promises).
    getManifestForClient(config, playlistId)
      .then(({ manifest, error }) => {
        if (!manifest) {
          // Never fetched successfully yet. The World can just keep "the current Playlist", so signal it explicitly with 503.
          res.status(503).json({ error: error ?? 'manifest not available yet' })
          return
        }
        res.status(200).json(manifest)
      })
      .catch(next)
  })

  return router
}
