import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'
import type { AppConfig } from '../src/config'
import { clearResolveCache } from '../src/live-resolve'
import { ensureLiveRelay, stopLiveRelay } from '../src/live-relay'

/**
 * Integration test that depends on real yt-dlp / ffmpeg / network. Not run in CI by default;
 * only runs with RUN_INTEGRATION=1 (same policy as ytdlp.integration.test.ts).
 */
const shouldRun = process.env.RUN_INTEGRATION === '1'

// Lofi Girl 24/7 stream, for smoke-testing against a real running live. Fixed videoId, so replace it if the stream ends.
const LIVE_VIDEO_ID = 'jfKfPfyJRdk'

let outDir: string | undefined

afterEach(async () => {
  clearResolveCache()
  await stopLiveRelay(LIVE_VIDEO_ID)
  if (!outDir) return
  fs.rmSync(outDir, { recursive: true, force: true })
  outDir = undefined
})

test.skipIf(!shouldRun)(
  'ensureLiveRelay republishes a real 24/7 Live video as local HLS files',
  async () => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-live-relay-int-'))
    const config: AppConfig = {
      port: 0,
      configPath: 'test-config',
      dataDir: outDir,
      adminToken: null,
      ytdlpPath: process.env.YTDLP_PATH ?? 'yt-dlp',
      defaultMaxSlots: 100,
      ytdlpTimeoutMs: 60_000,
      manifestCacheTtlMs: 300_000,
      manifestRetryDelayMs: 30_000,
      mediaDeliveryMode: 'redirect',
      liveDeliveryMode: 'proxy',
      liveRelayOutDir: outDir,
      liveRelayIdleTtlMs: 5 * 60 * 1000,
      liveRelayMaxBytes: 10 * 1024 * 1024 * 1024,
      mediaMaxHeight: 1080,
      mediaCacheDir: path.join(outDir, 'cache'),
      mediaCacheMaxBytes: 10 * 1024 * 1024 * 1024,
      mediaCacheTtlMs: 6 * 60 * 60 * 1000,
      mediaDownloadTimeoutMs: 600_000,
      trustProxy: 1,
      playlists: [],
    }

    const result = await ensureLiveRelay(config, LIVE_VIDEO_ID)
    assert.ok(
      'outDir' in result,
      `expected success, got: ${JSON.stringify(result)}`
    )
    if (!('outDir' in result)) return

    const playlistPath = path.join(result.outDir, result.playlistFileName)
    assert.ok(
      fs.existsSync(playlistPath),
      'expected the local HLS master playlist to be written'
    )
    const segments = fs
      .readdirSync(result.outDir)
      .filter((name) => /^live\d+\.ts$/.test(name))
    assert.ok(segments.length > 0, 'expected at least one HLS segment file')
  },
  30_000
)
