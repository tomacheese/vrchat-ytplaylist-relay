import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp } from '../src/app'
import type { AppConfig } from '../src/config'
import { buildManifest, persistSlotState } from '../src/manifest-store'
import { primeManifestCacheForTests } from '../src/refresh'

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
  deliveryMode: 'redirect',
  mediaMaxHeight: 1080,
  mediaCacheDir: '',
  mediaCacheMaxBytes: 10 * 1024 * 1024 * 1024,
  mediaCacheTtlMs: 6 * 60 * 60 * 1000,
  mediaDownloadTimeoutMs: 600_000,
  playlists: [{ playlistId: 'pl1', displayName: 'Test Playlist' }],
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-route-test-'))
  config.dataDir = dataDir
  config.mediaCacheDir = path.join(dataDir, 'cache')

  // slot 対応表と Manifest キャッシュを事前に生成しておく (yt-dlp の実行自体は別テストで検証済みのためここでは不要)。
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    100,
    [{ id: 'v1', title: 'Track 1', duration: 100 }],
    Date.now()
  )
  persistSlotState(dataDir, state)
  primeManifestCacheForTests('pl1', manifest)

  const app = createApp(config)
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

test('GET /health is public (no Authorization required)', async () => {
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.status, 200)
})

test('GET /:playlistId/manifest.json is public and returns the cached manifest', async () => {
  const res = await fetch(`${baseUrl}/pl1/manifest.json`)
  assert.equal(res.status, 200, 'manifest.json must NOT require Authorization')
  const body = (await res.json()) as { playlistId: string; tracks: unknown[] }
  assert.equal(body.playlistId, 'pl1')
  assert.equal(body.tracks.length, 1)
})

test('GET /:playlistId/:position.mp4 is public and redirects to the canonical YouTube watch URL', async () => {
  const res = await fetch(`${baseUrl}/pl1/0.mp4`, { redirect: 'manual' })
  assert.equal(res.status, 302, 'media redirect must NOT require Authorization')
  assert.equal(
    res.headers.get('location'),
    'https://www.youtube.com/watch?v=v1'
  )
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
      deliveryMode: 'proxy',
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
