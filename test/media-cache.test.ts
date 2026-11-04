import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test, vi } from 'vitest'
import type { AppConfig } from '../src/config'
import { logger } from '../src/logger'
import {
  getFreshOrStale,
  getOrDownload,
  peekFreshCache,
  peekStaleCache,
  prefetchAll,
  selectEvictions,
  triggerBackgroundDownload,
} from '../src/media-cache'

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
    manifestRetryDelayMs: 30_000,
    mediaDeliveryMode: 'hybrid',
    liveDeliveryMode: 'redirect',
    liveRelayOutDir: cacheDir ?? '',
    liveRelayIdleTtlMs: 5 * 60 * 1000,
    liveRelayMaxBytes: 10 * 1024 * 1024 * 1024,
    mediaMaxHeight: 1080,
    mediaCacheDir: cacheDir ?? '',
    mediaCacheMaxBytes: 10 * 1024 * 1024 * 1024,
    mediaCacheTtlMs: 6 * 60 * 60 * 1000,
    mediaDownloadTimeoutMs: 600_000,
    trustProxy: 1,
    playlists: [],
    ...overrides,
  }
}

/** Directly writes the cache file and metadata for a videoId that peekFreshCache reads. */
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

test('peekStaleCache returns the cached file path even when the entry has exceeded the TTL', () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-stale-test-'))
  seedCacheEntry(cacheDir, 'v1', Date.now() - 120_000)

  const config = makeConfig({
    mediaCacheDir: cacheDir,
    mediaCacheTtlMs: 60_000,
  })

  assert.equal(peekStaleCache(config, 'v1'), path.join(cacheDir, 'v1.mp4'))
})

test('peekStaleCache returns the cached file path when the entry is within TTL too', () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-stale-test-'))
  seedCacheEntry(cacheDir, 'v1', Date.now())

  const config = makeConfig({
    mediaCacheDir: cacheDir,
    mediaCacheTtlMs: 60_000,
  })

  assert.equal(peekStaleCache(config, 'v1'), path.join(cacheDir, 'v1.mp4'))
})

test('peekStaleCache returns null when there is no cached entry at all', () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-stale-test-'))

  const config = makeConfig({ mediaCacheDir: cacheDir })

  assert.equal(peekStaleCache(config, 'v1'), null)
})

test('getFreshOrStale returns the fresh path without touching download when within TTL', () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-freshstale-test-'))
  seedCacheEntry(cacheDir, 'v1', Date.now())

  const config = makeConfig({
    mediaCacheDir: cacheDir,
    mediaCacheTtlMs: 60_000,
    // Use a nonexistent binary so a background download started by mistake does no real harm.
    ytdlpPath: 'yt-dlp-does-not-exist',
  })

  assert.equal(getFreshOrStale(config, 'v1'), path.join(cacheDir, 'v1.mp4'))
})

test('getFreshOrStale returns the stale path immediately and triggers a background re-download', async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-freshstale-test-'))
  seedCacheEntry(cacheDir, 'v1', Date.now() - 120_000)

  const config = makeConfig({
    mediaCacheDir: cacheDir,
    mediaCacheTtlMs: 60_000,
    // Make the re-download fail (the goal is to verify stale serving; a real download is unnecessary).
    ytdlpPath: 'yt-dlp-does-not-exist',
  })
  const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)

  assert.equal(getFreshOrStale(config, 'v1'), path.join(cacheDir, 'v1.mp4'))

  // triggerBackgroundDownload returns without waiting for completion, so wait briefly for the
  // background failure log to confirm a re-download was actually started (checking only the
  // return value would not notice if the background start were broken).
  await vi.waitFor(() => {
    assert.ok(
      errorSpy.mock.calls.some(
        ([event, , fields]) =>
          event === 'media.cache.download_failed' &&
          (fields as { video_id?: string }).video_id === 'v1'
      )
    )
  })
  errorSpy.mockRestore()
})

test('background cache preparation failures retain a structured error log', async () => {
  cacheDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yrp-background-cache-test-')
  )
  const blocker = path.join(cacheDir, 'not-a-directory')
  fs.writeFileSync(blocker, 'file')
  const config = makeConfig({ mediaCacheDir: path.join(blocker, 'cache') })
  const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)

  try {
    triggerBackgroundDownload(config, 'v1')

    await vi.waitFor(() => {
      const failed = errorSpy.mock.calls.find(
        ([event]) => event === 'media.cache.download_failed'
      )
      assert.ok(failed)
      assert.equal((failed[2] as { phase?: string }).phase, 'prepare')
    })
  } finally {
    errorSpy.mockRestore()
  }
})

test('getFreshOrStale returns the stale path on repeated calls, each triggering its own background re-download attempt', async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-freshstale-test-'))
  seedCacheEntry(cacheDir, 'v1', Date.now() - 120_000)

  const config = makeConfig({
    mediaCacheDir: cacheDir,
    mediaCacheTtlMs: 60_000,
    ytdlpPath: 'yt-dlp-does-not-exist',
  })
  const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)

  assert.equal(getFreshOrStale(config, 'v1'), path.join(cacheDir, 'v1.mp4'))
  assert.equal(getFreshOrStale(config, 'v1'), path.join(cacheDir, 'v1.mp4'))

  // downloadMutex only serializes runs for the same videoId and does not collapse calls, so
  // the two calls fail in turn as independent re-download attempts
  // (wait until both failure logs appear to confirm both were actually started).
  await vi.waitFor(() => {
    const failureCalls = errorSpy.mock.calls.filter(
      ([event, , fields]) =>
        event === 'media.cache.download_failed' &&
        (fields as { video_id?: string }).video_id === 'v1'
    )
    assert.equal(failureCalls.length, 2)
  })
  errorSpy.mockRestore()
})

test('getFreshOrStale returns null when there is no cached entry at all', () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-freshstale-test-'))

  const config = makeConfig({
    mediaCacheDir: cacheDir,
    ytdlpPath: 'yt-dlp-does-not-exist',
  })

  assert.equal(getFreshOrStale(config, 'v1'), null)
})

/**
 * Creates a fake yt-dlp script that takes `-o <template>` and writes a stand-in video file.
 * Calls before the `succeedAfter`-th print `failMessage` to stderr and exit 1
 * (to reproduce `downloadVideo`'s real error branches without the real binary).
 * The call count is recorded in a `<script>.count` file so tests can check it.
 */
function makeFakeYtdlp(
  dir: string,
  options: { failMessage: string; succeedAfter: number }
): { scriptPath: string; countPath: string } {
  const scriptPath = path.join(dir, `fake-ytdlp-${crypto.randomUUID()}.mjs`)
  const countPath = `${scriptPath}.count`
  fs.writeFileSync(countPath, '0')
  fs.writeFileSync(
    scriptPath,
    String.raw`#!/usr/bin/env node
import fs from 'node:fs'
const countPath = ${JSON.stringify(countPath)}
const attempt = Number(fs.readFileSync(countPath, 'utf8')) + 1
fs.writeFileSync(countPath, String(attempt))
if (attempt < ${JSON.stringify(options.succeedAfter)}) {
  process.stderr.write(${JSON.stringify(options.failMessage)} + '\n')
  process.exit(1)
}
const args = process.argv.slice(2)
const template = args[args.indexOf('-o') + 1]
fs.writeFileSync(template.replace('%(ext)s', 'mp4'), 'dummy video bytes')
`
  )
  fs.chmodSync(scriptPath, 0o755)
  return { scriptPath, countPath }
}

function readAttemptCount(countPath: string): number {
  return Number(fs.readFileSync(countPath, 'utf8'))
}

test('prefetchAll pauses subsequent videos after a bot-detection error, without retrying', async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-prefetch-test-'))
  const { scriptPath, countPath } = makeFakeYtdlp(cacheDir, {
    failMessage: 'ERROR: [youtube] v: Sign in to confirm you’re not a bot.',
    succeedAfter: Number.MAX_SAFE_INTEGER,
  })
  const config = makeConfig({ mediaCacheDir: cacheDir, ytdlpPath: scriptPath })
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

  await prefetchAll(config, ['v1', 'v2', 'v3'], 1)

  // Only v1 actually launched yt-dlp and failed (once); v2/v3 are skipped by the cooldown
  // (v3 is not logged individually; the rest are cut off together at v2).
  assert.equal(readAttemptCount(countPath), 1)
  assert.ok(
    warnSpy.mock.calls.some(([event]) => event === 'media.prefetch.failed')
  )
  assert.ok(
    warnSpy.mock.calls.some((call) => {
      const fields = call[2]
      const error = (fields as { error?: { stderr?: string } }).error
      return error?.stderr?.includes('bot') ?? false
    })
  )
  assert.ok(
    warnSpy.mock.calls.some(
      ([event, , fields]) =>
        event === 'media.prefetch.cooldown' &&
        (fields as { video_id?: string }).video_id === 'v2'
    )
  )
  warnSpy.mockRestore()
})

test('prefetchAll does not retry a permanently unavailable video', async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-prefetch-test-'))
  const { scriptPath, countPath } = makeFakeYtdlp(cacheDir, {
    failMessage: 'ERROR: [youtube] v1: Video unavailable',
    succeedAfter: Number.MAX_SAFE_INTEGER,
  })
  const config = makeConfig({ mediaCacheDir: cacheDir, ytdlpPath: scriptPath })
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

  await prefetchAll(config, ['v1'], 1)

  assert.equal(readAttemptCount(countPath), 1)
  warnSpy.mockRestore()
})

test('prefetchAll retries once on a transient error and succeeds', async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-prefetch-test-'))
  const { scriptPath, countPath } = makeFakeYtdlp(cacheDir, {
    failMessage: 'yt-dlp timed out after 600000ms for video v1',
    succeedAfter: 2,
  })
  const config = makeConfig({ mediaCacheDir: cacheDir, ytdlpPath: scriptPath })
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

  await prefetchAll(config, ['v1'], 1)

  assert.equal(readAttemptCount(countPath), 2)
  assert.equal(peekFreshCache(config, 'v1'), path.join(cacheDir, 'v1.mp4'))
  warnSpy.mockRestore()
}, 10_000)

test('prefetchAll gives up after the retry also fails on a transient error', async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-prefetch-test-'))
  const { scriptPath, countPath } = makeFakeYtdlp(cacheDir, {
    failMessage: 'yt-dlp timed out after 600000ms for video v1',
    succeedAfter: Number.MAX_SAFE_INTEGER,
  })
  const config = makeConfig({ mediaCacheDir: cacheDir, ytdlpPath: scriptPath })
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

  await prefetchAll(config, ['v1'], 1)

  assert.equal(readAttemptCount(countPath), 2)
  assert.ok(
    warnSpy.mock.calls.some(
      ([event, , fields]) =>
        event === 'media.prefetch.failed' &&
        (fields as { reason?: string }).reason === 'after retry'
    )
  )
  warnSpy.mockRestore()
}, 10_000)

test('getOrDownload rejects a video larger than the cache budget while retaining existing cache entries', async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-cache-limit-'))
  const { scriptPath } = makeFakeYtdlp(cacheDir, {
    failMessage: '',
    succeedAfter: 1,
  })
  seedCacheEntry(cacheDir, 'existing', Date.now())
  const config = makeConfig({ ytdlpPath: scriptPath, mediaCacheMaxBytes: 1 })
  await assert.rejects(
    getOrDownload(config, 'newvideo'),
    /exceeds the cache size limit/
  )
  assert.equal(
    fs.readFileSync(path.join(cacheDir, 'existing.mp4'), 'utf8'),
    'dummy video bytes'
  )
  assert.equal(fs.existsSync(path.join(cacheDir, 'newvideo.mp4')), false)
  assert.equal(fs.existsSync(path.join(cacheDir, 'newvideo.meta.json')), false)
})

test('getOrDownload serializes temporary fills across video IDs in one cache directory', async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-cache-serial-'))
  const scriptPath = path.join(cacheDir, 'serial-ytdlp.mjs')
  const activePath = path.join(cacheDir, 'download.active')
  const overlapPath = path.join(cacheDir, 'download.overlap')
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs'
if (fs.existsSync(${JSON.stringify(activePath)})) fs.writeFileSync(${JSON.stringify(overlapPath)}, 'overlap')
fs.writeFileSync(${JSON.stringify(activePath)}, '')
const args = process.argv.slice(2)
const template = args[args.indexOf('-o') + 1]
fs.writeFileSync(template.replace('%(ext)s', 'mp4'), 'dummy video bytes')
setTimeout(() => { fs.rmSync(${JSON.stringify(activePath)}, { force: true }) }, 100)
`
  )
  fs.chmodSync(scriptPath, 0o755)
  const config = makeConfig({
    mediaCacheDir: cacheDir,
    ytdlpPath: scriptPath,
  })
  await Promise.all([
    getOrDownload(config, 'video-one'),
    getOrDownload(config, 'video-two'),
  ])
  assert.equal(fs.existsSync(overlapPath), false)
})
