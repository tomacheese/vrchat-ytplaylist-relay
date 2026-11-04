import { Router } from 'express'
import { PLAYLIST_ID_PATTERN, isPlaylistAllowed } from '../config'
import type { AppConfig } from '../config'
import { resolveAndServe } from '../media-delivery'
import { resolveVideoIdForPosition } from '../refresh'

const POSITION_PATTERN = /^(\d+)\.mp4$/

/**
 * GET /{playlistId}/{position}.mp4
 *
 * If the Position Pool state has no entry for the position (e.g. first request), a yt-dlp Refresh is
 * attempted automatically, as in the Manifest Endpoint, before resolving again (`resolveVideoIdForPosition`).
 *
 * Delivery mode selection (Live/VOD detection, switching among `redirect`/`relay`/`proxy`/`hybrid`) is
 * factored out as shared logic in `resolveAndServe` (`../media-delivery`).
 * The only difference from the direct-videoId endpoint (`../routes/video`) is how the Redirect URL
 * is built (`buildRedirectPath`), which points to the route serving republished files in Live "proxy" mode.
 */
export function mediaRouter(config: AppConfig): Router {
  const router = Router()

  router.get('/:playlistId/:positionFile', (req, res) => {
    const { playlistId, positionFile } = req.params
    if (!isPlaylistAllowed(config, playlistId)) {
      res.status(404).json({ error: 'unknown playlistId' })
      return
    }

    const match = POSITION_PATTERN.exec(positionFile)
    if (!match) {
      res.status(404).json({ error: 'invalid position' })
      return
    }
    const position = Number(match[1])

    // The function passed to the Router is not async; errors are handled by .catch() at the end of the
    // Promise chain (Express 4 handlers are expected to return void; avoids no-misused-promises).
    resolveVideoIdForPosition(config, playlistId, position)
      .then((resolved) => {
        if ('error' in resolved) {
          // A transient Refresh failure (e.g. yt-dlp error) is 502; only a position that truly
          // does not exist is 404 (consistent with the 502 on `getOrDownload` failure).
          const status = resolved.reason === 'refresh_failed' ? 502 : 404
          res.status(status).json({ error: resolved.error })
          return
        }
        const { videoId } = resolved

        resolveAndServe(
          config,
          videoId,
          {
            // playlistId is already allowlisted by the caller (isPlaylistAllowed).
            // Static analysis tools cannot track that safety across the function boundary,
            // so re-validate the format explicitly right before building the Redirect target,
            // then encode it.
            buildRedirectPath: (file) =>
              PLAYLIST_ID_PATTERN.test(playlistId)
                ? `/${encodeURIComponent(playlistId)}/${position}/live/${encodeURIComponent(file)}`
                : null,
          },
          res
        )
      })
      .catch((err: unknown) => {
        res.status(502).json({
          error: `failed to resolve position: ${(err as Error).message}`,
        })
      })
  })

  return router
}
