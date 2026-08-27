import assert from 'node:assert/strict'
import { test } from 'vitest'
import { selectEvictions } from '../src/media-cache'

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
