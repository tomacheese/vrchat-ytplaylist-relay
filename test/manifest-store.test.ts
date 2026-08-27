import assert from 'node:assert/strict'
import { test } from 'vitest'
import { buildManifest, SlotPoolExhaustedError } from '../src/manifest-store'
import type { YtdlpFlatEntry } from '../src/types'

function entry(id: string, title: string): YtdlpFlatEntry {
  return { id, title, duration: 120 }
}

test('buildManifest assigns increasing slots to new videoIds and builds a manifest in playlist order', () => {
  const { state, manifest } = buildManifest(
    null,
    'pl1',
    10,
    [entry('a', 'Song A'), entry('b', 'Song B')],
    1000
  )

  assert.equal(state.generation, 1)
  assert.equal(state.nextSlot, 2)
  assert.deepEqual(state.videoIdToSlot, { a: 0, b: 1 })

  assert.deepEqual(manifest.tracks, [
    { position: 0, title: 'Song A' },
    { position: 1, title: 'Song B' },
  ])
})

test('buildManifest keeps existing videoId->slot mapping stable across refreshes', () => {
  const first = buildManifest(
    null,
    'pl1',
    10,
    [entry('a', 'Song A'), entry('b', 'Song B')],
    1000
  )
  // 2nd refresh: "a" removed, "c" added, "b" reordered to front.
  const second = buildManifest(
    first.state,
    'pl1',
    10,
    [entry('b', 'Song B'), entry('c', 'Song C')],
    2000
  )

  assert.equal(second.state.generation, 2)
  // "b" keeps its original slot (1), "c" gets a fresh slot (2). "a"'s old slot (0) is not reused.
  assert.equal(second.state.videoIdToSlot.b, 1)
  assert.equal(second.state.videoIdToSlot.c, 2)
  assert.equal(second.state.nextSlot, 3)

  assert.deepEqual(second.manifest.tracks, [
    { position: 1, title: 'Song B' },
    { position: 2, title: 'Song C' },
  ])
})

test('buildManifest does not bump generation when content is unchanged', () => {
  const first = buildManifest(null, 'pl1', 10, [entry('a', 'Song A')], 1000)
  const second = buildManifest(
    first.state,
    'pl1',
    10,
    [entry('a', 'Song A')],
    2000
  )

  assert.equal(second.state.generation, first.state.generation)
  // updatedAt はキャッシュの鮮度として毎回更新される。
  assert.equal(second.manifest.updatedAt, 2000)
})

test('buildManifest throws SlotPoolExhaustedError and does not mutate when the pool is full', () => {
  const first = buildManifest(
    null,
    'pl1',
    2,
    [entry('a', 'A'), entry('b', 'B')],
    1000
  )
  assert.equal(first.state.nextSlot, 2)

  assert.throws(
    () =>
      buildManifest(
        first.state,
        'pl1',
        2,
        [entry('a', 'A'), entry('b', 'B'), entry('c', 'C')],
        2000
      ),
    SlotPoolExhaustedError
  )
})

test('buildManifest re-assigns a stable slot for a videoId that reappears after being dropped', () => {
  const first = buildManifest(null, 'pl1', 10, [entry('a', 'A')], 1000)
  const second = buildManifest(first.state, 'pl1', 10, [], 2000)
  assert.deepEqual(second.manifest.tracks, [])
  // "a" -> slot 0 mapping is retained even though it's temporarily absent from the playlist.
  assert.equal(second.state.videoIdToSlot.a, 0)

  const third = buildManifest(
    second.state,
    'pl1',
    10,
    [entry('a', 'A'), entry('d', 'D')],
    3000
  )
  assert.equal(third.state.videoIdToSlot.a, 0)
  assert.equal(third.state.videoIdToSlot.d, 1)
})
