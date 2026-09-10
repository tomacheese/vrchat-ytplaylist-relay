import path from 'node:path'
import type { Response } from 'express'
import type { AppConfig } from './config'
import { ensureLiveRelay } from './live-relay'
import { resolveVideoInfo } from './live-resolve'
import type { ResolvedVideoInfo } from './live-resolve'
import {
  getFreshOrStale,
  getOrDownload,
  triggerBackgroundDownload,
} from './media-cache'
import { logger } from './logger'
import { YtdlpError } from './ytdlp'

/**
 * Live proxy モードでの再公開ファイル配信ルートへの Redirect URL を組み立てるための情報。
 * `buildRedirectPath` は組み立てに失敗した場合 (例: `media.ts` 側の `PLAYLIST_ID_PATTERN`
 * 再検証失敗) に `null` を返してよい。
 * その場合 `resolveAndServe` は 404 (`{ error: 'unknown playlistId' }`) を返す。
 */
export interface LiveProxyTarget {
  buildRedirectPath: (playlistFileName: string) => string | null
}

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

/**
 * Live "proxy" 配信ロジック: ensureLiveRelay() で再公開を起動し、`liveProxyTarget` が組み立てる
 * Live 再公開ファイルの配信ルートへ 302 する。`buildRedirectPath` が `null` を返した場合
 * (呼び出し元の playlistId 再検証失敗など) は 404 を返す。
 */
function serveLiveProxy(
  config: AppConfig,
  videoId: string,
  liveProxyTarget: LiveProxyTarget,
  res: Response
): void {
  ensureLiveRelay(config, videoId)
    .then((result) => {
      if ('error' in result) {
        res.status(502).json({ error: result.error })
        return
      }
      const redirectPath = liveProxyTarget.buildRedirectPath(
        result.playlistFileName
      )
      if (redirectPath === null) {
        res.status(404).json({ error: 'unknown playlistId' })
        return
      }
      res.redirect(302, redirectPath)
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

/** "relay" 配信ロジック: 解決済みの HLS manifest URL (AVC1 優先) へ 302 する。解決に失敗していれば 502。 */
function serveRelay(info: ResolvedVideoInfo, res: Response): void {
  if (!info.hlsMasterManifestUrl) {
    res.status(502).json({ error: 'failed to resolve HLS manifest' })
    return
  }
  res.redirect(302, info.hlsMasterManifestUrl)
}

/**
 * videoId に対して config の配信方式判定 (redirect/relay/proxy/hybrid, VOD/Live 判定込み) を行い、
 * レスポンスを直接書き込む。`src/routes/media.ts` (Playlist/position 経由) と
 * `src/routes/video.ts` (videoId 直接指定) の両方から呼ばれる共有処理。
 *
 * `effectiveMode` ごとの挙動:
 * - "redirect": 動画バイト列を配信せず、解決した YouTube 動画へ 302 Redirect するだけ。
 *   VRChat の AVProVideoPlayer は youtube.com の URL をネイティブに解釈できるが、VRChat 同梱の
 *   制限付き yt-dlp が googlevideo.com 直リンクの解決に失敗し再生できないことがある。
 * - "relay": yt-dlp が解決した HLS manifest URL (AVC1 の単一 variant を優先し、無ければ
 *   YouTube 生の master manifest URL) へ 302 Redirect する。ffmpeg・ディスクキャッシュを
 *   使わないステートレスな配信方式 (VOD/Live 共通)。
 * - "proxy" (VOD): Backend 自身が yt-dlp で動画をダウンロード・キャッシュし (media-cache.ts)、
 *   バイト列を直接配信する。ダウンロード完了まで応答をブロックするため、Client 側の Timeout に
 *   間に合わないことがある。
 * - "proxy" (Live): Backend が ffmpeg で HLS をローカル再公開し (live-relay.ts)、`liveProxyTarget`
 *   が組み立てる Live 再公開ファイルの配信ルートへ 302 Redirect する。
 * - "hybrid" (VOD 専用。Live には指定できない): キャッシュ済みなら "proxy" と同様にバイト列を
 *   直接配信する。未キャッシュ (または TTL 切れ) の場合は応答をブロックせず、裏でダウンロードを
 *   開始しつつ即座に "relay" と同様の 302 応答を返す。
 *   解決に失敗した場合のみ "redirect" 相当の youtube.com へフォールバックする。
 *   Client が Timeout 後に再リクエストしてくる頃にはダウンロードが完了している想定。
 *
 * "proxy" (VOD) / "hybrid" いずれも、TTL 切れで再ダウンロード中の場合は直前まで有効だった完了済み
 * キャッシュファイルを ("stale-while-revalidate") そのまま配信し続ける (`getFreshOrStale`)。
 * この間はブロックや Redirect フォールバックを発生させない。
 * 再ダウンロードが完了すると次回以降のリクエストから新しいファイルに切り替わる。
 *
 * @param liveProxyTarget Live "proxy" モード時の再公開ファイル配信ルートへの Redirect URL 組み立て方法。
 *   呼び出し元 (Playlist/position 経由か videoId 直接指定か) によって Redirect 先のパスが異なるため、
 *   呼び出し側から注入する。
 */
export function resolveAndServe(
  config: AppConfig,
  videoId: string,
  liveProxyTarget: LiveProxyTarget,
  res: Response
): void {
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
            serveLiveProxy(config, videoId, liveProxyTarget, res)
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
}
