import crypto from 'node:crypto'
import { Router } from 'express'
import type { AppConfig } from '../config'
import { refreshAll, refreshPlaylist } from '../refresh'

/**
 * Compares the `Authorization` header with the expected value in constant time.
 * A `!==` string comparison stops at the first mismatch, so the comparison time could reveal
 * how many leading characters matched (timing attack).
 */
function timingSafeEqualString(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual)
  const expectedBuf = Buffer.from(expected)
  // crypto.timingSafeEqual throws when buffer lengths differ, so treat a length mismatch as false
  // up front (this leaks timing asymmetrically, which is acceptable in practice).
  if (actualBuf.length !== expectedBuf.length) return false
  return crypto.timingSafeEqual(actualBuf, expectedBuf)
}

/**
 * Admin endpoints. Authentication (ADMIN_TOKEN) is required, keeping a separate auth boundary
 * from the public Manifest / Media Endpoints. The VRChat World must not call these
 * (putting ADMIN_TOKEN in the World via a VRCUrl would itself risk leaking it).
 *
 * Manifests are fetched on client request with a TTL cache (`getManifestForClient`), so normal
 * operation never needs this endpoint. An admin uses it only to force-invalidate the cache and
 * reflect the latest Playlist contents immediately without waiting for the TTL.
 */
export function adminRouter(config: AppConfig): Router {
  const router = Router()

  // Pass "/admin" explicitly. A path-less router.use() matches every request in this Router, and since
  // it is mounted at the app root it would also catch the later public manifest/media endpoints and return 401.
  router.use('/admin', (req, res, next) => {
    if (!config.adminToken) {
      res.status(403).json({
        error: 'admin endpoints are disabled (ADMIN_TOKEN is not set)',
      })
      return
    }
    const header = req.header('authorization') ?? ''
    const expected = `Bearer ${config.adminToken}`
    if (!timingSafeEqualString(header, expected)) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    next()
  })

  router.post('/admin/refresh', (_req, res, next) => {
    // Express 4 handlers are expected to return void, so the function passed to the Router is not async;
    // errors are handled by .catch(next) at the end of the Promise chain (avoids no-misused-promises).
    refreshAll(config)
      .then((results) => {
        const ok = results.every((r) => r.ok)
        res.status(ok ? 200 : 207).json({ results })
      })
      .catch(next)
  })

  router.post('/admin/refresh/:playlistId', (req, res, next) => {
    refreshPlaylist(config, req.params.playlistId)
      .then((result) => {
        res.status(result.ok ? 200 : 502).json(result)
      })
      .catch(next)
  })

  return router
}
