import assert from 'node:assert/strict'
import { test } from 'vitest'
import { KeyedMutex } from '../src/lock'

test('KeyedMutex serializes successors even when an earlier task completes or fails', async () => {
  const mutex = new KeyedMutex()
  const first: PromiseWithResolvers<void> = Promise.withResolvers()
  const second: PromiseWithResolvers<void> = Promise.withResolvers()
  const events: string[] = []
  const one = mutex
    .run('shared', async () => {
      events.push('one')
      await first.promise
      throw new Error('expected failure')
    })
    .catch(() => undefined)
  const two = mutex.run('shared', async () => {
    events.push('two')
    await second.promise
  })
  first.resolve()
  await one
  const three = mutex.run('shared', () => {
    events.push('three')
    return Promise.resolve()
  })
  await Promise.resolve()
  assert.deepEqual(events, ['one', 'two'])
  second.resolve()
  await Promise.all([two, three])
  assert.deepEqual(events, ['one', 'two', 'three'])
})

test('KeyedMutex releases completed keys after successful and failed tasks', async () => {
  const mutex = new KeyedMutex()
  for (let key = 0; key < 100; key++) {
    await mutex
      .run(String(key), () =>
        key % 2 === 0
          ? Promise.reject(new Error('expected failure'))
          : Promise.resolve()
      )
      .catch(() => undefined)
  }
  const internals = mutex as unknown as { tails: Map<string, Promise<void>> }
  assert.equal(internals.tails.size, 0)
})
