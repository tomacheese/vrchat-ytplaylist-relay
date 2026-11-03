/** Playlist definition written in the config file (config/playlists.json) */
export interface PlaylistConfigEntry {
  /** Value of the YouTube playlist's `list` query parameter. Also used as the URL segment of the manifest / media endpoints. */
  playlistId: string
  /** Display name for administration. Not included in the manifest (the VRChat world identifies playlists only by playlistId). */
  displayName?: string
  /** Position Pool limit for this playlist. Falls back to `defaultMaxSlots` in the config if omitted. */
  maxSlots?: number
}

export interface ServerConfig {
  playlists: PlaylistConfigEntry[]
}

/** Only the needed fields of an entry returned by `yt-dlp --flat-playlist -J` */
export interface YtdlpFlatEntry {
  id: string
  title: string | null
  duration: number | null
}

/**
 * Per-playlist Position Pool state the backend persists to disk.
 *
 * It does not include the playlist's actual contents such as track order and titles. Those are fetched
 * with yt-dlp on each client request and kept only in an in-memory TTL cache (see {@link module:refresh}).
 * Only what must stay immutable so the meaning of Redirect Pool URLs never changes is persisted here:
 * the videoId <-> slot mapping, and the generation clients use to detect changes.
 */
export interface SlotAllocationState {
  playlistId: string
  /** Incremented whenever the manifest contents (order + title) change. */
  generation: number
  /** Next unused slot number */
  nextSlot: number
  maxSlots: number
  /** videoId -> slot (immutable; slots must not be reused) */
  videoIdToSlot: Record<string, number>
  /** slot -> videoId (for the Media Redirect Endpoint) */
  slotToVideoId: Record<string, string>
  /**
   * Hash of the track contents (order + videoId + title) at the last success.
   * Persisting this instead of the contents lets us decide whether to bump generation
   * (whether the contents changed) without keeping the playlist's actual data on disk.
   */
  contentHash: string | null
  lastRefreshAt: number | null
  lastRefreshOk: boolean
  lastError: string | null
}

/** Public manifest (response shape of `/{playlistId}/manifest.json`) */
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
