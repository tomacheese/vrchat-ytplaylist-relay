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
