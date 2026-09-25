import path from 'node:path'
import { Router } from 'express'
import type { Response } from 'express'
import { VIDEO_ID_PATTERN, isPlaylistAllowed } from '../config'
import type { AppConfig } from '../config'
import { liveRelayDirFor, touchLiveRelay } from '../live-relay'
import { logger } from '../logger'
import { ensureVodSegment } from '../vod-relay'
import { resolveVideoIdForPosition } from '../refresh'

const POSITION_PATTERN = /^(\d+)$/
/**
 * ffmpeg (`live-relay.ts`) が生成するファイル名 (`live.m3u8` 本体、`live0.ts` 等の segment) と、
 * VOD の多重化 segment (`seg0.ts` 等、`vod-relay.ts`) のみを許可する。任意のファイル名を受け付けないことが path traversal 対策になる。
 */
const LIVE_FILE_PATTERN = /^live\.m3u8$|^live\d+\.ts$|^seg\d+\.ts$/
const VOD_SEGMENT_PATTERN = /^seg(\d+)\.ts$/

/**
 * videoId の Live 再公開ファイル (master playlist / segment) を配信する共通処理。
 * `GET /{playlistId}/{position}/live/{file}` と `GET /live/{videoId}/{file}` の両方から、
 * 呼び出し元でそれぞれの方法により解決済みの videoId を渡して呼ばれる。
 * 視聴中のクライアントは master playlist / segment ごとに繰り返し fetch し続けるため、
 * `touchLiveRelay()` で該当 videoId の `lastAccessedAt` を更新する。
 * これは `evictIdleLiveRelays()` が視聴中のプロセスを誤ってアイドル判定しないようにするためである。
 */
function serveLiveFile(
  config: AppConfig,
  videoId: string,
  file: string,
  res: Response
): void {
  if (!LIVE_FILE_PATTERN.test(file)) {
    res.status(404).json({ error: 'invalid file' })
    return
  }
  touchLiveRelay(videoId)
  const baseDir = liveRelayDirFor(config, videoId)
  const filePath = path.join(baseDir, file)
  // LIVE_FILE_PATTERN で file を検証済みだが、静的解析ツールが正しく安全性を
  // 追跡できるよう、送信直前にも解決後パスが baseDir 配下であることを明示的に確認する。
  if (!path.resolve(filePath).startsWith(path.resolve(baseDir) + path.sep)) {
    res.status(404).json({ error: 'invalid file' })
    return
  }
  const segment = VOD_SEGMENT_PATTERN.exec(file)
  if (segment === null) {
    res.sendFile(filePath)
    return
  }
  ensureVodSegment(videoId, Number(segment[1]))
    .then((segmentPath) => {
      if (segmentPath === null) {
        res.status(404).json({ error: 'unknown segment' })
        return
      }
      res.sendFile(segmentPath)
    })
    .catch((err: unknown) => {
      logger.error(
        'relay.live.segment.failed',
        'Failed to prepare live segment',
        {
          video_id: videoId,
          segment: file,
          error: err instanceof Error ? err : new Error(String(err)),
        }
      )
      res.status(502).json({ error: 'failed to prepare segment' })
    })
}

/**
 * Live `proxy` モードで `ensureLiveRelay()` が再公開したローカル HLS ファイルを配信する 2 つの
 * ルート (Playlist/position 経由、videoId 直接指定) をまとめる Router。
 */
export function liveRouter(config: AppConfig): Router {
  const router = Router()

  router.get('/:playlistId/:position/live/:file', (req, res) => {
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
    // resolveVideoIdForPosition() は yt-dlp Refresh を伴いうる高コストな非同期処理のため、
    // file の形式チェックはその呼び出し前に済ませ、不正な file で無駄な Refresh を防ぐ。
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
        serveLiveFile(config, resolved.videoId, file, res)
      })
      .catch((err: unknown) => {
        res.status(502).json({
          error: `failed to resolve position: ${(err as Error).message}`,
        })
      })
  })

  /**
   * GET /live/{videoId}/{file}
   *
   * videoId を直接指定して Live 再公開ファイルを取得する (`../routes/video` の
   * `LIVE_DELIVERY_MODE=proxy` から Redirect される)。Playlist を経由しないため
   * `isPlaylistAllowed` は行わず、`VIDEO_ID_PATTERN` でのフォーマット検証のみ行う。
   */
  router.get('/live/:videoId/:file', (req, res) => {
    const { videoId, file } = req.params
    if (!VIDEO_ID_PATTERN.test(videoId)) {
      res.status(404).json({ error: 'invalid videoId' })
      return
    }
    serveLiveFile(config, videoId, file, res)
  })

  return router
}
