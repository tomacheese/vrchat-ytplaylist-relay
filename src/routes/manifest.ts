import { Router } from 'express'
import { isPlaylistAllowed } from '../config'
import type { AppConfig } from '../config'
import { getManifestForClient } from '../refresh'

/**
 * GET /{playlistId}/manifest.json
 *
 * Backend は Playlist の内容を Disk に永続化せず、Client からの要求のたびに TTL キャッシュを
 * 確認し、切れていれば yt-dlp で YouTube Playlist を取得して応答する ({@link getManifestForClient} 参照)。
 */
export function manifestRouter(config: AppConfig): Router {
  const router = Router()

  router.get('/:playlistId/manifest.json', (req, res, next) => {
    const { playlistId } = req.params
    if (!isPlaylistAllowed(config, playlistId)) {
      res.status(404).json({ error: 'unknown playlistId' })
      return
    }

    // Router に渡す関数自体は async にせず Promise Chain の末尾 .catch(next) でエラーを
    // 処理する (Express 4 のハンドラーは void を期待するため。no-misused-promises 対策)。
    getManifestForClient(config, playlistId)
      .then(({ manifest, error }) => {
        if (!manifest) {
          // まだ一度も取得に成功していない。World 側は「現在の Playlist を維持」でよいので 503 で明示する。
          res.status(503).json({ error: error ?? 'manifest not available yet' })
          return
        }
        res.status(200).json(manifest)
      })
      .catch(next)
  })

  return router
}
