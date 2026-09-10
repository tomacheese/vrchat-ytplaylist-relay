import type { RunYtdlpOptions } from './ytdlp'
import { resolveVideoJson } from './ytdlp'

/** yt-dlp -j の結果から抽出する、配信方式の決定に必要な最小限の情報。 */
export interface ResolvedVideoInfo {
  isLive: boolean
  /** HLS master manifest URL (video/audio 両方の variant を含む)。取得できなければ null。 */
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
 * `formats[]` を走査し、`protocol === 'm3u8_native'` かつ `manifest_url` が truthy な
 * 最初のエントリの `manifest_url` を返す。VOD・Live いずれでも各 format の manifest_url は
 * 同一の HLS master manifest URL を指すため、先頭 1 件で良い。
 */
function extractHlsMasterManifestUrl(formats: unknown): string | null {
  if (!Array.isArray(formats)) return null
  for (const format of formats) {
    if (typeof format !== 'object' || format === null) continue
    const { protocol, manifest_url: manifestUrl } = format as {
      protocol?: unknown
      manifest_url?: unknown
    }
    if (protocol === 'm3u8_native' && typeof manifestUrl === 'string') {
      return manifestUrl
    }
  }
  return null
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
    hlsMasterManifestUrl: extractHlsMasterManifestUrl(raw.formats),
  }
  resolveCache.set(videoId, { info, fetchedAt: Date.now() })
  return info
}

/** テスト用: キャッシュを空にする。 */
export function clearResolveCache(): void {
  resolveCache.clear()
}
