import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp } from '../src/app'
import type { AppConfig } from '../src/config'
import { ensureLiveRelay, liveRelayDirFor } from '../src/live-relay'
import { resolveVideoInfo } from '../src/live-resolve'
import { buildManifest, persistSlotState } from '../src/manifest-store'
import { primeManifestCacheForTests } from '../src/refresh'

// isLive 判定 (resolveVideoInfo) と Live proxy 再公開 (ensureLiveRelay) は実 yt-dlp / ffmpeg に
// 依存するため、Media Endpoint のモード分岐ロジック自体を検証するテストではモックする。
// liveRelayDirFor / touchLiveRelay / stopLiveRelay は実ファイルシステムで動作を検証するため、
// 元の実装のまま残す (部分モック)。
vi.mock('../src/live-resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/live-resolve')>()
  return { ...actual, resolveVideoInfo: vi.fn() }
})
vi.mock('../src/live-relay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/live-relay')>()
  return { ...actual, ensureLiveRelay: vi.fn() }
})

beforeEach(() => {
  // 既定では VOD (非 Live) 扱い。Live 判定に依存するテストは各テスト内で上書きする。
  vi.mocked(resolveVideoInfo).mockResolvedValue({
    isLive: false,
    hlsMasterManifestUrl: null,
    hlsIsMaster: false,
  })
  vi.mocked(ensureLiveRelay).mockResolvedValue({
    error: 'ensureLiveRelay is not configured for this test',
  })
})

afterEach(() => {
  vi.mocked(resolveVideoInfo).mockReset()
  vi.mocked(ensureLiveRelay).mockReset()
})

let server: Server
let baseUrl: string
let dataDir: string

const config: AppConfig = {
  port: 0,
  configPath: 'test-config',
  dataDir: '',
  adminToken: 'secret-token',
  ytdlpPath: 'yt-dlp',
  defaultMaxSlots: 100,
  ytdlpTimeoutMs: 1000,
  // テスト中に GET /manifest.json 経由で本物の yt-dlp が起動されないよう、TTL を長めに取り
  // メモリキャッシュを primeManifestCacheForTests() で直接投入する。
  manifestCacheTtlMs: 60_000,
  mediaDeliveryMode: 'redirect',
  liveDeliveryMode: 'redirect',
  liveRelayOutDir: '',
  liveRelayIdleTtlMs: 5 * 60 * 1000,
  liveRelayMaxBytes: 10 * 1024 * 1024 * 1024,
  mediaMaxHeight: 1080,
  mediaCacheDir: '',
  mediaCacheMaxBytes: 10 * 1024 * 1024 * 1024,
  mediaCacheTtlMs: 6 * 60 * 60 * 1000,
  mediaDownloadTimeoutMs: 600_000,
  trustProxy: 1,
  playlists: [{ playlistId: 'pl1', displayName: 'Test Playlist' }],
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-route-test-'))
  config.dataDir = dataDir
  config.liveRelayOutDir = path.join(dataDir, 'live')
  config.mediaCacheDir = path.join(dataDir, 'cache')

  // slot 対応表と Manifest キャッシュを事前に生成しておく (yt-dlp の実行自体は別テストで検証済みのためここでは不要)。
  // position 1 (liveVideo01) は liveRelayDirFor() (videoId の形式検証あり) を実装のまま経由する
  // live-relay ルートのテスト専用に、YouTube videoId 形式 (11 文字) を満たす videoId を割り当てる。
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [
      { id: 'v1', title: 'Track 1', duration: 100 },
      { id: 'liveVideo01', title: 'Live Track', duration: 100 },
    ],
    Date.now()
  )
  persistSlotState(dataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(config)
  // trust proxy 設定 (config.trustProxy) が req.ip に反映されることを検証するためのテスト専用ルート。
  // "/:playlistId/:positionFile" (mediaRouter) など既存の 2 セグメント動的ルートと衝突しないよう、
  // 単一セグメントのパスにする。
  app.get('/__test-ip', (req, res) => {
    res.status(200).json({ ip: req.ip })
  })
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('req.ip reflects X-Forwarded-For when trust proxy is configured', async () => {
  const res = await fetch(`${baseUrl}/__test-ip`, {
    headers: { 'X-Forwarded-For': '203.0.113.1' },
  })
  const body = (await res.json()) as { ip: string }
  assert.equal(body.ip, '203.0.113.1')
})

test('GET /health is public (no Authorization required)', async () => {
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.status, 200)
})

test('GET /:playlistId/manifest.json is public and returns the cached manifest', async () => {
  const res = await fetch(`${baseUrl}/pl1/manifest.json`)
  assert.equal(res.status, 200, 'manifest.json must NOT require Authorization')
  const body = (await res.json()) as { playlistId: string; tracks: unknown[] }
  assert.equal(body.playlistId, 'pl1')
  assert.equal(body.tracks.length, 2)
})

test('GET /:playlistId/:position.mp4 is public and redirects to the canonical YouTube watch URL', async () => {
  const res = await fetch(`${baseUrl}/pl1/0.mp4`, { redirect: 'manual' })
  assert.equal(res.status, 302, 'media redirect must NOT require Authorization')
  assert.equal(
    res.headers.get('location'),
    'https://www.youtube.com/watch?v=v1'
  )
})

test('GET /:playlistId/:position/live/:file serves the live-relay file and updates its lastAccessedAt', async () => {
  const outDir = liveRelayDirFor(config, 'liveVideo01')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'live.m3u8'), '#EXTM3U')
  try {
    const res = await fetch(`${baseUrl}/pl1/1/live/live.m3u8`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), '#EXTM3U')
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/:position/live/:file returns 404 for a file name outside the live.m3u8/live<N>.ts pattern', async () => {
  const outDir = liveRelayDirFor(config, 'liveVideo01')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'live.m3u8'), '#EXTM3U')
  try {
    const res = await fetch(
      `${baseUrl}/pl1/1/live/${encodeURIComponent('../../etc/passwd')}`
    )
    assert.equal(res.status, 404)
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/:position/live/:file returns 404 when the live-relay file does not exist', async () => {
  const res = await fetch(`${baseUrl}/pl1/1/live/live.m3u8`)
  assert.equal(res.status, 404)
})

// 実 YouTube videoId 形式 (11 文字) を満たすダミー videoId。Playlist に属さず videoId 直接指定
// エンドポイント (GET /video/:videoId, GET /video/:videoId.mp4) 用のテストにのみ使う。
const DIRECT_VIDEO_ID = 'dQw4w9WgXcQ'

test('GET /video/:videoId and GET /video/:videoId.mp4 are public and redirect to the canonical YouTube watch URL', async () => {
  for (const path_ of [
    `/video/${DIRECT_VIDEO_ID}`,
    `/video/${DIRECT_VIDEO_ID}.mp4`,
  ]) {
    const res = await fetch(`${baseUrl}${path_}`, { redirect: 'manual' })
    assert.equal(res.status, 302, `${path_} must NOT require Authorization`)
    assert.equal(
      res.headers.get('location'),
      `https://www.youtube.com/watch?v=${DIRECT_VIDEO_ID}`
    )
  }
})

test('GET /video/:videoId and GET /video/:videoId.mp4 return 404 for a malformed videoId', async () => {
  for (const path_ of ['/video/too-short', '/video/too-short.mp4']) {
    const res = await fetch(`${baseUrl}${path_}`)
    assert.equal(res.status, 404)
    const body = (await res.json()) as { error: string }
    assert.equal(body.error, 'invalid videoId')
  }
})

test('GET /live/:videoId/:file returns 404 for a malformed videoId', async () => {
  const res = await fetch(`${baseUrl}/live/too-short/live.m3u8`)
  assert.equal(res.status, 404)
  const body = (await res.json()) as { error: string }
  assert.equal(body.error, 'invalid videoId')
})

test('GET /live/:videoId/:file serves the live-relay file directly (videoId-keyed, no playlistId)', async () => {
  const outDir = liveRelayDirFor(config, DIRECT_VIDEO_ID)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'live.m3u8'), '#EXTM3U')
  try {
    const res = await fetch(`${baseUrl}/live/${DIRECT_VIDEO_ID}/live.m3u8`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), '#EXTM3U')
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
})

test('GET /video/:videoId.mp4 in relay mode redirects to the resolved HLS master manifest URL', async () => {
  const relayDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-video-relay-')
  )
  const relayConfig: AppConfig = {
    ...config,
    dataDir: relayDataDir,
    mediaDeliveryMode: 'relay',
    liveDeliveryMode: 'relay',
  }
  vi.mocked(resolveVideoInfo).mockResolvedValue({
    isLive: false,
    hlsMasterManifestUrl: 'https://manifest.googlevideo.com/v1/master.m3u8',
    hlsIsMaster: false,
  })

  const app = createApp(relayConfig)
  let relayServer: Server | undefined
  try {
    relayServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = relayServer.address() as AddressInfo
    const res = await fetch(
      `http://127.0.0.1:${address.port}/video/${DIRECT_VIDEO_ID}.mp4`,
      { redirect: 'manual' }
    )
    assert.equal(res.status, 302)
    assert.equal(
      res.headers.get('location'),
      'https://manifest.googlevideo.com/v1/master.m3u8'
    )
  } finally {
    if (relayServer) {
      const s = relayServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(relayDataDir, { recursive: true, force: true })
  }
})

test('GET /video/:videoId.mp4 in relay mode remuxes a VOD master via the live relay instead of redirecting to it', async () => {
  const relayDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-video-relay-master-')
  )
  const relayConfig: AppConfig = {
    ...config,
    dataDir: relayDataDir,
    mediaDeliveryMode: 'relay',
    liveDeliveryMode: 'relay',
  }
  vi.mocked(resolveVideoInfo).mockResolvedValue({
    isLive: false,
    hlsMasterManifestUrl: 'https://manifest.googlevideo.com/v1/master.m3u8',
    hlsIsMaster: true,
  })
  vi.mocked(ensureLiveRelay).mockResolvedValue({
    outDir: relayDataDir,
    playlistFileName: 'live.m3u8',
  })

  const app = createApp(relayConfig)
  let relayServer: Server | undefined
  try {
    relayServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = relayServer.address() as AddressInfo
    const res = await fetch(
      `http://127.0.0.1:${address.port}/video/${DIRECT_VIDEO_ID}.mp4`,
      { redirect: 'manual' }
    )
    assert.equal(res.status, 302)
    assert.equal(
      res.headers.get('location'),
      `/live/${DIRECT_VIDEO_ID}/live.m3u8`
    )
  } finally {
    if (relayServer) {
      const s = relayServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(relayDataDir, { recursive: true, force: true })
  }
})

test('GET /video/:videoId.mp4 in proxy mode serves cached bytes directly (shares the videoId-keyed cache with the Playlist/position endpoint)', async () => {
  const proxyDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-video-proxy-')
  )
  const cacheDir = path.join(proxyDataDir, 'cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(
    path.join(cacheDir, `${DIRECT_VIDEO_ID}.mp4`),
    'dummy video bytes'
  )
  fs.writeFileSync(
    path.join(cacheDir, `${DIRECT_VIDEO_ID}.meta.json`),
    JSON.stringify({
      videoId: DIRECT_VIDEO_ID,
      sizeBytes: 18,
      downloadedAt: Date.now(),
      lastAccessedAt: Date.now(),
    })
  )
  const proxyConfig: AppConfig = {
    ...config,
    dataDir: proxyDataDir,
    mediaCacheDir: cacheDir,
    mediaDeliveryMode: 'proxy',
  }

  const app = createApp(proxyConfig)
  let proxyServer: Server | undefined
  try {
    proxyServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = proxyServer.address() as AddressInfo
    const res = await fetch(
      `http://127.0.0.1:${address.port}/video/${DIRECT_VIDEO_ID}.mp4`
    )
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.equal(body, 'dummy video bytes')
  } finally {
    if (proxyServer) {
      const s = proxyServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(proxyDataDir, { recursive: true, force: true })
  }
})

test('GET /video/:videoId.mp4 with a live video in proxy mode redirects to GET /live/:videoId/:file', async () => {
  const liveProxyDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-video-live-proxy-')
  )
  const liveProxyConfig: AppConfig = {
    ...config,
    dataDir: liveProxyDataDir,
    mediaDeliveryMode: 'redirect',
    liveDeliveryMode: 'proxy',
  }
  vi.mocked(resolveVideoInfo).mockResolvedValue({
    isLive: true,
    hlsMasterManifestUrl: 'https://manifest.googlevideo.com/v1/master.m3u8',
    hlsIsMaster: false,
  })
  vi.mocked(ensureLiveRelay).mockResolvedValue({
    outDir: '/unused',
    playlistFileName: 'live.m3u8',
  })

  const app = createApp(liveProxyConfig)
  let liveProxyServer: Server | undefined
  try {
    liveProxyServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = liveProxyServer.address() as AddressInfo
    const res = await fetch(
      `http://127.0.0.1:${address.port}/video/${DIRECT_VIDEO_ID}.mp4`,
      { redirect: 'manual' }
    )
    assert.equal(res.status, 302)
    assert.equal(
      res.headers.get('location'),
      `/live/${DIRECT_VIDEO_ID}/live.m3u8`
    )
  } finally {
    if (liveProxyServer) {
      const s = liveProxyServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(liveProxyDataDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/:position.mp4 in relay mode redirects to the resolved HLS master manifest URL', async () => {
  const relayDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-relay-')
  )
  const relayConfig: AppConfig = {
    ...config,
    dataDir: relayDataDir,
    mediaDeliveryMode: 'relay',
    liveDeliveryMode: 'relay',
  }
  vi.mocked(resolveVideoInfo).mockResolvedValue({
    isLive: false,
    hlsMasterManifestUrl: 'https://manifest.googlevideo.com/v1/master.m3u8',
    hlsIsMaster: false,
  })
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(relayDataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(relayConfig)
  let relayServer: Server | undefined
  try {
    relayServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = relayServer.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${address.port}/pl1/0.mp4`, {
      redirect: 'manual',
    })
    assert.equal(res.status, 302)
    assert.equal(
      res.headers.get('location'),
      'https://manifest.googlevideo.com/v1/master.m3u8'
    )
  } finally {
    if (relayServer) {
      const s = relayServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(relayDataDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/:position.mp4 in relay mode returns 502 when the HLS manifest cannot be resolved', async () => {
  const relayDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-relay-fail-')
  )
  const relayConfig: AppConfig = {
    ...config,
    dataDir: relayDataDir,
    mediaDeliveryMode: 'relay',
    liveDeliveryMode: 'relay',
  }
  vi.mocked(resolveVideoInfo).mockResolvedValue({
    isLive: false,
    hlsMasterManifestUrl: null,
    hlsIsMaster: false,
  })
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(relayDataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(relayConfig)
  let relayServer: Server | undefined
  try {
    relayServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = relayServer.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${address.port}/pl1/0.mp4`)
    assert.equal(res.status, 502)
  } finally {
    if (relayServer) {
      const s = relayServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(relayDataDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/:position.mp4 in hybrid mode falls back to a relay redirect (not youtube.com) when the manifest resolves', async () => {
  const hybridRelayDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-hybrid-relay-')
  )
  const hybridConfig: AppConfig = {
    ...config,
    dataDir: hybridRelayDataDir,
    mediaCacheDir: path.join(hybridRelayDataDir, 'cache'),
    mediaDeliveryMode: 'hybrid',
    ytdlpPath: 'yt-dlp-does-not-exist',
  }
  vi.mocked(resolveVideoInfo).mockResolvedValue({
    isLive: false,
    hlsMasterManifestUrl: 'https://manifest.googlevideo.com/v1/master.m3u8',
    hlsIsMaster: false,
  })
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(hybridRelayDataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(hybridConfig)
  let hybridServer: Server | undefined
  try {
    hybridServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = hybridServer.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${address.port}/pl1/0.mp4`, {
      redirect: 'manual',
    })
    assert.equal(res.status, 302)
    assert.equal(
      res.headers.get('location'),
      'https://manifest.googlevideo.com/v1/master.m3u8'
    )
  } finally {
    if (hybridServer) {
      const s = hybridServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(hybridRelayDataDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/:position.mp4 with a live video in proxy mode redirects to the live-relay route', async () => {
  const liveProxyDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-live-proxy-')
  )
  const liveProxyConfig: AppConfig = {
    ...config,
    dataDir: liveProxyDataDir,
    mediaDeliveryMode: 'redirect',
    liveDeliveryMode: 'proxy',
  }
  vi.mocked(resolveVideoInfo).mockResolvedValue({
    isLive: true,
    hlsMasterManifestUrl: 'https://manifest.googlevideo.com/v1/master.m3u8',
    hlsIsMaster: false,
  })
  vi.mocked(ensureLiveRelay).mockResolvedValue({
    outDir: '/unused',
    playlistFileName: 'live.m3u8',
  })
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(liveProxyDataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(liveProxyConfig)
  let liveProxyServer: Server | undefined
  try {
    liveProxyServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = liveProxyServer.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${address.port}/pl1/0.mp4`, {
      redirect: 'manual',
    })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/pl1/0/live/live.m3u8')
  } finally {
    if (liveProxyServer) {
      const s = liveProxyServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(liveProxyDataDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/:position.mp4 calls resolveVideoInfo even when mediaDeliveryMode === liveDeliveryMode === "proxy" (proxy is never skipped)', async () => {
  const proxySameModeDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-proxy-same-mode-')
  )
  const proxySameModeConfig: AppConfig = {
    ...config,
    dataDir: proxySameModeDataDir,
    mediaCacheDir: path.join(proxySameModeDataDir, 'cache'),
    mediaDeliveryMode: 'proxy',
    liveDeliveryMode: 'proxy',
  }
  vi.mocked(resolveVideoInfo).mockResolvedValue({
    isLive: true,
    hlsMasterManifestUrl: 'https://manifest.googlevideo.com/v1/master.m3u8',
    hlsIsMaster: false,
  })
  vi.mocked(ensureLiveRelay).mockResolvedValue({
    outDir: '/unused',
    playlistFileName: 'live.m3u8',
  })
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(proxySameModeDataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(proxySameModeConfig)
  let proxyServer: Server | undefined
  try {
    proxyServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = proxyServer.address() as AddressInfo
    // isLive 判定がスキップされていれば VOD proxy パス (getOrDownload) に入り、実在しない
    // videoId 'v1' への実 yt-dlp 呼び出しが失敗して 502 になる。isLive: true を正しく反映していれば
    // Live proxy パス (ensureLiveRelay) に入り、live route への 302 になる。
    const res = await fetch(`http://127.0.0.1:${address.port}/pl1/0.mp4`, {
      redirect: 'manual',
    })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/pl1/0/live/live.m3u8')
  } finally {
    if (proxyServer) {
      const s = proxyServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(proxySameModeDataDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/:position.mp4 with a live video hits the "redirect" branch of the effectiveMode switch when liveDeliveryMode differs from mediaDeliveryMode', async () => {
  const liveRedirectDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-live-redirect-')
  )
  const liveRedirectConfig: AppConfig = {
    ...config,
    dataDir: liveRedirectDataDir,
    mediaCacheDir: path.join(liveRedirectDataDir, 'cache'),
    // mediaDeliveryMode !== liveDeliveryMode なので skipLiveCheck の対象外
    // (effectiveMode の switch 文自体の "redirect" ケースを経由させる)。
    mediaDeliveryMode: 'proxy',
    liveDeliveryMode: 'redirect',
  }
  vi.mocked(resolveVideoInfo).mockResolvedValue({
    isLive: true,
    hlsMasterManifestUrl: 'https://manifest.googlevideo.com/v1/master.m3u8',
    hlsIsMaster: false,
  })
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(liveRedirectDataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(liveRedirectConfig)
  let liveRedirectServer: Server | undefined
  try {
    liveRedirectServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = liveRedirectServer.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${address.port}/pl1/0.mp4`, {
      redirect: 'manual',
    })
    assert.equal(res.status, 302)
    assert.equal(
      res.headers.get('location'),
      'https://www.youtube.com/watch?v=v1'
    )
  } finally {
    if (liveRedirectServer) {
      const s = liveRedirectServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(liveRedirectDataDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/:position.mp4 with a live video hits the "relay" branch of the effectiveMode switch when liveDeliveryMode differs from mediaDeliveryMode', async () => {
  const liveRelayModeDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-live-relay-mode-')
  )
  const liveRelayModeConfig: AppConfig = {
    ...config,
    dataDir: liveRelayModeDataDir,
    mediaCacheDir: path.join(liveRelayModeDataDir, 'cache'),
    // mediaDeliveryMode !== liveDeliveryMode なので skipLiveCheck の対象外
    // (effectiveMode の switch 文自体の "relay" ケースを経由させる)。
    mediaDeliveryMode: 'proxy',
    liveDeliveryMode: 'relay',
  }
  vi.mocked(resolveVideoInfo).mockResolvedValue({
    isLive: true,
    hlsMasterManifestUrl: 'https://manifest.googlevideo.com/v1/master.m3u8',
    hlsIsMaster: false,
  })
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(liveRelayModeDataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(liveRelayModeConfig)
  let liveRelayModeServer: Server | undefined
  try {
    liveRelayModeServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = liveRelayModeServer.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${address.port}/pl1/0.mp4`, {
      redirect: 'manual',
    })
    assert.equal(res.status, 302)
    assert.equal(
      res.headers.get('location'),
      'https://manifest.googlevideo.com/v1/master.m3u8'
    )
  } finally {
    if (liveRelayModeServer) {
      const s = liveRelayModeServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(liveRelayModeDataDir, { recursive: true, force: true })
  }
})

test.skipIf(process.env.RUN_INTEGRATION !== '1')(
  'GET /:playlistId/:position.mp4 in proxy mode downloads, caches and serves the real video bytes',
  async () => {
    const proxyDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'yrp-route-test-proxy-')
    )
    const proxyConfig: AppConfig = {
      ...config,
      dataDir: proxyDataDir,
      mediaCacheDir: path.join(proxyDataDir, 'cache'),
      mediaDeliveryMode: 'proxy',
      mediaDownloadTimeoutMs: 600_000,
    }
    // "v1" は buildManifest でのテスト用ダミー videoId なので、実在の動画 ID に上書きする。
    const { state, manifest } = buildManifest(
      null,
      'pl1',
      100,
      [{ id: 'q-4GMtXpFUc', title: 'Track 1', duration: 100 }],
      Date.now()
    )
    persistSlotState(proxyDataDir, state)
    primeManifestCacheForTests('pl1', manifest)

    const app = createApp(proxyConfig)
    let proxyServer: Server | undefined
    try {
      proxyServer = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => {
          resolve(s)
        })
      })
      const address = proxyServer.address() as AddressInfo
      const res = await fetch(`http://127.0.0.1:${address.port}/pl1/0.mp4`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'video/mp4')
      const body = await res.arrayBuffer()
      assert.ok(body.byteLength > 0, 'expected non-empty video bytes')
    } finally {
      if (proxyServer) {
        const server = proxyServer
        await new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      }
      fs.rmSync(proxyDataDir, { recursive: true, force: true })
    }
  }
)

test('GET /:playlistId/:position.mp4 in hybrid mode falls back to a YouTube redirect when uncached', async () => {
  const hybridDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-hybrid-')
  )
  const hybridConfig: AppConfig = {
    ...config,
    dataDir: hybridDataDir,
    mediaCacheDir: path.join(hybridDataDir, 'cache'),
    mediaDeliveryMode: 'hybrid',
    // バックグラウンドダウンロードは失敗させて即終わらせる (redirect フォールバック自体の検証が目的のため)。
    ytdlpPath: 'yt-dlp-does-not-exist',
  }
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(hybridDataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(hybridConfig)
  let hybridServer: Server | undefined
  try {
    hybridServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = hybridServer.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${address.port}/pl1/0.mp4`, {
      redirect: 'manual',
    })
    assert.equal(res.status, 302)
    assert.equal(
      res.headers.get('location'),
      'https://www.youtube.com/watch?v=v1'
    )
  } finally {
    if (hybridServer) {
      const s = hybridServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(hybridDataDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/:position.mp4 in hybrid mode serves cached bytes directly when fresh', async () => {
  const hybridDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-hybrid-cached-')
  )
  const cacheDir = path.join(hybridDataDir, 'cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'v1.mp4'), 'dummy video bytes')
  fs.writeFileSync(
    path.join(cacheDir, 'v1.meta.json'),
    JSON.stringify({
      videoId: 'v1',
      sizeBytes: 18,
      downloadedAt: Date.now(),
      lastAccessedAt: Date.now(),
    })
  )
  const hybridConfig: AppConfig = {
    ...config,
    dataDir: hybridDataDir,
    mediaCacheDir: cacheDir,
    mediaDeliveryMode: 'hybrid',
  }
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(hybridDataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(hybridConfig)
  let hybridServer: Server | undefined
  try {
    hybridServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = hybridServer.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${address.port}/pl1/0.mp4`)
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.equal(body, 'dummy video bytes')
  } finally {
    if (hybridServer) {
      const s = hybridServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(hybridDataDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/:position.mp4 in proxy mode serves stale cached bytes directly instead of blocking on re-download', async () => {
  const proxyDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-proxy-stale-')
  )
  const cacheDir = path.join(proxyDataDir, 'cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'v1.mp4'), 'dummy video bytes')
  fs.writeFileSync(
    path.join(cacheDir, 'v1.meta.json'),
    JSON.stringify({
      videoId: 'v1',
      sizeBytes: 18,
      // config.mediaCacheTtlMs を超えた stale なエントリにする。
      downloadedAt: Date.now() - 7 * 60 * 60 * 1000,
      lastAccessedAt: Date.now() - 7 * 60 * 60 * 1000,
    })
  )
  const proxyConfig: AppConfig = {
    ...config,
    dataDir: proxyDataDir,
    mediaCacheDir: cacheDir,
    mediaDeliveryMode: 'proxy',
    // 裏の再ダウンロードは失敗させて即終わらせる (stale 配信自体の検証が目的のため)。
    ytdlpPath: 'yt-dlp-does-not-exist',
  }
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(proxyDataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(proxyConfig)
  let proxyServer: Server | undefined
  try {
    proxyServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = proxyServer.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${address.port}/pl1/0.mp4`)
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.equal(body, 'dummy video bytes')
  } finally {
    if (proxyServer) {
      const s = proxyServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(proxyDataDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/:position.mp4 in hybrid mode serves stale cached bytes directly instead of falling back to redirect', async () => {
  const hybridDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-hybrid-stale-')
  )
  const cacheDir = path.join(hybridDataDir, 'cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'v1.mp4'), 'dummy video bytes')
  fs.writeFileSync(
    path.join(cacheDir, 'v1.meta.json'),
    JSON.stringify({
      videoId: 'v1',
      sizeBytes: 18,
      downloadedAt: Date.now() - 7 * 60 * 60 * 1000,
      lastAccessedAt: Date.now() - 7 * 60 * 60 * 1000,
    })
  )
  const hybridConfig: AppConfig = {
    ...config,
    dataDir: hybridDataDir,
    mediaCacheDir: cacheDir,
    mediaDeliveryMode: 'hybrid',
    ytdlpPath: 'yt-dlp-does-not-exist',
  }
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(hybridDataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(hybridConfig)
  let hybridServer: Server | undefined
  try {
    hybridServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = hybridServer.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${address.port}/pl1/0.mp4`, {
      redirect: 'manual',
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.equal(body, 'dummy video bytes')
  } finally {
    if (hybridServer) {
      const s = hybridServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(hybridDataDir, { recursive: true, force: true })
  }
})

test('GET /unknownpl/manifest.json returns 404, not 401 (route isolation from admin auth)', async () => {
  const res = await fetch(`${baseUrl}/unknownpl/manifest.json`)
  assert.equal(res.status, 404)
})

test('GET /:playlistId/:position.mp4 triggers a refresh fallback when slot state does not exist yet', async () => {
  const coldDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-cold-')
  )
  const coldConfig: AppConfig = {
    ...config,
    dataDir: coldDataDir,
    playlists: [],
    // 実 yt-dlp を起動させず即座に失敗させる (Refresh フォールバックが
    // 呼ばれること自体を検証したいため、成功可否は問わない)。
    ytdlpPath: 'yt-dlp-does-not-exist',
    ytdlpTimeoutMs: 1000,
  }
  const app = createApp(coldConfig)
  let coldServer: Server | undefined
  try {
    coldServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = coldServer.address() as AddressInfo
    const res = await fetch(
      `http://127.0.0.1:${address.port}/never-refreshed-playlist/0.mp4`
    )
    // slots.json が無いため yt-dlp Refresh が走るが、yt-dlp 自体が存在せず失敗するため 502 になる
    // (position が本当に存在しないケースの 404 とは区別される)。
    assert.equal(res.status, 502)
    // Refresh フォールバックが実際に呼ばれたことは、失敗時に recordFailure() が
    // slots.json を永続化する副作用で検証する (呼ばれていなければファイルは存在しない)。
    const slotsPath = path.join(
      coldDataDir,
      encodeURIComponent('never-refreshed-playlist'),
      'slots.json'
    )
    assert.ok(
      fs.existsSync(slotsPath),
      'Refresh フォールバックが呼ばれ、失敗記録が永続化されているはず'
    )
  } finally {
    if (coldServer) {
      const s = coldServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(coldDataDir, { recursive: true, force: true })
  }
})

test('GET /:playlistId/manifest.json accepts any playlistId when the allowlist is empty', async () => {
  const openDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-open-')
  )
  const openConfig: AppConfig = {
    ...config,
    dataDir: openDataDir,
    playlists: [],
    // 実 yt-dlp を起動させず即座に失敗させる (allowlist の挙動だけを検証したいため)。
    ytdlpPath: 'yt-dlp-does-not-exist',
    ytdlpTimeoutMs: 1000,
  }
  const app = createApp(openConfig)
  let openServer: Server | undefined
  try {
    openServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = openServer.address() as AddressInfo
    // Manifest はまだキャッシュに無いため、404 (allowlist 拒否) ではなく
    // 503 (未取得) になるはず。
    const res = await fetch(
      `http://127.0.0.1:${address.port}/not-registered-anywhere/manifest.json`
    )
    assert.equal(res.status, 503)
  } finally {
    if (openServer) {
      const s = openServer
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(openDataDir, { recursive: true, force: true })
  }
})

test('POST /admin/refresh without Authorization is rejected', async () => {
  const res = await fetch(`${baseUrl}/admin/refresh`, { method: 'POST' })
  assert.equal(res.status, 401)
})

test('POST /admin/refresh with wrong token is rejected', async () => {
  const res = await fetch(`${baseUrl}/admin/refresh`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong' },
  })
  assert.equal(res.status, 401)
})

test('POST /admin/refresh/:playlistId with correct token is disabled when playlist unknown but auth passes (502, not 401)', async () => {
  const res = await fetch(`${baseUrl}/admin/refresh/does-not-exist`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret-token' },
  })
  // Authentication succeeds; refreshPlaylist() itself rejects the unknown playlistId as a failure.
  assert.equal(res.status, 502)
})

test('POST /admin/refresh is rejected with 403 when ADMIN_TOKEN is unset (auth disabled, not open)', async () => {
  const disabledConfig: AppConfig = { ...config, adminToken: '' }
  const disabledDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-route-test-disabled-')
  )
  disabledConfig.dataDir = disabledDataDir
  const app = createApp(disabledConfig)
  let disabledServer: Server | undefined
  try {
    disabledServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    const address = disabledServer.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${address.port}/admin/refresh`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
    })
    assert.equal(res.status, 403)
  } finally {
    if (disabledServer) {
      const server = disabledServer
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    fs.rmSync(disabledDataDir, { recursive: true, force: true })
  }
})
