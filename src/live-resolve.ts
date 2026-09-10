import { logger } from './logger'
import type { RunYtdlpOptions } from './ytdlp'
import { resolveVideoJson } from './ytdlp'

/** yt-dlp -j の結果から抽出する、配信方式の決定に必要な最小限の情報。 */
export interface ResolvedVideoInfo {
  isLive: boolean
  /**
   * 配信に使う HLS manifest URL。AVC1 (H.264) の legacy TS variant のうち最高画質のものを
   * 優先し、無ければ YouTube 生の HLS master manifest URL にフォールバックする
   * (`extractHlsMasterManifestUrl` 参照)。取得できなければ null。
   */
  hlsMasterManifestUrl: string | null
}

/** `resolveVideoInfo` の解決結果キャッシュエントリ。 */
interface CacheEntry {
  info: ResolvedVideoInfo
  fetchedAt: number
}

/**
 * videoId ごとの解決結果キャッシュ。`refresh.ts` の `manifestCache` と同じ形 (Map + fetchedAt) で、
 * TTL 内は yt-dlp を再実行しない (モード混在時に高頻度アクセスされる position での yt-dlp 負荷を抑えるため)。
 */
const resolveCache = new Map<string, CacheEntry>()

/** yt-dlp -j の JSON 出力から Live 判定に必要な最小限のフィールドのみを受け取る型。 */
interface YtdlpVideoJson {
  is_live?: unknown
  formats?: unknown
}

/**
 * `formats[]` から、VRChat (AVPro Video / Windows MediaFoundation) で安定して再生できる
 * AVC1 (H.264) の legacy TS variant のうち最高画質の URL を選ぶ。YouTube 生の HLS master
 * manifest (複数画質・複数コーデックの variant を含む multivariant playlist) をそのまま
 * 渡すと、variant の選択が VRChat 同梱 yt-dlp / AVPro 側のロジックに委ねられる。その結果、
 * VP9 + fMP4/CMAF の variant が選ばれて再生できないことがある (VRChat 公式フィードバックの
 * 場で報告されている既知の不具合)。そのためサーバー側で単一 variant に確定させ、この
 * 壊れやすい選択ロジックをバイパスする。
 *
 * 候補が無ければ、既存の挙動 (最初に見つかった `manifest_url`、AVC1 以外を含む master
 * manifest) にフォールバックする。フォールバック発生時は `videoId` とともに警告ログを
 * 出力する (既知の再生不具合を踏む可能性があるため運用上検知できるようにする)。
 */
function extractHlsMasterManifestUrl(
  videoId: string,
  formats: unknown
): string | null {
  if (!Array.isArray(formats)) return null

  let bestAvc1Url: string | null = null
  let bestAvc1Height = -1
  let fallbackManifestUrl: string | null = null

  for (const format of formats) {
    if (typeof format !== 'object' || format === null) continue
    const {
      protocol,
      manifest_url: manifestUrl,
      vcodec,
      url,
      height,
    } = format as {
      protocol?: unknown
      manifest_url?: unknown
      vcodec?: unknown
      url?: unknown
      height?: unknown
    }
    if (protocol !== 'm3u8_native') continue

    if (fallbackManifestUrl === null && typeof manifestUrl === 'string') {
      fallbackManifestUrl = manifestUrl
    }

    if (
      typeof url === 'string' &&
      typeof height === 'number' &&
      typeof vcodec === 'string' &&
      vcodec.startsWith('avc1') &&
      height > bestAvc1Height
    ) {
      bestAvc1Url = url
      bestAvc1Height = height
    }
  }

  if (bestAvc1Url === null && fallbackManifestUrl !== null) {
    logger.warn(
      `No AVC1 HLS variant found for video ${videoId}; falling back to the raw master manifest URL (may hit the known VRChat/AVPro playback issue)`
    )
  }

  return bestAvc1Url ?? fallbackManifestUrl
}

/**
 * videoId を yt-dlp (`-j`, `--no-playlist`) で解決し、Live 判定と HLS master manifest URL を取得する。
 * `relay` モード (VOD/Live 共通) と、Live 判定自体が必要な場面 (`mediaDeliveryMode !== liveDeliveryMode`
 * のとき) の両方から呼ばれる。
 *
 * 同一 videoId への `cacheTtlMs` 内の連続呼び出しは yt-dlp を 1 回しか実行しない。yt-dlp 実行が
 * 失敗した場合は例外をそのまま呼び出し元に伝播し、キャッシュにも格納しない
 * (一時的なエラーで長時間 502 を吐き続けないようにするため)。
 */
export async function resolveVideoInfo(
  videoId: string,
  options: RunYtdlpOptions & { cacheTtlMs: number }
): Promise<ResolvedVideoInfo> {
  const cached = resolveCache.get(videoId)
  if (cached && Date.now() - cached.fetchedAt < options.cacheTtlMs) {
    return cached.info
  }

  const raw = (await resolveVideoJson(videoId, options)) as YtdlpVideoJson
  const info: ResolvedVideoInfo = {
    isLive: raw.is_live === true,
    hlsMasterManifestUrl: extractHlsMasterManifestUrl(videoId, raw.formats),
  }
  resolveCache.set(videoId, { info, fetchedAt: Date.now() })
  return info
}

/** テスト用: キャッシュを空にする。 */
export function clearResolveCache(): void {
  resolveCache.clear()
}
