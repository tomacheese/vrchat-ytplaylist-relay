import path from 'node:path'
import { Router } from 'express'
import type { Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { isPlaylistAllowed } from '../config'
import type { AppConfig } from '../config'
import {
  getFreshOrStale,
  getOrDownload,
  triggerBackgroundDownload,
} from '../media-cache'
import { resolveVideoIdForPosition } from '../refresh'
import { logger } from '../logger'
import { YtdlpError } from '../ytdlp'

const POSITION_PATTERN = /^(\d+)\.mp4$/

/** yt-dlp ダウンロード・ファイル配信を伴うため IP ごとに 1 分あたり 60 リクエストへ制限する (DoS 対策)。 */
const mediaRateLimit = rateLimit({ windowMs: 60_000, limit: 60 })

/** 解決済み videoId を YouTube 視聴 URL へ 302 Redirect する ("redirect" / "hybrid" フォールバックの共通処理)。 */
function redirectToYoutube(res: Response, videoId: string): void {
  res.redirect(
    302,
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  )
}

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
 *   ダウンロード完了まで応答をブロックするため、Client 側の Timeout に間に合わないことがある。
 * - "hybrid": キャッシュ済みなら "proxy" と同様にバイト列を直接配信する。未キャッシュ (または TTL 切れ) の
 *   場合は応答をブロックせず、裏でダウンロードを開始しつつ即座に "redirect" と同様の 302 応答を返す。
 *   Client が Timeout 後に再リクエストしてくる頃にはダウンロードが完了している想定。
 *
 * "proxy" / "hybrid" いずれも、TTL 切れで再ダウンロード中の場合は直前まで有効だった完了済み
 * キャッシュファイルを ("stale-while-revalidate") そのまま配信し続け、ブロックや Redirect
 * フォールバックを発生させない (`getFreshOrStale`)。再ダウンロードが完了すると次回以降の
 * リクエストから新しいファイルに切り替わる。
 */
export function mediaRouter(config: AppConfig): Router {
  const router = Router()

  router.get('/:playlistId/:positionFile', mediaRateLimit, (req, res) => {
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

        if (config.deliveryMode === 'redirect') {
          redirectToYoutube(res, videoId)
          return
        }

        if (config.deliveryMode === 'hybrid') {
          const cachedPath = getFreshOrStale(config, videoId)
          if (cachedPath) {
            res.sendFile(path.resolve(cachedPath))
            return
          }
          triggerBackgroundDownload(config, videoId)
          redirectToYoutube(res, videoId)
          return
        }

        // "proxy"
        const cachedOrStalePath = getFreshOrStale(config, videoId)
        if (cachedOrStalePath) {
          res.sendFile(path.resolve(cachedOrStalePath))
          return
        }

        getOrDownload(config, videoId)
          .then((filePath) => {
            res.sendFile(path.resolve(filePath))
          })
          .catch((err: unknown) => {
            res.status(502).json({
              error: `failed to fetch video: ${(err as Error).message}`,
            })
            if (err instanceof YtdlpError && err.stderr.length > 0) {
              logger.error(err.stderr)
            }
          })
      })
      .catch((err: unknown) => {
        res.status(502).json({
          error: `failed to resolve position: ${(err as Error).message}`,
        })
      })
  })

  return router
}
