import path from 'node:path'
import { Router } from 'express'
import { isPlaylistAllowed } from '../config'
import type { AppConfig } from '../config'
import { getOrDownload } from '../media-cache'
import { resolveVideoIdForPosition } from '../refresh'

const POSITION_PATTERN = /^(\d+)\.mp4$/

/**
 * GET /{playlistId}/{position}.mp4
 *
 * Position Pool 状態に対象 position が無い場合 (初回リクエストなど) は、Manifest Endpoint と
 * 同様に yt-dlp Refresh を自動的に試みてから再解決する (`resolveVideoIdForPosition`)。
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
    if (!isPlaylistAllowed(config, playlistId)) {
      res.status(404).send('unknown playlistId')
      return
    }

    const match = POSITION_PATTERN.exec(positionFile)
    if (!match) {
      res.status(404).send('invalid position')
      return
    }
    const position = Number(match[1])

    // Router に渡す関数自体は async にせず Promise Chain の末尾 .catch() でエラーを
    // 処理する (Express 4 のハンドラーは void を期待するため。no-misused-promises 対策)。
    resolveVideoIdForPosition(config, playlistId, position)
      .then((resolved) => {
        if ('error' in resolved) {
          // 一時的な Refresh 失敗 (yt-dlp エラーなど) は 502、position が本当に存在しない
          // 場合のみ 404 を返す (`getOrDownload` 失敗時の 502 と揃える)。
          const status = resolved.reason === 'refresh_failed' ? 502 : 404
          res.status(status).send(resolved.error)
          return
        }
        const { videoId } = resolved

        if (config.deliveryMode === 'redirect') {
          res.redirect(
            302,
            `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
          )
          return
        }

        getOrDownload(config, videoId)
          .then((filePath) => {
            res.sendFile(path.resolve(filePath))
          })
          .catch((err: unknown) => {
            res
              .status(502)
              .send(`failed to fetch video: ${(err as Error).message}`)
          })
      })
      .catch((err: unknown) => {
        res
          .status(502)
          .send(`failed to resolve position: ${(err as Error).message}`)
      })
  })

  return router
}
