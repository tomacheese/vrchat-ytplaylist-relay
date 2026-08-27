import type { AppConfig } from './config'
import { isPlaylistAllowed, maxSlotsFor } from './config'
import { logger } from './logger'
import { KeyedMutex } from './lock'
import { prefetchAll } from './media-cache'
import {
  buildManifest,
  listKnownPlaylistIds,
  loadSlotState,
  persistSlotState,
  recordFailure,
} from './manifest-store'
import type { Manifest } from './types'
import { fetchPlaylistEntries } from './ytdlp'

const refreshMutex = new KeyedMutex()

/**
 * playlistId ごとの実行中 Refresh を single-flight にするための Map。
 * `KeyedMutex` は同一 playlistId の実行を直列化するだけで重複排除はしないため、
 * これが無いと同一 playlistId への同時リクエストの数だけ yt-dlp が (直列に) 繰り返し
 * 実行されてしまう (未解決 position への同時アクセスなど)。
 */
const inFlightRefreshes = new Map<string, Promise<RefreshResult>>()

/** playlistId ごとの直近取得 Manifest。Playlist の実データは Disk に永続化せず、ここ (メモリ) にのみ保持する。 */
interface CacheEntry {
  manifest: Manifest
  fetchedAt: number
}

/** メモリ上の Manifest キャッシュ。Process 再起動でクリアされる。 */
const manifestCache = new Map<string, CacheEntry>()

/** 1 Playlist の Refresh 結果。`ok: false` の場合は `error` に失敗理由が入る。 */
export interface RefreshResult {
  playlistId: string
  ok: boolean
  generation?: number
  trackCount?: number
  error?: string
}

/** {@link refreshPlaylist} の実処理本体 (single-flight の Map 管理から分離)。 */
function runRefresh(
  config: AppConfig,
  playlistId: string
): Promise<RefreshResult> {
  return refreshMutex.run(playlistId, async () => {
    const maxSlots = maxSlotsFor(config, playlistId)
    const now = Date.now()
    try {
      const entries = await fetchPlaylistEntries(playlistId, {
        ytdlpPath: config.ytdlpPath,
        timeoutMs: config.ytdlpTimeoutMs,
      })
      const previous = loadSlotState(config.dataDir, playlistId)
      const { state, manifest } = buildManifest(
        previous,
        playlistId,
        maxSlots,
        entries,
        now
      )
      persistSlotState(config.dataDir, state)
      manifestCache.set(playlistId, { manifest, fetchedAt: now })
      logger.info(
        `refreshed ${playlistId}: generation=${state.generation} tracks=${entries.length}`
      )

      if (config.deliveryMode === 'proxy' || config.deliveryMode === 'hybrid') {
        // Response Blocking を避けるため await しない。失敗は prefetchAll 内部でログするだけで、
        // 冷キャッシュ時は Media Endpoint 側 (getOrDownload / hybrid の redirect フォールバック) が
        // 改めてダウンロードするため機能に影響しない。
        // 末尾の .catch() で例外を処理しているため no-floating-promises 上も未処理 Promise 扱いにならない。
        prefetchAll(
          config,
          entries.map((entry) => entry.id)
        ).catch((err: unknown) => {
          logger.error(
            `prefetch failed for ${playlistId}: ${(err as Error).message}`
          )
        })
      }

      return {
        playlistId,
        ok: true,
        generation: state.generation,
        trackCount: entries.length,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`refresh failed for ${playlistId}: ${message}`)
      recordFailure(config.dataDir, playlistId, maxSlots, message, now)
      return { playlistId, ok: false, error: message }
    }
  })
}

/**
 * yt-dlp を実行して 1 Playlist を実際に取得し、Position Pool (slots.json) とメモリキャッシュを
 * 更新する。TTL に関係なく必ず yt-dlp を実行するため、Client 要求時の都度取得 ({@link getManifestForClient})
 * と 管理者による強制更新 (`/admin/refresh`, CLI) の両方から呼ばれる。
 * 同一 playlistId の実行は KeyedMutex で直列化しつつ、`inFlightRefreshes` により single-flight
 * (既に実行中の Promise を後続の呼び出しへそのまま返す) にする。
 * 失敗時は Position Pool 状態 / メモリキャッシュを変更せず、失敗情報だけ記録する。
 */
export async function refreshPlaylist(
  config: AppConfig,
  playlistId: string
): Promise<RefreshResult> {
  if (!isPlaylistAllowed(config, playlistId)) {
    return { playlistId, ok: false, error: `Unknown playlistId: ${playlistId}` }
  }

  const inFlight = inFlightRefreshes.get(playlistId)
  if (inFlight) return inFlight

  const promise = runRefresh(config, playlistId).finally(() => {
    inFlightRefreshes.delete(playlistId)
  })
  inFlightRefreshes.set(playlistId, promise)
  return promise
}

/**
 * 一括 Refresh の対象 playlistId 一覧を求める。
 * allowlist (`config.playlists`) が設定されていればそれを使い、無効 (空) の場合は
 * 事前登録が無いため、代わりに Position Pool 状態が永続化済みの (＝一度でも Refresh に
 * 成功した) playlistId を対象にする。メモリキャッシュ (`manifestCache`) ではなく Disk 上の
 * 状態を見るのは、`pnpm refresh` CLI が Server と別プロセスで動きメモリを共有しないため。
 */
function refreshAllTargets(config: AppConfig): string[] {
  if (config.playlists.length > 0) {
    return config.playlists.map((entry) => entry.playlistId)
  }
  return listKnownPlaylistIds(config.dataDir)
}

/**
 * 一括 Refresh の対象 ({@link refreshAllTargets}) を順に Refresh する。
 * 1 件の失敗は他の Playlist の Refresh を妨げない。
 * `/admin/refresh` (キャッシュ強制無効化・再取得用) と CLI から使う。
 */
export async function refreshAll(config: AppConfig): Promise<RefreshResult[]> {
  const results: RefreshResult[] = []
  for (const playlistId of refreshAllTargets(config)) {
    // 直列実行にする: yt-dlp を同時に何本も立てて YouTube 側のレート制限を踏むのを避ける。
    results.push(await refreshPlaylist(config, playlistId))
  }
  return results
}

/**
 * Client からの `GET /:playlistId/manifest.json` に応答するための Manifest を返す。
 *
 * - メモリキャッシュが TTL 内であれば yt-dlp を実行せずそのまま返す。
 * - TTL 切れ、または未取得の場合は yt-dlp を実行して新しい Manifest を取得する。
 * - yt-dlp が失敗した場合、直前のキャッシュが残っていればそれを stale のまま返す
 *   (Manifest Fetch 失敗時も World 側は「現在の Playlist を維持」できるようにするため)。
 *   キャッシュが一度も無い場合は manifest: null を返す (呼び出し側は 503 を返すこと)。
 *
 * @param playlistId 呼び出し前に config.playlists に存在することを確認しておくこと
 */
export async function getManifestForClient(
  config: AppConfig,
  playlistId: string
): Promise<{ manifest: Manifest | null; error?: string }> {
  const cached = manifestCache.get(playlistId)
  if (cached && Date.now() - cached.fetchedAt < config.manifestCacheTtlMs) {
    return { manifest: cached.manifest }
  }

  const result = await refreshPlaylist(config, playlistId)
  if (result.ok) {
    // refreshPlaylist 成功時は manifestCache が更新済みのはず。
    const fresh = manifestCache.get(playlistId)
    return { manifest: fresh?.manifest ?? null }
  }

  if (cached) {
    logger.warn(
      `serving stale cached manifest for ${playlistId} after refresh failure: ${result.error}`
    )
    return { manifest: cached.manifest, error: result.error }
  }
  return { manifest: null, error: result.error }
}

/**
 * Media Endpoint (`GET /:playlistId/:position.mp4`) 用に、Position から videoId を解決する。
 * 永続化済み Position Pool 状態にまだ無い場合 (初回リクエスト、Position Pool 状態の消失など) は
 * Manifest Endpoint と同様に Refresh (yt-dlp 実行) を試みてから再解決する。
 * 直近 `manifestCacheTtlMs` 以内に Refresh 済みで解決できなかった場合は、無効な position への
 * 繰り返しリクエストで yt-dlp を連打しないよう Refresh を再試行しない。
 * `reason` は `refreshPlaylist` の失敗による一時的な未解決 (`refresh_failed`) と、
 * Playlist に本当に存在しない position (`not_found`) を呼び出し側 (Router) が区別できるようにする。
 */
export async function resolveVideoIdForPosition(
  config: AppConfig,
  playlistId: string,
  position: number
): Promise<
  | { videoId: string }
  | { error: string; reason: 'not_found' | 'refresh_failed' }
> {
  const state = loadSlotState(config.dataDir, playlistId)
  const videoId = state?.slotToVideoId[String(position)]
  if (videoId) return { videoId }

  const recentlyRefreshed =
    state?.lastRefreshAt !== null &&
    state?.lastRefreshAt !== undefined &&
    Date.now() - state.lastRefreshAt < config.manifestCacheTtlMs
  if (recentlyRefreshed) {
    if (!state.lastRefreshOk && state.lastError) {
      return { error: state.lastError, reason: 'refresh_failed' }
    }
    return { error: 'unknown position', reason: 'not_found' }
  }

  const result = await refreshPlaylist(config, playlistId)
  if (!result.ok) {
    return { error: result.error ?? 'refresh failed', reason: 'refresh_failed' }
  }

  const refreshed = loadSlotState(config.dataDir, playlistId)
  const refreshedVideoId = refreshed?.slotToVideoId[String(position)]
  if (!refreshedVideoId) {
    return { error: 'unknown position', reason: 'not_found' }
  }
  return { videoId: refreshedVideoId }
}

/** キャッシュ済み Manifest を yt-dlp を実行せずに覗き見る (`/health` の trackCount 表示用)。 */
export function peekCachedManifest(playlistId: string): Manifest | null {
  return manifestCache.get(playlistId)?.manifest ?? null
}

/** Test 用: yt-dlp を経由せずメモリキャッシュへ直接 Manifest を投入する。 */
export function primeManifestCacheForTests(
  playlistId: string,
  manifest: Manifest,
  fetchedAt: number = Date.now()
): void {
  manifestCache.set(playlistId, { manifest, fetchedAt })
}
