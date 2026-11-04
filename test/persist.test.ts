import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import {
  buildManifest,
  loadSlotState,
  persistSlotState,
  recordFailure,
} from '../src/manifest-store'

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-test-'))
}

test('persistSlotState writes slots.json atomically and round-trips via loadSlotState', () => {
  const dataDir = tempDataDir()
  const { state } = buildManifest(
    null,
    'PLxyz',
    10,
    [{ id: 'v1', title: 'T1', duration: 10 }],
    12_345
  )

  persistSlotState(dataDir, state)

  const loaded = loadSlotState(dataDir, 'PLxyz')
  assert.ok(loaded)
  assert.equal(loaded.generation, 1)
  assert.equal(loaded.videoIdToSlot.v1, 0)
  // Actual Playlist data (Track order / Title) is not persisted.
  assert.ok(!('order' in (loaded as object)))
  assert.ok(!('titles' in (loaded as object)))

  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('recordFailure preserves the previously persisted slot allocation untouched', () => {
  const dataDir = tempDataDir()
  const { state } = buildManifest(
    null,
    'PLxyz',
    10,
    [{ id: 'v1', title: 'T1', duration: 10 }],
    111
  )
  persistSlotState(dataDir, state)

  recordFailure(dataDir, 'PLxyz', 10, 'yt-dlp exploded', 222)

  const loaded = loadSlotState(dataDir, 'PLxyz')
  assert.ok(loaded)
  assert.equal(loaded.lastRefreshOk, false)
  assert.equal(loaded.lastError, 'yt-dlp exploded')
  // The Position Pool mapping and generation are kept after a failure.
  assert.equal(loaded.videoIdToSlot.v1, 0)
  assert.equal(loaded.generation, 1)

  fs.rmSync(dataDir, { recursive: true, force: true })
})
