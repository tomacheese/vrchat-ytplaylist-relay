import path from 'node:path'
import { Router } from 'express'
import type { Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { isPlaylistAllowed } from '../config'
import type { AppConfig } from '../config'
import { ensureLiveRelay } from '../live-relay'
import { resolveVideoInfo } from '../live-resolve'
import type { ResolvedVideoInfo } from '../live-resolve'
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

/**
 * 解決済み videoId を YouTube 視聴 URL へ 302 Redirect する。
 * "redirect" モード本体と、"hybrid" モードで HLS manifest の解決に失敗した際のフォールバックの
 * 両方から呼ばれる共通処理。
 */
function redirectToYoutube(res: Response, videoId: string): void {
  res.redirect(
    302,
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  )
}

/** `config` の yt-dlp 実行オプションを使って videoId を解決する (`resolveVideoInfo` の薄いラッパー)。 */
function resolveVideoInfoFor(
  config: AppConfig,
  videoId: string
): Promise<ResolvedVideoInfo> {
  return resolveVideoInfo(videoId, {
    ytdlpPath: config.ytdlpPath,
    timeoutMs: config.ytdlpTimeoutMs,
    cacheTtlMs: config.manifestCacheTtlMs,
  })
}

/** 既存の VOD "proxy" 配信ロジック (Live 対応前と同じ)。 */
function serveVodProxy(
  config: AppConfig,
  videoId: string,
  res: Response
): void {
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
}

/** Live "proxy" 配信ロジック: ensureLiveRelay() で再公開を起動し、Live 再公開ファイルの配信ルートへ 302 する。 */
function serveLiveProxy(
  config: AppConfig,
  playlistId: string,
  position: number,
  videoId: string,
  res: Response
): void {
  ensureLiveRelay(config, videoId)
    .then((result) => {
      if ('error' in result) {
        res.status(502).json({ error: result.error })
        return
      }
      // playlistId は呼び出し元 (mediaRouter) で isPlaylistAllowed() 済みだが、静的解析ツールが
      // 正しく安全性を追跡できるよう、Redirect 先の組み立て時にも明示的にエンコードする。
      res.redirect(
        302,
        `/${encodeURIComponent(playlistId)}/${position}/live/${encodeURIComponent(result.playlistFileName)}`
      )
    })
    .catch((err: unknown) => {
      res.status(502).json({
        error: `failed to start live relay: ${(err as Error).message}`,
      })
      if (err instanceof YtdlpError && err.stderr.length > 0) {
        logger.error(err.stderr)
      }
    })
}

/** "relay" 配信ロジック: 解決済みの HLS master manifest URL へ 302 する。解決に失敗していれば 502。 */
function serveRelay(info: ResolvedVideoInfo, res: Response): void {
  if (!info.hlsMasterManifestUrl) {
    res.status(502).json({ error: 'failed to resolve HLS manifest' })
    return
  }
  res.redirect(302, info.hlsMasterManifestUrl)
}

/**
 * GET /{playlistId}/{position}.mp4
 *
 * Position Pool 状態に対象 position が無い場合 (初回リクエストなど) は、Manifest Endpoint と
 * 同様に yt-dlp Refresh を自動的に試みてから再解決する (`resolveVideoIdForPosition`)。
 *
 * 動画が Live (配信中) かどうかで `config.mediaDeliveryMode` / `config.liveDeliveryMode` の
 * どちらを使うか (`effectiveMode`) を決める。ただし両方の値が同一で `"redirect"` または
 * `"relay"` の場合 (VOD/Live で実装ロジックが完全に同一なモードに限る) は isLive 判定
 * (`resolveVideoInfo` = yt-dlp -j 呼び出し) 自体を省略する。`"proxy"` は VOD/Live で実装が
 * 異なる別ロジックのため、両方の値が `"proxy"` で一致していてもこのスキップ対象にしない。
 *
 * `effectiveMode` ごとの挙動:
 * - "redirect": 動画バイト列を配信せず、解決した YouTube 動画へ 302 Redirect するだけ。
 *   VRChat の AVProVideoPlayer は youtube.com の URL をネイティブに解釈できるが、VRChat 同梱の
 *   制限付き yt-dlp が googlevideo.com 直リンクの解決に失敗し再生できないことがある。
 * - "relay": yt-dlp が解決した HLS master manifest URL へ 302 Redirect する。ffmpeg・
 *   ディスクキャッシュを使わないステートレスな配信方式 (VOD/Live 共通)。
 * - "proxy" (VOD): Backend 自身が yt-dlp で動画をダウンロード・キャッシュし (media-cache.ts)、
 *   バイト列を直接配信する。ダウンロード完了まで応答をブロックするため、Client 側の Timeout に
 *   間に合わないことがある。
 * - "proxy" (Live): Backend が ffmpeg で HLS をローカル再公開し (live-relay.ts)、Live 再公開
 *   ファイルの配信ルート (`routes/live.ts`) へ 302 Redirect する。
 * - "hybrid" (VOD 専用。Live には指定できない): キャッシュ済みなら "proxy" と同様にバイト列を
 *   直接配信する。未キャッシュ (または TTL 切れ) の場合は応答をブロックせず、裏でダウンロードを
 *   開始しつつ即座に "relay" と同様の 302 応答を返す (解決に失敗した場合のみ "redirect" 相当の
 *   youtube.com へフォールバックする)。Client が Timeout 後に再リクエストしてくる頃には
 *   ダウンロードが完了している想定。
 *
 * "proxy" (VOD) / "hybrid" いずれも、TTL 切れで再ダウンロード中の場合は直前まで有効だった完了済み
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

        const skipLiveCheck =
          config.mediaDeliveryMode === config.liveDeliveryMode &&
          (config.mediaDeliveryMode === 'redirect' ||
            config.mediaDeliveryMode === 'relay')

        if (skipLiveCheck) {
          if (config.mediaDeliveryMode === 'redirect') {
            redirectToYoutube(res, videoId)
            return
          }
          // "relay": スキップ条件からこの時点で config.mediaDeliveryMode === 'relay' が確定するが、
          // 解決結果 (hlsMasterManifestUrl) 自体はまだ取得していないためここで呼ぶ。
          resolveVideoInfoFor(config, videoId)
            .then((info) => {
              serveRelay(info, res)
            })
            .catch((err: unknown) => {
              res.status(502).json({
                error: `failed to resolve position: ${(err as Error).message}`,
              })
              if (err instanceof YtdlpError && err.stderr.length > 0) {
                logger.error(err.stderr)
              }
            })
          return
        }

        resolveVideoInfoFor(config, videoId)
          .then((info) => {
            const effectiveMode = info.isLive
              ? config.liveDeliveryMode
              : config.mediaDeliveryMode

            switch (effectiveMode) {
              case 'redirect': {
                redirectToYoutube(res, videoId)
                return
              }
              case 'relay': {
                serveRelay(info, res)
                return
              }
              case 'proxy': {
                if (info.isLive) {
                  serveLiveProxy(config, playlistId, position, videoId, res)
                } else {
                  serveVodProxy(config, videoId, res)
                }
                return
              }
              case 'hybrid': {
                // liveDeliveryMode は "hybrid" を許容しないため (config.ts のバリデーション)、
                // effectiveMode が "hybrid" になるのは info.isLive === false の場合のみ。
                const cachedPath = getFreshOrStale(config, videoId)
                if (cachedPath) {
                  res.sendFile(path.resolve(cachedPath))
                  return
                }
                triggerBackgroundDownload(config, videoId)
                if (info.hlsMasterManifestUrl) {
                  res.redirect(302, info.hlsMasterManifestUrl)
                } else {
                  redirectToYoutube(res, videoId)
                }
              }
            }
          })
          .catch((err: unknown) => {
            res.status(502).json({
              error: `failed to resolve position: ${(err as Error).message}`,
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
