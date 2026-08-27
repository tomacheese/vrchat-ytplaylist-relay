import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import type { AppConfig } from '../src/config'
import { buildManifest, persistSlotState } from '../src/manifest-store'
import {
  getManifestForClient,
  primeManifestCacheForTests,
  refreshAll,
  resolveVideoIdForPosition,
} from '../src/refresh'
import type { Manifest } from '../src/types'

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-refresh-test-'))
}

function baseConfig(
  playlistId: string,
  overrides: Partial<AppConfig> = {}
): AppConfig {
  return {
    port: 0,
    configPath: 'test-config',
    dataDir: tempDataDir(),
    adminToken: null,
    // 実在しないコマンドを指す: このテストでは yt-dlp が実際に起動されないこと、
    // または起動が失敗として扱われることを検証する。
    ytdlpPath: 'yt-dlp-does-not-exist',
    defaultMaxSlots: 100,
    ytdlpTimeoutMs: 1000,
    manifestCacheTtlMs: 60_000,
    deliveryMode: 'redirect',
    mediaMaxHeight: 1080,
    mediaCacheDir: tempDataDir(),
    mediaCacheMaxBytes: 10 * 1024 * 1024 * 1024,
    mediaCacheTtlMs: 6 * 60 * 60 * 1000,
    mediaDownloadTimeoutMs: 600_000,
    playlists: [{ playlistId }],
    ...overrides,
  }
}

function manifest(playlistId: string): Manifest {
  return {
    playlistId,
    generation: 1,
    updatedAt: 1000,
    tracks: [{ position: 0, title: 'Track 1' }],
  }
}

test('getManifestForClient returns the cached manifest within TTL without invoking yt-dlp', async () => {
  const config = baseConfig('pl-fresh-cache')
  primeManifestCacheForTests(
    'pl-fresh-cache',
    manifest('pl-fresh-cache'),
    Date.now()
  )

  const result = await getManifestForClient(config, 'pl-fresh-cache')

  assert.equal(result.error, undefined)
  assert.deepEqual(result.manifest, manifest('pl-fresh-cache'))
})

test('getManifestForClient serves the stale cached manifest when yt-dlp fails after TTL expiry', async () => {
  const config = baseConfig('pl-stale-cache', { manifestCacheTtlMs: 1 })
  const stale = manifest('pl-stale-cache')
  primeManifestCacheForTests('pl-stale-cache', stale, Date.now() - 10_000)

  const result = await getManifestForClient(config, 'pl-stale-cache')

  assert.deepEqual(
    result.manifest,
    stale,
    'stale manifest must still be served on refresh failure'
  )
  assert.ok(result.error, 'refresh failure reason should be surfaced')
})

test('getManifestForClient returns null when there is no cache and yt-dlp fails', async () => {
  const config = baseConfig('pl-no-cache')

  const result = await getManifestForClient(config, 'pl-no-cache')

  assert.equal(result.manifest, null)
  assert.ok(result.error)
})

test('refreshAll targets playlistIds with persisted slot state when the allowlist is empty', async () => {
  const config = baseConfig('unused', { playlists: [] })
  // pnpm refresh CLI は Server と別プロセスで動きメモリキャッシュを共有しないため、
  // refreshAllTargets の判定材料は Disk 上の Position Pool 状態でなければならない。
  const { state } = buildManifest(
    null,
    'pl-seen-before',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(config.dataDir, state)

  const results = await refreshAll(config)

  assert.ok(
    results.some((r) => r.playlistId === 'pl-seen-before'),
    'a playlistId with persisted slot state must still be refreshed without a predefined allowlist'
  )
})

test('resolveVideoIdForPosition triggers a refresh when slot state does not exist yet', async () => {
  const config = baseConfig('pl-cold-start')

  const result = await resolveVideoIdForPosition(config, 'pl-cold-start', 0)

  assert.ok(
    'error' in result,
    'yt-dlp-does-not-exist の baseConfig では Refresh が失敗するはず'
  )
})

test('resolveVideoIdForPosition resolves the videoId once slot state is persisted', async () => {
  const config = baseConfig('pl-known-position')
  const { state } = buildManifest(
    null,
    'pl-known-position',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(config.dataDir, state)

  const result = await resolveVideoIdForPosition(
    config,
    'pl-known-position',
    0
  )

  assert.deepEqual(result, { videoId: 'v1' })
})

test('resolveVideoIdForPosition does not retry refresh within manifestCacheTtlMs after a recent refresh', async () => {
  const config = baseConfig('pl-recent-refresh', {
    manifestCacheTtlMs: 60_000,
  })
  const { state } = buildManifest(
    null,
    'pl-recent-refresh',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  // lastRefreshAt を「直近」に設定した状態で永続化する。
  persistSlotState(config.dataDir, { ...state, lastRefreshAt: Date.now() })

  // position 1 は存在しない。直近 Refresh 済みのため Refresh は再試行されないはずで、
  // その場合 error は必ず 'unknown position' になる (Refresh が走れば
  // 'yt-dlp-does-not-exist' に起因する別のエラーメッセージになるため区別できる)。
  const result = await resolveVideoIdForPosition(
    config,
    'pl-recent-refresh',
    1
  )

  assert.deepEqual(result, { error: 'unknown position' })
})
