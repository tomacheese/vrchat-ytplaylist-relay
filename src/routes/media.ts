import { Router } from 'express'
import { PLAYLIST_ID_PATTERN, isPlaylistAllowed } from '../config'
import type { AppConfig } from '../config'
import { resolveAndServe } from '../media-delivery'
import { resolveVideoIdForPosition } from '../refresh'

const POSITION_PATTERN = /^(\d+)\.mp4$/

/**
 * GET /{playlistId}/{position}.mp4
 *
 * Position Pool 状態に対象 position が無い場合 (初回リクエストなど) は、Manifest Endpoint と
 * 同様に yt-dlp Refresh を自動的に試みてから再解決する (`resolveVideoIdForPosition`)。
 *
 * 配信方式判定 (Live/VOD 判定、`redirect`/`relay`/`proxy`/`hybrid` の切り替え) は
 * `resolveAndServe` (`../media-delivery`) に共有ロジックとして切り出してある。
 * videoId 直接指定エンドポイント (`../routes/video`) とこの Router の違いは
 * Redirect URL 組み立て方 (`buildRedirectPath`) のみである。
 * この URL は Live "proxy" モードの再公開ファイル配信ルートを指す。
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

    // Router に渡す関数自体は async にせず Promise Chain の末尾 .catch() でエラーを
    // 処理する (Express 4 のハンドラーは void を期待するため。no-misused-promises 対策)。
    resolveVideoIdForPosition(config, playlistId, position)
      .then((resolved) => {
        if ('error' in resolved) {
          // 一時的な Refresh 失敗 (yt-dlp エラーなど) は 502、position が本当に存在しない
          // 場合のみ 404 を返す (`getOrDownload` 失敗時の 502 と揃える)。
          const status = resolved.reason === 'refresh_failed' ? 502 : 404
          res.status(status).json({ error: resolved.error })
          return
        }
        const { videoId } = resolved

        resolveAndServe(
          config,
          videoId,
          {
            // playlistId は呼び出し元 (isPlaylistAllowed) で allowlist 済みである。
            // 静的解析ツールが関数境界をまたいだ安全性を追跡できるよう、Redirect 先の組み立て
            // 直前にも明示的にフォーマットを再検証してからエンコードする。
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
