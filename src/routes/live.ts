import path from 'node:path'
import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { isPlaylistAllowed } from '../config'
import type { AppConfig } from '../config'
import { liveRelayDirFor, touchLiveRelay } from '../live-relay'
import { resolveVideoIdForPosition } from '../refresh'

const POSITION_PATTERN = /^(\d+)$/
/**
 * ffmpeg (`live-relay.ts`) が生成するファイル名 (`live.m3u8` 本体、`live0.ts` 等の segment) の
 * みを許可する。任意のファイル名を受け付けないことが path traversal 対策になる。
 */
const LIVE_FILE_PATTERN = /^live\.m3u8$|^live\d+\.ts$/

/** Live 再公開の segment 取得は VOD 単体ファイル配信よりリクエスト頻度が高い想定だが、v1 では既存 (mediaRateLimit) と同水準を流用する。 */
const liveRateLimit = rateLimit({ windowMs: 60_000, limit: 60 })

/**
 * GET /{playlistId}/{position}/live/{file}
 *
 * Live `proxy` モードで `ensureLiveRelay()` が再公開したローカル HLS ファイル (master playlist /
 * segment) を配信する。視聴中のクライアントはこのルートを master playlist / segment ごとに
 * 繰り返し fetch し続けるため、リクエストの都度 `touchLiveRelay()` で該当 videoId の
 * `lastAccessedAt` を更新する (`evictIdleLiveRelays()` が視聴中のプロセスを誤ってアイドル判定
 * しないようにするため)。
 */
export function liveRouter(config: AppConfig): Router {
  const router = Router()

  router.get('/:playlistId/:position/live/:file', liveRateLimit, (req, res) => {
    const { playlistId, position: positionParam, file } = req.params
    if (!isPlaylistAllowed(config, playlistId)) {
      res.status(404).json({ error: 'unknown playlistId' })
      return
    }

    const positionMatch = POSITION_PATTERN.exec(positionParam)
    if (!positionMatch) {
      res.status(404).json({ error: 'invalid position' })
      return
    }
    if (!LIVE_FILE_PATTERN.test(file)) {
      res.status(404).json({ error: 'invalid file' })
      return
    }
    const position = Number(positionMatch[1])

    resolveVideoIdForPosition(config, playlistId, position)
      .then((resolved) => {
        if ('error' in resolved) {
          const status = resolved.reason === 'refresh_failed' ? 502 : 404
          res.status(status).json({ error: resolved.error })
          return
        }
        const { videoId } = resolved
        touchLiveRelay(videoId)
        const baseDir = liveRelayDirFor(config, videoId)
        const filePath = path.join(baseDir, file)
        // LIVE_FILE_PATTERN で file を検証済みだが、静的解析ツールが正しく安全性を
        // 追跡できるよう、送信直前にも解決後パスが baseDir 配下であることを明示的に確認する。
        if (
          !path.resolve(filePath).startsWith(path.resolve(baseDir) + path.sep)
        ) {
          res.status(404).json({ error: 'invalid file' })
          return
        }
        res.sendFile(filePath)
      })
      .catch((err: unknown) => {
        res.status(502).json({
          error: `failed to resolve position: ${(err as Error).message}`,
        })
      })
  })

  return router
}
