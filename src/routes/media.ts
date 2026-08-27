import path from 'node:path'
import { Router } from 'express'
import type { AppConfig } from '../config'
import { getOrDownload } from '../media-cache'
import { loadSlotState } from '../manifest-store'

const POSITION_PATTERN = /^(\d+)\.mp4$/

/**
 * GET /{playlistId}/{position}.mp4
 *
 * `config.deliveryMode` により配信方式を切り替える:
 * - "redirect" (既定値): 動画バイト列を配信せず、解決した YouTube 動画へ 302 Redirect するだけ。
 *   VRChat の AVProVideoPlayer は youtube.com の URL をネイティブに解釈できるが、VRChat 同梱の
 *   制限付き yt-dlp が googlevideo.com 直リンクの解決に失敗し再生できないことがある。
 * - "proxy": Backend 自身が yt-dlp で動画をダウンロード・キャッシュし (mediaCache.ts)、
 *   バイト列を直接配信する。`res.sendFile()` (express の `send` パッケージ) が
 *   Range / ETag / Last-Modified / Accept-Ranges を自動処理するため AVProVideoPlayer の Seek にも対応できる。
 */
export function mediaRouter(config: AppConfig): Router {
  const router = Router()

  router.get('/:playlistId/:positionFile', (req, res) => {
    const { playlistId, positionFile } = req.params
    const known = config.playlists.some((p) => p.playlistId === playlistId)
    if (!known) {
      res.status(404).send('unknown playlistId')
      return
    }

    const match = POSITION_PATTERN.exec(positionFile)
    if (!match) {
      res.status(404).send('invalid position')
      return
    }
    const position = Number(match[1])

    const state = loadSlotState(config.dataDir, playlistId)
    const videoId = state?.slotToVideoId[String(position)]
    if (!videoId) {
      res.status(404).send('unknown position')
      return
    }

    if (config.deliveryMode === 'redirect') {
      res.redirect(
        302,
        `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
      )
      return
    }

    // Router に渡す関数自体は async にせず Promise Chain の末尾 .catch() でエラーを
    // 処理する (Express 4 のハンドラーは void を期待するため。no-misused-promises 対策)。
    getOrDownload(config, videoId)
      .then((filePath) => {
        res.sendFile(path.resolve(filePath))
      })
      .catch((err: unknown) => {
        res.status(502).send(`failed to fetch video: ${(err as Error).message}`)
      })
  })

  return router
}
