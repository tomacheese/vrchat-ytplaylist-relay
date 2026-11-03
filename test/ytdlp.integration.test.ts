import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { downloadVideo, fetchPlaylistEntries } from '../src/ytdlp'

/**
 * Integration test that launches the real yt-dlp binary and smoke-tests it against a real YouTube Playlist.
 * It depends on the network and an external command, so it does not always run in CI; it runs only when RUN_INTEGRATION=1.
 */
const shouldRun = process.env.RUN_INTEGRATION === '1'

test.skipIf(!shouldRun)(
  "fetchPlaylistEntries returns real entries for the scene's actual playlists",
  async () => {
    // Of the 3 Playlists that exist in yamaplayerremoteplaylist.unity, use the one with the most readable entry count, "*でにーム".
    const entries = await fetchPlaylistEntries(
      'PLOCwArr8ScAzVOE91TT7kK3ZCHbYnPV-W',
      {
        ytdlpPath: process.env.YTDLP_PATH ?? 'yt-dlp',
        timeoutMs: 60_000,
      }
    )

    assert.ok(Array.isArray(entries))
    assert.ok(
      entries.length > 0,
      'expected at least one real track in the playlist'
    )
    for (const entry of entries) {
      assert.equal(typeof entry.id, 'string')
      assert.ok(entry.id.length > 0)
    }
  }
)

test.skipIf(!shouldRun)(
  'downloadVideo downloads and ffmpeg-merges a real video into a single mp4 file',
  async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'yrp-ytdlp-download-test-')
    )
    const destPath = path.join(tmpDir, 'video.mp4')
    try {
      // q-4GMtXpFUc: one video in the real Playlist ("*でにーム") listed in the README. It is short and has 1080p.
      await downloadVideo('q-4GMtXpFUc', destPath, {
        ytdlpPath: process.env.YTDLP_PATH ?? 'yt-dlp',
        timeoutMs: 600_000,
        maxHeight: 1080,
      })

      assert.ok(
        fs.existsSync(destPath),
        'expected an mp4 file to be produced at destPath'
      )
      const stat = fs.statSync(destPath)
      assert.ok(stat.size > 0, 'downloaded mp4 must not be empty')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }
)
