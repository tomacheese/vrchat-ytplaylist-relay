import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'vitest'
import { loadSlotState, withSlotStateLock } from '../src/manifest-store'

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-lock-test-'))
}

function lockPathFor(dataDir: string, playlistId: string): string {
  return path.join(dataDir, encodeURIComponent(playlistId), 'slots.json.lock')
}

function runWorker(
  dataDir: string,
  playlistId: string,
  prefix: string,
  count: number
): Promise<number | null> {
  const workerPath = path.join(
    import.meta.dirname,
    'helpers',
    'slot-lock-worker.ts'
  )
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        workerPath,
        dataDir,
        playlistId,
        prefix,
        String(count),
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    )
    child.on('error', reject)
    child.on('exit', (code) => {
      resolve(code)
    })
  })
}

test('concurrent processes keep every slot assignment', async () => {
  const dataDir = tempDataDir()
  const count = 50

  const codes = await Promise.all([
    runWorker(dataDir, 'PLlock', 'a', count),
    runWorker(dataDir, 'PLlock', 'b', count),
  ])

  assert.deepEqual(codes, [0, 0])
  const state = loadSlotState(dataDir, 'PLlock')
  assert.ok(state)
  const ids = Object.keys(state.videoIdToSlot)
  assert.equal(ids.length, count * 2)
  const slots = Object.values(state.videoIdToSlot)
  assert.equal(new Set(slots).size, count * 2)
  for (const [videoId, slot] of Object.entries(state.videoIdToSlot)) {
    assert.equal(state.slotToVideoId[String(slot)], videoId)
  }

  fs.rmSync(dataDir, { recursive: true, force: true })
}, 30_000)

test('withSlotStateLock waits for an externally held lock', async () => {
  const dataDir = tempDataDir()
  const lockPath = lockPathFor(dataDir, 'PLwait')
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(lockPath, 'other')
  let calls = 0

  const pending = withSlotStateLock(
    dataDir,
    'PLwait',
    () => {
      calls += 1
    },
    { pollMs: 10 }
  )
  await sleep(100)
  assert.equal(calls, 0)

  fs.unlinkSync(lockPath)
  await pending
  assert.equal(calls, 1)

  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('withSlotStateLock rejects with the timeout message while the lock is fresh', async () => {
  const dataDir = tempDataDir()
  const lockPath = lockPathFor(dataDir, 'PLtimeout')
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(lockPath, 'other')
  let calls = 0

  await assert.rejects(
    withSlotStateLock(
      dataDir,
      'PLtimeout',
      () => {
        calls += 1
      },
      { timeoutMs: 100, staleMs: 10_000, pollMs: 10 }
    ),
    {
      message: `Timed out acquiring Position Pool lock for playlist PLtimeout (${lockPath})`,
    }
  )
  assert.equal(calls, 0)

  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('withSlotStateLock reclaims a stale lock', async () => {
  const dataDir = tempDataDir()
  const lockPath = lockPathFor(dataDir, 'PLstale')
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(lockPath, 'crashed')
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(lockPath, past, past)

  const result = await withSlotStateLock(dataDir, 'PLstale', () => 'ran', {
    staleMs: 100,
  })

  assert.equal(result, 'ran')
  assert.equal(fs.existsSync(lockPath), false)

  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('withSlotStateLock releases the lock and propagates fn errors', async () => {
  const dataDir = tempDataDir()
  const lockPath = lockPathFor(dataDir, 'PLrelease')

  assert.equal(await withSlotStateLock(dataDir, 'PLrelease', () => 42), 42)
  assert.equal(fs.existsSync(lockPath), false)

  const failure = new Error('boom')
  await assert.rejects(
    withSlotStateLock(dataDir, 'PLrelease', () => {
      throw failure
    }),
    (error: unknown) => error === failure
  )
  assert.equal(fs.existsSync(lockPath), false)

  fs.rmSync(dataDir, { recursive: true, force: true })
})
