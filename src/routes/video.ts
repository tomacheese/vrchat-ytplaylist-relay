import { Router } from 'express'
import type { AppConfig } from '../config'
import { resolveAndServe } from '../media-delivery'

// VIDEO_ID_PATTERN (config.ts) の文字クラスをキャプチャグループとして内包し、
// 末尾の `.mp4` 拡張子の有無を問わず受理できるようにしたパターン。
const VIDEO_ID_PARAM_PATTERN = /^([\w-]{11})(?:\.mp4)?$/

/**
 * GET /video/{videoId}
 * GET /video/{videoId}.mp4
 *
 * Playlist/position を経由せず、videoId を直接指定して再生する。`.mp4` 拡張子の有無どちらの
 * 形式も受け付ける。配信方式判定は `resolveAndServe` (../media-delivery) を共有し、
 * 既存 Media Endpoint (../routes/media) と同一の redirect/relay/proxy/hybrid ロジックに従う。
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
