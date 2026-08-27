import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { downloadVideo, fetchPlaylistEntries } from '../src/ytdlp'

/**
 * 実際の yt-dlp バイナリを起動し、実在の YouTube Playlist に対して疎通確認する統合テスト。
 * ネットワークと外部コマンドに依存するため CI では常時実行せず、RUN_INTEGRATION=1 のときのみ実行する。
 */
const shouldRun = process.env.RUN_INTEGRATION === '1'

test.skipIf(!shouldRun)(
  "fetchPlaylistEntries returns real entries for the scene's actual playlists",
  async () => {
    // yamaplayerremoteplaylist.unity に実在する 3 Playlist のうち、最も件数が読みやすい "*でにーム" を使う。
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
      // q-4GMtXpFUc: README に記載の実在 Playlist ("*でにーム") に含まれる動画の 1 つ。短くて 1080p を持つもの。
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
