import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'
import { isPlaylistAllowed, loadConfig } from '../src/config'

let tempDir: string | undefined

afterEach(() => {
  if (!tempDir) return
  fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

test('loadConfig starts with an empty allowlist when the config file does not exist', () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-config-test-'))
  const configPath = path.join(tempDir, 'does-not-exist.json')

  const config = loadConfig({ configPath })

  assert.deepEqual(config.playlists, [])
})

test('loadConfig loads the allowlist when the config file exists', () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-config-test-'))
  const configPath = path.join(tempDir, 'playlists.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({ playlists: [{ playlistId: 'pl1' }] })
  )

  const config = loadConfig({ configPath })

  assert.deepEqual(config.playlists, [{ playlistId: 'pl1' }])
})

test('loadConfig accepts a config file with an explicit empty "playlists" array', () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-config-test-'))
  const configPath = path.join(tempDir, 'playlists.json')
  fs.writeFileSync(configPath, JSON.stringify({ playlists: [] }))

  const config = loadConfig({ configPath })

  assert.deepEqual(config.playlists, [])
})

test('isPlaylistAllowed allows any playlistId when the allowlist is empty', () => {
  const config = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [],
  })

  assert.equal(isPlaylistAllowed(config, 'anything'), true)
})

test('isPlaylistAllowed rejects playlistIds not in a non-empty allowlist', () => {
  const config = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [{ playlistId: 'pl1' }],
  })

  assert.equal(isPlaylistAllowed(config, 'pl1'), true)
  assert.equal(isPlaylistAllowed(config, 'pl2'), false)
})

test('isPlaylistAllowed rejects path-traversal-shaped playlistIds even when the allowlist is empty', () => {
  const config = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [],
  })

  assert.equal(isPlaylistAllowed(config, '..'), false)
  assert.equal(isPlaylistAllowed(config, '../secret'), false)
})

test('loadConfig defaults liveRelayOutDir to "./data/live" when unset', () => {
  const config = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [],
  })

  assert.equal(config.liveRelayOutDir, path.resolve('./data/live'))
})

test('loadConfig defaults liveRelayIdleTtlMs to 5 minutes when unset', () => {
  const config = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [],
  })

  assert.equal(config.liveRelayIdleTtlMs, 5 * 60 * 1000)
})

test('loadConfig defaults mediaDeliveryMode to "redirect" when unset', () => {
  const config = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [],
  })

  assert.equal(config.mediaDeliveryMode, 'redirect')
})

test('loadConfig accepts "relay" as a valid mediaDeliveryMode', () => {
  const config = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [],
    mediaDeliveryMode: 'relay',
  })

  assert.equal(config.mediaDeliveryMode, 'relay')
})

test('loadConfig accepts "relay-redirect" as a valid mediaDeliveryMode', () => {
  const config = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [],
    mediaDeliveryMode: 'relay-redirect',
  })

  assert.equal(config.mediaDeliveryMode, 'relay-redirect')
})

test('loadConfig rejects an invalid mediaDeliveryMode', () => {
  assert.throws(() => {
    loadConfig({
      configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
      playlists: [],
      mediaDeliveryMode: 'bogus' as unknown as never,
    })
  }, /MEDIA_DELIVERY_MODE/)
})

test('loadConfig defaults liveDeliveryMode to "redirect" when unset', () => {
  const config = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [],
  })

  assert.equal(config.liveDeliveryMode, 'redirect')
})

test('loadConfig accepts "relay" and "proxy" as valid liveDeliveryMode values', () => {
  const relayConfig = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [],
    liveDeliveryMode: 'relay',
  })
  assert.equal(relayConfig.liveDeliveryMode, 'relay')

  const proxyConfig = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [],
    liveDeliveryMode: 'proxy',
  })
  assert.equal(proxyConfig.liveDeliveryMode, 'proxy')
})

test('loadConfig accepts "relay-redirect" as a valid liveDeliveryMode', () => {
  const config = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [],
    liveDeliveryMode: 'relay-redirect',
  })

  assert.equal(config.liveDeliveryMode, 'relay-redirect')
})

test('loadConfig rejects relay-redirect combined with a non-redirect mode', () => {
  assert.throws(
    () =>
      loadConfig({
        configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
        playlists: [],
        mediaDeliveryMode: 'proxy',
        liveDeliveryMode: 'relay-redirect',
      }),
    /MEDIA_DELIVERY_MODE and LIVE_DELIVERY_MODE/
  )
})

test('loadConfig rejects "hybrid" as a liveDeliveryMode', () => {
  assert.throws(() => {
    loadConfig({
      configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
      playlists: [],
      liveDeliveryMode: 'hybrid' as unknown as never,
    })
  }, /LIVE_DELIVERY_MODE/)
})

test('loadConfig treats an empty-string liveDeliveryMode override as unset (defaults to "redirect")', () => {
  const originalEnv = process.env.LIVE_DELIVERY_MODE
  process.env.LIVE_DELIVERY_MODE = ''
  try {
    const config = loadConfig({
      configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
      playlists: [],
    })
    assert.equal(config.liveDeliveryMode, 'redirect')
  } finally {
    if (originalEnv === undefined) delete process.env.LIVE_DELIVERY_MODE
    else process.env.LIVE_DELIVERY_MODE = originalEnv
  }
})

test('loadConfig defaults trustProxy to 1 when TRUST_PROXY is unset', () => {
  const originalEnv = process.env.TRUST_PROXY
  delete process.env.TRUST_PROXY
  try {
    const config = loadConfig({
      configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
      playlists: [],
    })
    assert.equal(config.trustProxy, 1)
  } finally {
    if (originalEnv === undefined) delete process.env.TRUST_PROXY
    else process.env.TRUST_PROXY = originalEnv
  }
})

test('loadConfig reads trustProxy from TRUST_PROXY', () => {
  const originalEnv = process.env.TRUST_PROXY
  process.env.TRUST_PROXY = '2'
  try {
    const config = loadConfig({
      configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
      playlists: [],
    })
    assert.equal(config.trustProxy, 2)
  } finally {
    if (originalEnv === undefined) delete process.env.TRUST_PROXY
    else process.env.TRUST_PROXY = originalEnv
  }
})

test('loadConfig prefers overrides.trustProxy over TRUST_PROXY', () => {
  const config = loadConfig({
    configPath: path.join(os.tmpdir(), 'yrp-config-test-unused.json'),
    playlists: [],
    trustProxy: 5,
  })
  assert.equal(config.trustProxy, 5)
})
