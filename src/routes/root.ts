import { Router } from 'express'
import type { AppConfig } from '../config'

/**
 * GET /
 *
 * ブラウザや疎通確認で直接アクセスされた際に `Cannot GET /` を返さないための簡易ステータス表示。
 * 認証や構成情報 (ADMIN_TOKEN 等) は含めず、公開して問題ない情報のみ返す。
 */
export function rootRouter(config: AppConfig): Router {
  const router = Router()

  router.get('/', (_req, res) => {
    res.status(200).json({
      name: 'vrchat-ytplaylist-relay',
      status: 'ok',
      deliveryMode: config.deliveryMode,
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
