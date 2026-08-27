import { Router } from 'express'
import type { AppConfig } from '../config'
import { loadSlotState } from '../manifest-store'
import { peekCachedManifest } from '../refresh'
import type { HealthPlaylistStatus, HealthResponse } from '../types'

export function healthRouter(config: AppConfig): Router {
  const router = Router()

  router.get('/health', (_req, res) => {
    const playlists: Record<string, HealthPlaylistStatus> = {}
    let degraded = false

    for (const entry of config.playlists) {
      const state = loadSlotState(config.dataDir, entry.playlistId)
      // trackCount は Disk に永続化していないため、メモリキャッシュ (無ければ 0) から拾う。
      const trackCount =
        peekCachedManifest(entry.playlistId)?.tracks.length ?? 0

      if (!state) {
        playlists[entry.playlistId] = {
          status: 'unknown',
          generation: 0,
          trackCount,
          lastRefreshAt: null,
          lastError: null,
        }
        degraded = true
        continue
      }
      const status: HealthPlaylistStatus = {
        status: state.lastRefreshOk ? 'ok' : 'error',
        generation: state.generation,
        trackCount,
        lastRefreshAt: state.lastRefreshAt,
        lastError: state.lastError,
      }
      if (!state.lastRefreshOk) degraded = true
      playlists[entry.playlistId] = status
    }

    const response: HealthResponse = {
      status: degraded ? 'degraded' : 'ok',
      updatedAt: Date.now(),
      playlists,
    }
    res.status(200).json(response)
  })

  return router
}
