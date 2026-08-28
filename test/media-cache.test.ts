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
  peekFreshCache,
  peekStaleCache,
  prefetchAll,
  selectEvictions,
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
    // 万一バックグラウンドダウンロードが誤って起動されても実害が出ないよう、存在しないバイナリにする。
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
    // 再ダウンロードは失敗させる (stale 配信自体の検証が目的で、実ダウンロードは不要なため)。
    ytdlpPath: 'yt-dlp-does-not-exist',
  })
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

  assert.equal(getFreshOrStale(config, 'v1'), path.join(cacheDir, 'v1.mp4'))

  // triggerBackgroundDownload は完了を待たずに返るため、裏の失敗ログが出るまで少し待って
  // 実際に再ダウンロードが起動されたことを確認する (単に戻り値だけを見ると、
  // バックグラウンド起動が壊れていても気付けないため)。
  await vi.waitFor(() => {
    assert.ok(
      warnSpy.mock.calls.some(([message]) =>
        message.includes('background download failed for video v1')
      )
    )
  })
  warnSpy.mockRestore()
})

test('getFreshOrStale returns the stale path on repeated calls, each triggering its own background re-download attempt', async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-freshstale-test-'))
  seedCacheEntry(cacheDir, 'v1', Date.now() - 120_000)

  const config = makeConfig({
    mediaCacheDir: cacheDir,
    mediaCacheTtlMs: 60_000,
    ytdlpPath: 'yt-dlp-does-not-exist',
  })
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

  assert.equal(getFreshOrStale(config, 'v1'), path.join(cacheDir, 'v1.mp4'))
  assert.equal(getFreshOrStale(config, 'v1'), path.join(cacheDir, 'v1.mp4'))

  // downloadMutex は同一 videoId への実行を直列化するだけで呼び出し自体を間引かないため、
  // 2 回の呼び出しはそれぞれ独立した再ダウンロード試行として順番に失敗する
  // (2 件とも失敗ログが出るまで待って、両方が実際に起動されたことを確認する)。
  await vi.waitFor(() => {
    const failureCalls = warnSpy.mock.calls.filter(([message]) =>
      message.includes('background download failed for video v1')
    )
    assert.equal(failureCalls.length, 2)
  })
  warnSpy.mockRestore()
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
 * `-o <template>` を受け取って動画ファイルの代わりを書き出す偽 yt-dlp スクリプトを作る。
 * `succeedAfter` 回目未満の呼び出しでは `failMessage` を stderr に出して exit 1 する
 * (`downloadVideo` の実際のエラー分岐を、実バイナリなしで再現するため)。
 * 呼び出し回数は `<script>.count` ファイルに記録され、テスト側で検証できる。
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

  // v1 が実際に yt-dlp を起動して失敗した 1 回だけで、v2/v3 はクールダウンによりスキップされる
  // (v3 は個別にログされず、v2 の時点で残り全件がまとめて打ち切られる)。
  assert.equal(readAttemptCount(countPath), 1)
  assert.ok(
    warnSpy.mock.calls.some(([message]) => message.includes('bot detection'))
  )
  assert.ok(
    warnSpy.mock.calls.some(([message]) =>
      message.includes(
        'prefetch cooldown active, skipping remaining videos starting from v2'
      )
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
    warnSpy.mock.calls.some(([message]) =>
      message.includes('prefetch failed for video v1 after retry')
    )
  )
  warnSpy.mockRestore()
}, 10_000)
