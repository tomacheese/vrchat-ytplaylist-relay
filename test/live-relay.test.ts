import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'
import type { AppConfig } from '../src/config'

vi.mock('../src/live-resolve', () => ({
  resolveVideoInfo: vi.fn((videoId: string) =>
    Promise.resolve({
      isLive: true,
      hlsIsMaster: false,
      hlsMasterManifestUrl: `https://manifest.googlevideo.com/${videoId}/master.m3u8`,
    })
  ),
}))

/**
 * Returns a fake EventEmitter-based ChildProcess instead of a real ffmpeg. It derives outDir from
 * the trailing playlistPath argument and writes the first segment file shortly after, so
 * `ensureLiveRelay`'s fs.watch-based `waitForFirstSegment` runs against the real filesystem
 * (only spawn is mocked, not fs).
 */
function makeSpawnMock() {
  const killMocks: ReturnType<typeof vi.fn>[] = []
  const spawnMock = vi.fn((_cmd: string, args: string[]) => {
    const [playlistPath] = args.slice(-1)
    const outDir = path.dirname(playlistPath)
    setTimeout(() => {
      fs.writeFileSync(path.join(outDir, 'live0.ts'), 'segment')
    }, 5)
    // A real ChildProcess exposes an EventEmitter-style `.on('close', ...)` API (not EventTarget),
    // so the fake must be an EventEmitter.
    // eslint-disable-next-line unicorn/prefer-event-target
    const emitter = new EventEmitter() as EventEmitter & { kill: unknown }
    // Real ffmpeg exits shortly after SIGTERM/SIGKILL and emits 'close'. Mimic that on kill() so
    // stopLiveRelay() doesn't hang waiting for 'close'.
    const kill = vi.fn(() => {
      setTimeout(() => {
        emitter.emit('close', null)
      }, 1)
    })
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
    manifestRetryDelayMs: 30_000,
    mediaDeliveryMode: 'redirect',
    liveDeliveryMode: 'proxy',
    liveRelayOutDir: outDirRoot ?? '',
    liveRelayIdleTtlMs: 5 * 60 * 1000,
    liveRelayMaxBytes: 10 * 1024 * 1024 * 1024,
    mediaMaxHeight: 1080,
    mediaCacheDir: '',
    mediaCacheMaxBytes: 10 * 1024 * 1024 * 1024,
    mediaCacheTtlMs: 6 * 60 * 60 * 1000,
    mediaDownloadTimeoutMs: 600_000,
    trustProxy: 1,
    playlists: [],
    ...overrides,
  }
}

beforeEach(async () => {
  const { resetLiveRelaySweepForTests } = await import('../src/live-relay')
  resetLiveRelaySweepForTests()
  const mocks = makeSpawnMock()
  spawnMock = mocks.spawnMock
  killMocks = mocks.killMocks
  outDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-live-relay-test-'))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  const { stopLiveRelay } = await import('../src/live-relay')
  await stopLiveRelay('testVideo01')
  await stopLiveRelay('testVideo02')
  if (outDirRoot) fs.rmSync(outDirRoot, { recursive: true, force: true })
  outDirRoot = undefined
})

test('ensureLiveRelay spawns ffmpeg only once for concurrent requests of the same videoId', async () => {
  const { ensureLiveRelay } = await import('../src/live-relay')
  const config = makeConfig()

  const [a, b] = await Promise.all([
    ensureLiveRelay(config, 'testVideo01'),
    ensureLiveRelay(config, 'testVideo01'),
  ])

  assert.equal(spawnMock.mock.calls.length, 1)
  assert.deepEqual(a, b)
  assert.ok('outDir' in a)
})

test('touchLiveRelay keeps a videoId alive across another videoId eviction scan', async () => {
  const { ensureLiveRelay, touchLiveRelay } = await import('../src/live-relay')
  const config = makeConfig({ liveRelayIdleTtlMs: 200 })

  await ensureLiveRelay(config, 'testVideo01')
  assert.equal(spawnMock.mock.calls.length, 1)

  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    touchLiveRelay('testVideo01')
  }

  // The evictIdleLiveRelays() scan when v2 starts must not evict v1 (only v2's spawn is added).
  await ensureLiveRelay(config, 'testVideo02')
  assert.equal(spawnMock.mock.calls.length, 2)

  // If v1 wasn't evicted, calling ensureLiveRelay('testVideo01') again adds no spawn.
  await ensureLiveRelay(config, 'testVideo01')
  assert.equal(spawnMock.mock.calls.length, 2)
})

test('an idle videoId (no touchLiveRelay) is stopped by another videoId eviction scan', async () => {
  const { ensureLiveRelay } = await import('../src/live-relay')
  const config = makeConfig({ liveRelayIdleTtlMs: 30 })

  await ensureLiveRelay(config, 'testVideo01')
  assert.equal(spawnMock.mock.calls.length, 1)

  await new Promise((resolve) => setTimeout(resolve, 60))

  await ensureLiveRelay(config, 'testVideo02')
  assert.equal(
    killMocks[0].mock.calls.length,
    1,
    'expected v1 ffmpeg to be killed'
  )

  // v1 was evicted, so ensureLiveRelay('testVideo01') restarts ffmpeg.
  await ensureLiveRelay(config, 'testVideo01')
  assert.equal(spawnMock.mock.calls.length, 3)
})

test('ensureLiveRelay returns an error result (not a crash) when ffmpeg fails to spawn', async () => {
  const { ensureLiveRelay } = await import('../src/live-relay')
  const config = makeConfig()

  spawnMock.mockImplementationOnce(() => {
    // eslint-disable-next-line unicorn/prefer-event-target
    const emitter = new EventEmitter() as EventEmitter & { kill: unknown }
    emitter.kill = vi.fn()
    setTimeout(() => {
      emitter.emit('error', new Error('spawn ffmpeg ENOENT'))
    }, 1)
    return emitter
  })

  const result = await ensureLiveRelay(config, 'testVideo03')
  assert.ok(
    'error' in result,
    'a spawn failure must resolve to an error result, not hang or throw'
  )
})

test('ensureLiveRelay resolves to an error when ffmpeg exits before writing any segment', async () => {
  const { ensureLiveRelay } = await import('../src/live-relay')
  const config = makeConfig()

  spawnMock.mockImplementationOnce(() => {
    // eslint-disable-next-line unicorn/prefer-event-target
    const emitter = new EventEmitter() as EventEmitter & { kill: unknown }
    emitter.kill = vi.fn()
    setTimeout(() => {
      emitter.emit('close', 1)
    }, 1)
    return emitter
  })

  const result = await ensureLiveRelay(config, 'testVideo04')
  assert.ok(
    'error' in result,
    'ffmpeg exiting before the first segment must not hang ensureLiveRelay forever'
  )
})

test('ensureLiveRelay times out (does not hang forever) when ffmpeg neither writes a segment nor exits', async () => {
  // Real-time setTimeout so the real I/O setup (fs.promises.mkdir / spawn / fs.watch) can finish first.
  // Saved up front because vi.useFakeTimers() replaces the global setTimeout.
  const realSetTimeout = setTimeout
  vi.useFakeTimers()
  try {
    const { ensureLiveRelay } = await import('../src/live-relay')
    const config = makeConfig()

    spawnMock.mockImplementationOnce(() => {
      // eslint-disable-next-line unicorn/prefer-event-target
      const emitter = new EventEmitter() as EventEmitter & { kill: unknown }
      // Deliberately emit neither 'close' nor 'error' and write no segment (simulates a hang),
      // but still answer stopLiveRelay()'s cleanup (SIGTERM/SIGKILL) with 'close'.
      emitter.kill = vi.fn(() => {
        setTimeout(() => {
          emitter.emit('close', null)
        }, 1)
      })
      return emitter
    })

    const pending = ensureLiveRelay(config, 'testVideo05')
    await new Promise((resolve) => {
      realSetTimeout(resolve, 20)
    })
    // After the FIRST_SEGMENT_TIMEOUT_MS wait, awaitPlayback() calls stopLiveRelay() for
    // cleanup, which also needs STOP_GRACE_MS (the SIGTERM grace) to elapse, so advance both.
    await vi.advanceTimersByTimeAsync(30_000 + 5000)
    const result = await pending
    assert.ok(
      'error' in result,
      'a hung ffmpeg with no segment output must eventually time out'
    )
  } finally {
    vi.useRealTimers()
  }
})

test('a relay still starting up is never evicted by another videoId eviction scan, no matter how long startup takes', async () => {
  const { ensureLiveRelay, stopLiveRelay } = await import('../src/live-relay')
  const config = makeConfig({ liveRelayIdleTtlMs: 10 })

  spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
    const [playlistPath] = args.slice(-1)
    const outDir = path.dirname(playlistPath)
    // Write the first segment well past idleTtlMs (simulates a slow startup).
    setTimeout(() => {
      fs.writeFileSync(path.join(outDir, 'live0.ts'), 'segment')
    }, 100)
    // eslint-disable-next-line unicorn/prefer-event-target
    const emitter = new EventEmitter() as EventEmitter & { kill: unknown }
    const kill = vi.fn(() => {
      setTimeout(() => {
        emitter.emit('close', null)
      }, 1)
    })
    emitter.kill = kill
    killMocks.push(kill)
    return emitter
  })

  try {
    const slowStart = ensureLiveRelay(config, 'testVideo06')
    // Even if ensureLiveRelay for another videoId runs evictIdleLiveRelays() while testVideo06 is
    // still starting (past idleTtlMs), testVideo06 must not be evicted.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await ensureLiveRelay(config, 'testVideo07')

    const result = await slowStart
    assert.ok(
      'outDir' in result,
      `expected the slow-starting relay to succeed, got: ${JSON.stringify(result)}`
    )
  } finally {
    await stopLiveRelay('testVideo06')
    await stopLiveRelay('testVideo07')
  }
})

test('stopLiveRelay waits for the ffmpeg process to actually exit before removing outDir', async () => {
  const { ensureLiveRelay, stopLiveRelay } = await import('../src/live-relay')
  const config = makeConfig()

  let killed = false
  spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
    const [playlistPath] = args.slice(-1)
    const outDir = path.dirname(playlistPath)
    setTimeout(() => {
      fs.writeFileSync(path.join(outDir, 'live0.ts'), 'segment')
    }, 5)
    // eslint-disable-next-line unicorn/prefer-event-target
    const emitter = new EventEmitter() as EventEmitter & { kill: unknown }
    const kill = vi.fn(() => {
      killed = true
      // Simulates a real process that stays alive for a while after SIGTERM (doesn't close immediately).
      setTimeout(() => {
        emitter.emit('close', null)
      }, 30)
    })
    emitter.kill = kill
    return emitter
  })

  const started = await ensureLiveRelay(config, 'testVideo08')
  assert.ok('outDir' in started)
  if (!('outDir' in started)) return
  const outDir = started.outDir

  const stopPromise = stopLiveRelay('testVideo08')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(killed, 'expected SIGTERM to have been sent already')
  assert.ok(
    fs.existsSync(outDir),
    'outDir must not be removed before ffmpeg has actually exited'
  )

  await stopPromise
  assert.ok(
    !fs.existsSync(outDir),
    'outDir must be removed once ffmpeg has exited'
  )
})

test('liveRelayDirFor rejects a videoId that does not match the YouTube ID format (path traversal guard)', async () => {
  const { liveRelayDirFor } = await import('../src/live-relay')
  const config = makeConfig()
  assert.throws(() => liveRelayDirFor(config, '..'))
  assert.throws(() => liveRelayDirFor(config, 'short'))
})

test('ensureLiveRelay rejects a malformed videoId instead of building a path outside liveRelayOutDir', async () => {
  const { ensureLiveRelay } = await import('../src/live-relay')
  const config = makeConfig()
  const result = await ensureLiveRelay(config, '..')
  assert.ok('error' in result)
})

test('the periodic sweep stops an idle relay even when no further request arrives', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const { ensureLiveRelay, touchLiveRelay } = await import('../src/live-relay')
  const config = makeConfig({ liveRelayIdleTtlMs: 60_000 })
  const result = await ensureLiveRelay(config, 'testVideo01')
  assert.ok('outDir' in result)
  touchLiveRelay('testVideo01')

  await vi.advanceTimersByTimeAsync(2 * 60_000)
  // stopLiveRelay waits for 'close' after SIGTERM, so allow real-timer time for it.
  vi.useRealTimers()
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.ok(!fs.existsSync(result.outDir))
})

test('the first ensureLiveRelay removes only relay-generated leftovers and never touches unrelated entries', async () => {
  const { ensureLiveRelay } = await import('../src/live-relay')
  const config = makeConfig()
  const root = config.liveRelayOutDir

  // Relay directory left by a previous process (gets deleted)
  const stale = path.join(root, 'staleVideo1')
  fs.mkdirSync(stale, { recursive: true })
  fs.writeFileSync(path.join(stale, 'live0.ts'), 'old segment')
  fs.writeFileSync(path.join(stale, 'live.m3u8'), '#EXTM3U')

  // Unrelated entries, as if LIVE_RELAY_OUT_DIR were misconfigured (not deleted)
  fs.writeFileSync(path.join(root, 'state.json'), '{}')
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true })
  fs.writeFileSync(path.join(root, 'cache', 'video.mp4'), 'cached')
  // Even with a videoId-like name, a directory containing non-relay files is not deleted
  const lookalike = path.join(root, 'lookAlike11')
  fs.mkdirSync(lookalike, { recursive: true })
  fs.writeFileSync(path.join(lookalike, 'user-data.db'), 'important')

  const result = await ensureLiveRelay(config, 'testVideo01')

  assert.ok('outDir' in result)
  assert.ok(!fs.existsSync(stale))
  assert.ok(fs.existsSync(path.join(root, 'state.json')))
  assert.ok(fs.existsSync(path.join(root, 'cache', 'video.mp4')))
  assert.ok(fs.existsSync(path.join(lookalike, 'user-data.db')))
  assert.ok(fs.existsSync(result.outDir))
})
