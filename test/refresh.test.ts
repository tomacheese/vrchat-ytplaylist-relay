import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, vi } from 'vitest'
import type { AppConfig } from '../src/config'
import { buildManifest, persistSlotState } from '../src/manifest-store'
import {
  getManifestForClient,
  primeManifestCacheForTests,
  refreshAll,
  refreshPlaylist,
  resolveVideoIdForPosition,
} from '../src/refresh'
import type { Manifest } from '../src/types'

/** JSON ログを object として検証し、field assertion に使える形で返す。 */
function parseLogRecord(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line)
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  return parsed as Record<string, unknown>
}

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
    mediaDeliveryMode: 'redirect',
    liveDeliveryMode: 'redirect',
    liveRelayOutDir: tempDataDir(),
    liveRelayIdleTtlMs: 5 * 60 * 1000,
    liveRelayMaxBytes: 10 * 1024 * 1024 * 1024,
    mediaMaxHeight: 1080,
    mediaCacheDir: tempDataDir(),
    mediaCacheMaxBytes: 10 * 1024 * 1024 * 1024,
    mediaCacheTtlMs: 6 * 60 * 60 * 1000,
    mediaDownloadTimeoutMs: 600_000,
    trustProxy: 1,
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

test('failed playlist refresh logs structured error, operation ID, and duration', async () => {
  const config = baseConfig('pl-structured-error')
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  try {
    await refreshPlaylist(config, 'pl-structured-error')
    const records = output.mock.calls.map(([line]) =>
      parseLogRecord(line as string)
    )
    const record = records.find(
      (entry) => entry.event === 'playlist.refresh.failed'
    ) as
      | {
          playlist_id: string
          operation: string
          operation_id: string
          duration_ms: number
          error: { type: string; message: string; code?: string }
        }
      | undefined

    assert.ok(record)
    assert.equal(record.playlist_id, 'pl-structured-error')
    assert.equal(record.operation, 'playlist.refresh')
    assert.ok(record.operation_id)
    assert.ok(record.duration_ms >= 0)
    assert.equal(record.error.type, 'YtdlpError')
    assert.ok(record.error.message.includes('yt-dlp'))
    const ytdlpRecord = records.find(
      (entry) => entry.event === 'ytdlp.operation.failed'
    )
    assert.ok(ytdlpRecord)
    assert.equal(ytdlpRecord.operation, 'ytdlp.run')
    assert.ok(ytdlpRecord.operation_id)
  } finally {
    output.mockRestore()
    vi.restoreAllMocks()
  }
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

test('refreshPlaylist single-flights concurrent calls for the same playlistId', async () => {
  const config = baseConfig('pl-concurrent')

  const [result1, result2] = await Promise.all([
    refreshPlaylist(config, 'pl-concurrent'),
    refreshPlaylist(config, 'pl-concurrent'),
  ])

  assert.equal(
    result1,
    result2,
    '同時に呼ばれた refreshPlaylist は同一の Promise (同一結果オブジェクト) を共有するはず'
  )
})

test('refreshPlaylist returns before warming every long relay entry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-refresh-warmup-test-'))
  const scriptPath = path.join(dir, 'fake-ytdlp.mjs')
  const callsPath = path.join(dir, 'calls.jsonl')
  const completedPath = path.join(dir, 'completed.jsonl')
  const releasePath = path.join(dir, 'release')
  const durations = [14_409, 3600, 3000, 2400, 2100, 1900, 1850, 1800, 1800]
  const longEntries = durations.map((duration, index) => ({
    id: `long000000${index}`,
    title: `Long ${index}`,
    duration,
  }))
  const entries = [
    { id: 'short000001', title: 'Short', duration: 120 },
    { id: 'short000002', title: 'Under threshold', duration: 1799 },
    { id: 'unknown0001', title: 'Unknown duration' },
    ...longEntries,
  ]
  fs.writeFileSync(
    scriptPath,
    String.raw`#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args.at(-1)) + '\n')
if (args.includes('--flat-playlist')) {
  process.stdout.write(${JSON.stringify(JSON.stringify({ entries }))})
} else {
  while (!fs.existsSync(${JSON.stringify(releasePath)})) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  fs.appendFileSync(${JSON.stringify(completedPath)}, JSON.stringify(args.at(-1)) + '\n')
  process.stdout.write(${JSON.stringify(JSON.stringify({ is_live: false, formats: [] }))})
}
`
  )
  fs.chmodSync(scriptPath, 0o755)
  const config = baseConfig('pl-relay-warmup', {
    dataDir: dir,
    ytdlpPath: scriptPath,
    ytdlpTimeoutMs: 5000,
    mediaDeliveryMode: 'relay',
  })

  try {
    const result = await refreshPlaylist(config, 'pl-relay-warmup')
    const startDeadline = Date.now() + 1000
    while (
      fs.readFileSync(callsPath, 'utf8').trim().split('\n').length < 3 &&
      Date.now() < startDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const calls = fs.readFileSync(callsPath, 'utf8')

    assert.equal(result.ok, true)
    assert.equal(calls.includes('playlist?list=pl-relay-warmup'), true)
    assert.equal(calls.includes('watch?v=long0000000'), true)
    assert.equal(calls.includes('watch?v=long0000001'), true)
    assert.equal(calls.includes('watch?v=short000001'), false)
    assert.equal(calls.includes('watch?v=short000002'), false)
    assert.equal(fs.existsSync(completedPath), false)

    fs.writeFileSync(releasePath, '')
    const completionDeadline = Date.now() + 5000
    while (
      (!fs.existsSync(completedPath) ||
        fs.readFileSync(completedPath, 'utf8').trim().split('\n').length < 8) &&
      Date.now() < completionDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const completed = fs.readFileSync(completedPath, 'utf8')
    assert.equal(completed.trim().split('\n').length, 8)
    assert.equal(completed.includes('watch?v=long0000008'), false)
  } finally {
    fs.writeFileSync(releasePath, '')
    const cleanupDeadline = Date.now() + 3000
    while (
      (!fs.existsSync(completedPath) ||
        fs.readFileSync(completedPath, 'utf8').trim().split('\n').length < 8) &&
      Date.now() < cleanupDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('refreshPlaylist can skip relay warm-ups for short-lived CLI refreshes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-refresh-cli-test-'))
  const scriptPath = path.join(dir, 'fake-ytdlp.mjs')
  const callsPath = path.join(dir, 'calls.jsonl')
  fs.writeFileSync(
    scriptPath,
    String.raw`#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args.at(-1)) + '\n')
if (args.includes('--flat-playlist')) {
  process.stdout.write(${JSON.stringify(JSON.stringify({ entries: [{ id: 'long000001', title: 'Long', duration: 3600 }] }))})
}
`
  )
  fs.chmodSync(scriptPath, 0o755)
  const config = baseConfig('pl-cli-refresh', {
    dataDir: dir,
    ytdlpPath: scriptPath,
    mediaDeliveryMode: 'relay',
  })

  try {
    const result = await refreshPlaylist(config, 'pl-cli-refresh', {
      warmRelayVideos: false,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(fs.readFileSync(callsPath, 'utf8').trim().split('\n'), [
      '"https://www.youtube.com/playlist?list=pl-cli-refresh"',
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveVideoIdForPosition triggers a refresh when slot state does not exist yet', async () => {
  const config = baseConfig('pl-cold-start')

  const result = await resolveVideoIdForPosition(config, 'pl-cold-start', 0)

  assert.ok(
    'error' in result,
    'yt-dlp-does-not-exist の baseConfig では Refresh が失敗するはず'
  )
  assert.equal(
    'reason' in result ? result.reason : undefined,
    'refresh_failed',
    'Refresh 自体の失敗は not_found ではなく refresh_failed として区別されるはず'
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

  const result = await resolveVideoIdForPosition(config, 'pl-known-position', 0)

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
  persistSlotState(config.dataDir, { ...state, lastRefreshAt: Date.now() })

  // position 1 は存在しない。直近 Refresh 済み (かつ成功) のため Refresh は再試行されないはずで、
  // その場合 error は必ず 'unknown position' になる (Refresh が走れば
  // 'yt-dlp-does-not-exist' に起因する別のエラーメッセージになるため区別できる)。
  const result = await resolveVideoIdForPosition(config, 'pl-recent-refresh', 1)

  assert.deepEqual(result, { error: 'unknown position', reason: 'not_found' })
})

test('resolveVideoIdForPosition surfaces the persisted lastError when a recent refresh had failed', async () => {
  const config = baseConfig('pl-recent-failure', { manifestCacheTtlMs: 60_000 })
  const { state } = buildManifest(
    null,
    'pl-recent-failure',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(config.dataDir, {
    ...state,
    lastRefreshAt: Date.now(),
    lastRefreshOk: false,
    lastError: 'network unreachable',
  })

  // position 1 は存在せず、直近の Refresh は失敗記録 (lastRefreshOk: false) が付いている。
  // 再試行はしないが、握りつぶさず lastError をそのまま返すはず。
  const result = await resolveVideoIdForPosition(config, 'pl-recent-failure', 1)

  assert.deepEqual(result, {
    error: 'network unreachable',
    reason: 'refresh_failed',
  })
})
