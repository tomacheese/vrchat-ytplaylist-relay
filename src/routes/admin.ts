import crypto from 'node:crypto'
import { Router } from 'express'
import type { AppConfig } from '../config'
import { refreshAll, refreshPlaylist } from '../refresh'

/**
 * `Authorization` ヘッダーと期待値を一定時間で比較する。
 * `!==` による文字列比較は不一致が判明した時点で処理を打ち切るため、比較にかかる時間から
 * 先頭何文字まで一致していたかを推測される (timing attack) リスクがある。
 */
function timingSafeEqualString(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual)
  const expectedBuf = Buffer.from(expected)
  // crypto.timingSafeEqual はバッファ長が異なると例外を投げるため、長さの不一致も
  // ここで先に (それ自体は非対称なタイミングになるが実用上問題ない) false 扱いにする。
  if (actualBuf.length !== expectedBuf.length) return false
  return crypto.timingSafeEqual(actualBuf, expectedBuf)
}

/**
 * 管理 Endpoint。Authentication (ADMIN_TOKEN) 必須で、Public な Manifest / Media Endpoint とは
 * 認証境界を分離する。VRChat World からはこの Endpoint を呼び出さない
 * (VRCUrl 経由で ADMIN_TOKEN を World 側に置くこと自体が漏洩リスクになるため)。
 *
 * Manifest は Client からの要求に応じて TTL キャッシュ付きで取得するため (`getManifestForClient`)、
 * 通常運用でこの Endpoint を呼ぶ必要はない。TTL 経過を待たずにキャッシュを強制的に無効化して
 * 最新の Playlist 内容を即座に反映させたい場合にのみ管理者が使う。
 */
export function adminRouter(config: AppConfig): Router {
  const router = Router()

  // "/admin" を明示的に指定する。パス省略の router.use() は Router 内の全リクエストにマッチし、
  // この Router が app root にマウントされている都合上、後続の manifest/media (公開 Endpoint) まで
  // 巻き込んで 401 を返してしまう。
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
    // Express 4 のハンドラーは void を期待するため、Router に渡す関数自体は async にせず
    // Promise Chain の末尾 .catch(next) でエラーを処理する (no-misused-promises 対策)。
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
