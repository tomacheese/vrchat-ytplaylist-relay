import { logger } from './logger'
import type { RunYtdlpOptions } from './ytdlp'
import { resolveVideoJson } from './ytdlp'

/** yt-dlp -j の結果から抽出する、配信方式の決定に必要な最小限の情報。 */
export interface ResolvedVideoInfo {
  isLive: boolean
  /**
   * 配信に使う HLS manifest URL。音声トラックを含む AVC1 (H.264) の legacy TS variant のうち
   * 最高画質のものを優先し、無ければ YouTube 生の HLS master manifest URL にフォールバックする
   * (`extractHlsMasterManifestUrl` 参照)。取得できなければ null。
   */
  hlsMasterManifestUrl: string | null
  /**
   * `hlsMasterManifestUrl` が master manifest そのもの (音声込みの単一 variant を選べなかった) 場合 true。
   * relay モードの VOD 配信では、この master の AVC1 variant と音声 rendition から segment 単位で ffmpeg により音声込みの MPEG-TS に多重化して配信する (`vod-relay.ts`)。
   */
  hlsIsMaster: boolean
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
const inFlightResolutions = new Map<string, Promise<ResolvedVideoInfo>>()

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
 * legacy TS variant には映像のみ (音声トラックを持たない) のものも存在するため、
 * `acodec` が `'none'` (yt-dlp が音声なしフォーマットに付与する値) の候補は除外し、
 * 音声付き variant のみを選択対象にする。除外しないと画質優先の比較で
 * 音声なし variant が選ばれてしまい、relay モードの再生で音声が無くなる。
 *
 * 候補が無ければ、最初に見つかった `manifest_url` (AVC1 以外を含む master manifest) にフォールバックし
 * `{ url, isMaster: true }` を返す。ただし master に AVC1 の variant が 1 つも無い場合は
 * `isMaster: false` とし、呼び出し側は従来どおりこの URL へ 302 する (絞り込みの対象が無いため)。
 * VOD で AVC1 の variant があるのに音声込みでない場合は `isMaster: true` で、呼び出し側が
 * AVC1 + 音声のみに絞って segment 単位で多重化する (`hls-filter.ts` / `vod-relay.ts`)。
 * 多重化されない場合 (AVC1 が無い、または Live) のフォールバック時は `videoId` とともに警告ログを
 * 出力する (既知の再生不具合を踏む可能性があるため運用上検知できるようにする)。
 */
function extractHlsMasterManifestUrl(
  videoId: string,
  formats: unknown,
  isLive: boolean
): { url: string | null; isMaster: boolean } {
  if (!Array.isArray(formats)) return { url: null, isMaster: false }

  let bestAvc1Url: string | null = null
  let bestAvc1Height = -1
  let fallbackManifestUrl: string | null = null
  let hasAvc1 = false

  for (const format of formats) {
    if (typeof format !== 'object' || format === null) continue
    const {
      protocol,
      manifest_url: manifestUrl,
      vcodec,
      acodec,
      url,
      height,
    } = format as {
      protocol?: unknown
      manifest_url?: unknown
      vcodec?: unknown
      acodec?: unknown
      url?: unknown
      height?: unknown
    }
    if (protocol !== 'm3u8_native') continue

    if (typeof manifestUrl === 'string' && fallbackManifestUrl === null) {
      fallbackManifestUrl = manifestUrl
    }

    if (typeof vcodec === 'string' && vcodec.startsWith('avc1')) hasAvc1 = true

    if (
      acodec !== 'none' &&
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

  if (
    bestAvc1Url === null &&
    fallbackManifestUrl !== null &&
    (!hasAvc1 || isLive)
  ) {
    logger.warn(
      `No AVC1 HLS variant found for video ${videoId}; falling back to the raw master manifest URL (may hit the known VRChat/AVPro playback issue)`
    )
  }

  return bestAvc1Url === null
    ? {
        url: fallbackManifestUrl,
        isMaster: fallbackManifestUrl !== null && hasAvc1,
      }
    : { url: bestAvc1Url, isMaster: false }
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

  const inFlight = inFlightResolutions.get(videoId)
  if (inFlight) return inFlight

  const promise = (async () => {
    const raw = (await resolveVideoJson(videoId, options)) as YtdlpVideoJson
    const isLive = raw.is_live === true
    const hls = extractHlsMasterManifestUrl(videoId, raw.formats, isLive)
    const info: ResolvedVideoInfo = {
      isLive,
      hlsMasterManifestUrl: hls.url,
      hlsIsMaster: hls.isMaster,
    }
    resolveCache.set(videoId, { info, fetchedAt: Date.now() })
    return info
  })()
  inFlightResolutions.set(videoId, promise)
  try {
    return await promise
  } finally {
    if (inFlightResolutions.get(videoId) === promise) {
      inFlightResolutions.delete(videoId)
    }
  }
}

/** テスト用: キャッシュを空にする。 */
export function clearResolveCache(): void {
  resolveCache.clear()
  inFlightResolutions.clear()
}
