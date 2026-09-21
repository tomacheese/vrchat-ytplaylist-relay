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
 * 実 ffmpeg の代わりに EventEmitter ベースの偽 ChildProcess を返す。呼び出し引数末尾の
 * playlistPath から outDir を特定し、少し遅れて最初のセグメントファイルを書き出すことで
 * `ensureLiveRelay` の `waitForFirstSegment` (fs.watch ベース) を実際のファイルシステム越しに
 * 起動させる (spawn 自体のみモックし、fs はモックしない)。
 */
function makeSpawnMock() {
  const killMocks: ReturnType<typeof vi.fn>[] = []
  const spawnMock = vi.fn((_cmd: string, args: string[]) => {
    const [playlistPath] = args.slice(-1)
    const outDir = path.dirname(playlistPath)
    setTimeout(() => {
      fs.writeFileSync(path.join(outDir, 'live0.ts'), 'segment')
    }, 5)
    // 実 ChildProcess は EventEmitter ベースの `.on('close', ...)` API を持つ (EventTarget では
    // ない) ため、それを模倣する偽物として EventEmitter を使う必要がある。
    // eslint-disable-next-line unicorn/prefer-event-target
    const emitter = new EventEmitter() as EventEmitter & { kill: unknown }
    // 実 ffmpeg は SIGTERM/SIGKILL を受けると程なく終了し 'close' を発火する。
    // stopLiveRelay() がこの 'close' 待ちでハングしないよう、kill() 呼び出しを模擬的に反映する。
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

beforeEach(() => {
  const mocks = makeSpawnMock()
  spawnMock = mocks.spawnMock
  killMocks = mocks.killMocks
  outDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-live-relay-test-'))
})

afterEach(async () => {
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

  // v2 起動時の evictIdleLiveRelays() スキャンが v1 を巻き込まないこと (v2 分の spawn のみ増える)。
  await ensureLiveRelay(config, 'testVideo02')
  assert.equal(spawnMock.mock.calls.length, 2)

  // v1 が evict されていなければ、再度 ensureLiveRelay('testVideo01') しても spawn は増えない。
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

  // v1 は evict 済みのため、再度 ensureLiveRelay('testVideo01') すると ffmpeg が再起動される。
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
  // fs.promises.mkdir / spawn / fs.watch のセットアップ (実 I/O) を先に完了させるための実時間 setTimeout。
  // vi.useFakeTimers() 後は global setTimeout がフェイクに置き換わるため、先に退避しておく。
  const realSetTimeout = setTimeout
  vi.useFakeTimers()
  try {
    const { ensureLiveRelay } = await import('../src/live-relay')
    const config = makeConfig()

    spawnMock.mockImplementationOnce(() => {
      // eslint-disable-next-line unicorn/prefer-event-target
      const emitter = new EventEmitter() as EventEmitter & { kill: unknown }
      // 意図的に 'close' も 'error' も発火させず、セグメントも書き出さない (ハングを模擬)。
      // ただし stopLiveRelay() の後始末 (SIGTERM/SIGKILL) には応答して 'close' を返す。
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
    // waitForFirstSegment のタイムアウト (30s) 到達後、awaitPlayback() が後始末の stopLiveRelay()
    // を呼び、その中の SIGTERM 猶予 (STOP_GRACE_MS = 5s) も消化する必要があるため、まとめて進める。
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
    // idleTtlMs を大幅に超える遅延で最初のセグメントを書き出す (起動が長引くケースを模擬)。
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
    // 起動中 (idleTtlMs を超えて) に別 videoId への ensureLiveRelay が evictIdleLiveRelays() を
    // 走らせても、起動中の testVideo06 が巻き込まれて evict されないこと。
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
      // SIGTERM 後もしばらく生き続ける実プロセスを模擬 (即座には close しない)。
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

test('ensureLiveRelay remuxes a VOD master: feeds ffmpeg an AVC1-only local master with a capped read rate and keeps all segments', async () => {
  const { resolveVideoInfo } = await import('../src/live-resolve')
  vi.mocked(resolveVideoInfo).mockResolvedValueOnce({
    isLive: false,
    hlsIsMaster: true,
    hlsMasterManifestUrl: 'https://manifest.googlevideo.com/vod/master.m3u8',
  })
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:URI="https://a/234",TYPE=AUDIO,GROUP-ID="234",NAME="d"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="234"',
    'https://v/1080',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="vp09.00.21.08,mp4a.40.2",RESOLUTION=3840x2160,AUDIO="234"',
    'https://v/vp9',
    '',
  ].join('\n')
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(master)))
  )

  const { ensureLiveRelay } = await import('../src/live-relay')
  const result = await ensureLiveRelay(makeConfig(), 'testVideo01')

  assert.ok('outDir' in result)
  const args = spawnMock.mock.calls[0][1]
  assert.equal(args[args.indexOf('-readrate') + 1], '10')
  assert.equal(args[args.indexOf('-hls_playlist_type') + 1], 'event')
  assert.ok(!args.join(' ').includes('delete_segments'))
  const input = args[args.indexOf('-i') + 1]
  assert.equal(path.basename(input), 'input.m3u8')
  const written = fs.readFileSync(input, 'utf8')
  assert.ok(written.includes('https://v/1080'))
  assert.ok(!written.includes('https://v/vp9'))
})

test('a VOD relay whose ffmpeg exits normally (EOF) keeps its files and state until idle eviction', async () => {
  const { resolveVideoInfo } = await import('../src/live-resolve')
  vi.mocked(resolveVideoInfo).mockResolvedValue({
    isLive: false,
    hlsIsMaster: true,
    hlsMasterManifestUrl: 'https://manifest.googlevideo.com/vod/master.m3u8',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080',
            'https://v/1080',
            '',
          ].join('\n')
        )
      )
    )
  )
  const { ensureLiveRelay } = await import('../src/live-relay')
  const config = makeConfig()
  const result = await ensureLiveRelay(config, 'testVideo01')
  assert.ok('outDir' in result)

  const child = spawnMock.mock.results[0].value as EventEmitter
  child.emit('close', 0)
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.ok(fs.existsSync(path.join(result.outDir, 'live0.ts')))
  await ensureLiveRelay(config, 'testVideo01')
  assert.equal(spawnMock.mock.calls.length, 1)
  vi.mocked(resolveVideoInfo).mockReset()
})

test('starting a VOD relay stops the least recently used relay when the total size exceeds liveRelayMaxBytes', async () => {
  const { resolveVideoInfo } = await import('../src/live-resolve')
  vi.mocked(resolveVideoInfo).mockImplementation((videoId: string) =>
    Promise.resolve({
      isLive: false,
      hlsIsMaster: true,
      hlsMasterManifestUrl: `https://manifest.googlevideo.com/${videoId}/master.m3u8`,
    })
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080',
            'https://v/1080',
            '',
          ].join('\n')
        )
      )
    )
  )
  const { ensureLiveRelay } = await import('../src/live-relay')
  const config = makeConfig({ liveRelayMaxBytes: 1 })

  const first = await ensureLiveRelay(config, 'testVideo01')
  assert.ok('outDir' in first)
  assert.ok(fs.existsSync(first.outDir))

  const second = await ensureLiveRelay(config, 'testVideo02')
  assert.ok('outDir' in second)

  // 1 つ目 (最終アクセスが古い方) が停止され、ディレクトリごと削除されている。
  assert.ok(!fs.existsSync(first.outDir))
  assert.ok(fs.existsSync(second.outDir))
  vi.mocked(resolveVideoInfo).mockReset()
})
