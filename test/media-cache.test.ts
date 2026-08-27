import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'
import type { AppConfig } from '../src/config'
import { peekFreshCache, selectEvictions } from '../src/media-cache'

function entry(videoId: string, sizeBytes: number, lastAccessedAt: number) {
  return { videoId, sizeBytes, downloadedAt: lastAccessedAt, lastAccessedAt }
}

test('selectEvictions returns nothing when total size is within the limit', () => {
  const entries = [entry('a', 100, 1000), entry('b', 100, 2000)]
  assert.deepEqual(selectEvictions(entries, 1000), [])
})

test('selectEvictions evicts least-recently-accessed entries first until under the limit', () => {
  const entries = [
    entry('a', 100, 3000),
    entry('b', 100, 1000),
    entry('c', 100, 2000),
  ]
  // total = 300, limit = 150 -> must evict oldest (b, lastAccessedAt=1000) first, then next-oldest (c).
  assert.deepEqual(selectEvictions(entries, 150), ['b', 'c'])
})

test('selectEvictions evicts exactly down to (not below) the limit', () => {
  const entries = [
    entry('a', 50, 1000),
    entry('b', 50, 2000),
    entry('c', 50, 3000),
  ]
  // total = 150, limit = 100 -> evicting "a" alone (50) leaves 100, which satisfies remaining <= maxBytes.
  assert.deepEqual(selectEvictions(entries, 100), ['a'])
})

test('selectEvictions returns an empty array for an empty cache', () => {
  assert.deepEqual(selectEvictions([], 1000), [])
})

let cacheDir: string | undefined

afterEach(() => {
  if (!cacheDir) return
  fs.rmSync(cacheDir, { recursive: true, force: true })
  cacheDir = undefined
})

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
    deliveryMode: 'hybrid',
    mediaMaxHeight: 1080,
    mediaCacheDir: cacheDir ?? '',
    mediaCacheMaxBytes: 10 * 1024 * 1024 * 1024,
    mediaCacheTtlMs: 6 * 60 * 60 * 1000,
    mediaDownloadTimeoutMs: 600_000,
    playlists: [],
    ...overrides,
  }
}

/** peekFreshCache が読む videoId 用のキャッシュファイル・メタデータを直接書き込む。 */
function seedCacheEntry(
  dir: string,
  videoId: string,
  downloadedAt: number
): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${videoId}.mp4`), 'dummy video bytes')
  fs.writeFileSync(
    path.join(dir, `${videoId}.meta.json`),
    JSON.stringify({
      videoId,
      sizeBytes: 18,
      downloadedAt,
      lastAccessedAt: downloadedAt,
    })
  )
}

test('peekFreshCache returns the cached file path when the entry is within TTL', () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-peek-test-'))
  seedCacheEntry(cacheDir, 'v1', Date.now())

  const config = makeConfig({
    mediaCacheDir: cacheDir,
    mediaCacheTtlMs: 60_000,
  })

  const result = peekFreshCache(config, 'v1')

  assert.equal(result, path.join(cacheDir, 'v1.mp4'))
})

test('peekFreshCache returns null when the cached entry has exceeded the TTL', () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-peek-test-'))
  seedCacheEntry(cacheDir, 'v1', Date.now() - 120_000)

  const config = makeConfig({
    mediaCacheDir: cacheDir,
    mediaCacheTtlMs: 60_000,
  })

  assert.equal(peekFreshCache(config, 'v1'), null)
})

test('peekFreshCache returns null when there is no cached entry at all', () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-peek-test-'))

  const config = makeConfig({ mediaCacheDir: cacheDir })

  assert.equal(peekFreshCache(config, 'unknown'), null)
})
