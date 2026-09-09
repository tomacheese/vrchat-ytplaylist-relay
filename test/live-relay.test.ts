import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'
import type { AppConfig } from '../src/config'

vi.mock('../src/live-resolve', () => ({
  resolveVideoInfo: vi.fn(async (videoId: string) => ({
    isLive: true,
    hlsMasterManifestUrl: `https://manifest.googlevideo.com/${videoId}/master.m3u8`,
  })),
}))

/**
 * 実 ffmpeg の代わりに EventEmitter ベースの偽 ChildProcess を返す。呼び出し引数末尾の
 * playlistPath から outDir を特定し、少し遅れて最初のセグメントファイルを書き出すことで
 * `ensureLiveRelay` の `waitForFirstSegment` (fs.watch ベース) を実際のファイルシステム越しに
 * 起動させる (spawn 自体のみモックし、fs はモックしない)。
 */
function makeSpawnMock() {
  const killMocks: ReturnType<typeof vi.fn>[] = []
  const spawnMock = vi.fn((_cmd: string, args: string[]) => {
    const playlistPath = args.at(-1) as string
    const outDir = path.dirname(playlistPath)
    setTimeout(() => {
      fs.writeFileSync(path.join(outDir, 'live0.ts'), 'segment')
    }, 5)
    const emitter = new EventEmitter() as EventEmitter & { kill: unknown }
    const kill = vi.fn()
    emitter.kill = kill
    killMocks.push(kill)
    return emitter
  })
  return { spawnMock, killMocks }
}

let spawnMock: ReturnType<typeof makeSpawnMock>['spawnMock']
let killMocks: ReturnType<typeof makeSpawnMock>['killMocks']

vi.mock('node:child_process', () => ({
  spawn: (...args: [string, string[]]) => spawnMock(...args),
}))

let outDirRoot: string | undefined

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    configPath: 'test-config',
    dataDir: '',
    adminToken: null,
    ytdlpPath: 'yt-dlp',
    defaultMaxSlots: 100,
    ytdlpTimeoutMs: 1000,
    manifestCacheTtlMs: 60_000,
    mediaDeliveryMode: 'redirect',
    liveDeliveryMode: 'proxy',
    liveRelayOutDir: outDirRoot ?? '',
    liveRelayIdleTtlMs: 5 * 60 * 1000,
    mediaMaxHeight: 1080,
    mediaCacheDir: '',
    mediaCacheMaxBytes: 10 * 1024 * 1024 * 1024,
    mediaCacheTtlMs: 6 * 60 * 60 * 1000,
    mediaDownloadTimeoutMs: 600_000,
    playlists: [],
    ...overrides,
  }
}

beforeEach(() => {
  const mocks = makeSpawnMock()
  spawnMock = mocks.spawnMock
  killMocks = mocks.killMocks
  outDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-live-relay-test-'))
})

afterEach(async () => {
  const { stopLiveRelay } = await import('../src/live-relay')
  stopLiveRelay('v1')
  stopLiveRelay('v2')
  if (outDirRoot) fs.rmSync(outDirRoot, { recursive: true, force: true })
  outDirRoot = undefined
})

test('ensureLiveRelay spawns ffmpeg only once for concurrent requests of the same videoId', async () => {
  const { ensureLiveRelay } = await import('../src/live-relay')
  const config = makeConfig()

  const [a, b] = await Promise.all([
    ensureLiveRelay(config, 'v1'),
    ensureLiveRelay(config, 'v1'),
  ])

  assert.equal(spawnMock.mock.calls.length, 1)
  assert.deepEqual(a, b)
  assert.ok('outDir' in a)
})

test('touchLiveRelay keeps a videoId alive across another videoId eviction scan', async () => {
  const { ensureLiveRelay, touchLiveRelay } = await import('../src/live-relay')
  const config = makeConfig({ liveRelayIdleTtlMs: 200 })

  await ensureLiveRelay(config, 'v1')
  assert.equal(spawnMock.mock.calls.length, 1)

  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    touchLiveRelay('v1')
  }

  // v2 起動時の evictIdleLiveRelays() スキャンが v1 を巻き込まないこと (v2 分の spawn のみ増える)。
  await ensureLiveRelay(config, 'v2')
  assert.equal(spawnMock.mock.calls.length, 2)

  // v1 が evict されていなければ、再度 ensureLiveRelay('v1') しても spawn は増えない。
  await ensureLiveRelay(config, 'v1')
  assert.equal(spawnMock.mock.calls.length, 2)
})

test('an idle videoId (no touchLiveRelay) is stopped by another videoId eviction scan', async () => {
  const { ensureLiveRelay } = await import('../src/live-relay')
  const config = makeConfig({ liveRelayIdleTtlMs: 30 })

  await ensureLiveRelay(config, 'v1')
  assert.equal(spawnMock.mock.calls.length, 1)

  await new Promise((resolve) => setTimeout(resolve, 60))

  await ensureLiveRelay(config, 'v2')
  assert.equal(
    killMocks[0].mock.calls.length,
    1,
    'expected v1 ffmpeg to be killed'
  )

  // v1 は evict 済みのため、再度 ensureLiveRelay('v1') すると ffmpeg が再起動される。
  await ensureLiveRelay(config, 'v1')
  assert.equal(spawnMock.mock.calls.length, 3)
})
