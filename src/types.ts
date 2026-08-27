/** 設定ファイル (config/playlists.json) に記述する Playlist 定義 */
export interface PlaylistConfigEntry {
  /** YouTube Playlist の `list` query parameter値。Manifest / Media Endpoint の URL segment としても使う。 */
  playlistId: string
  /** 管理用の表示名。Manifest には含めない (VRChat World 側は playlistId でしか Playlist を識別しないため不要)。 */
  displayName?: string
  /** この Playlist 専用の Position Pool 上限。省略時は DEFAULT_MAX_SLOTS を使う。 */
  maxSlots?: number
}

export interface ServerConfig {
  playlists: PlaylistConfigEntry[]
}

/** yt-dlp --flat-playlist -J が返す entry の必要フィールドのみ */
export interface YtdlpFlatEntry {
  id: string
  title: string | null
  duration: number | null
}

/**
 * Backend が Disk に永続化する Playlist ごとの Position Pool 状態。
 *
 * Track の並び・Title など Playlist の実際の内容は含まない。それらは Client からの要求時に
 * 都度 yt-dlp で取得し、メモリ上の TTL キャッシュにのみ載せる ({@link module:refresh} 参照)。
 * ここに永続化するのは、Redirect Pool の URL 意味が変化しないよう immutable に保つ必要がある
 * videoId <-> slot の対応表と、Client 側の変更検知に使う generation のみ。
 */
export interface SlotAllocationState {
  playlistId: string
  /** Manifest 内容 (順序 + Title) が変化するたびに増分する。 */
  generation: number
  /** 次に割り当てる未使用 slot 番号 */
  nextSlot: number
  maxSlots: number
  /** videoId -> slot (immutable / 使い回し禁止) */
  videoIdToSlot: Record<string, number>
  /** slot -> videoId (Media Redirect Endpoint 用) */
  slotToVideoId: Record<string, string>
  /**
   * 直近成功時点の Track 内容 (順序 + videoId + Title) から計算した hash。
   * これを Track 内容そのものの代わりに永続化することで、Playlist の実データを Disk に
   * 残さずに generation 更新要否 (内容が変わったかどうか) だけを判定できる。
   */
  contentHash: string | null
  lastRefreshAt: number | null
  lastRefreshOk: boolean
  lastError: string | null
}

/** 公開 Manifest (`/{playlistId}/manifest.json` のレスポンス形式) */
export interface ManifestTrack {
  position: number
  title: string
}

export interface Manifest {
  playlistId: string
  generation: number
  updatedAt: number
  tracks: ManifestTrack[]
}

export interface HealthPlaylistStatus {
  status: 'ok' | 'error' | 'unknown'
  generation: number
  trackCount: number
  lastRefreshAt: number | null
  lastError: string | null
}

export interface HealthResponse {
  status: 'ok' | 'degraded'
  updatedAt: number
  playlists: Record<string, HealthPlaylistStatus>
}
