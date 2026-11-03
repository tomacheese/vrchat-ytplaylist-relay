/**
 * Simple mutex that serializes tasks per key.
 * Prevents concurrent refreshes of one playlist from corrupting the Position Pool / Manifest.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>()

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previousTail = this.tails.get(key) ?? Promise.resolve()
    const {
      promise: thisTail,
      resolve: resolveTail,
    }: PromiseWithResolvers<void> = Promise.withResolvers()
    this.tails.set(key, thisTail)

    await previousTail
    try {
      return await task()
    } finally {
      resolveTail()
      if (this.tails.get(key) === thisTail) this.tails.delete(key)
    }
  }
}
