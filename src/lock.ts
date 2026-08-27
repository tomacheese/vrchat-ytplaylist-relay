/**
 * キーごとの直列実行を保証する簡易 Mutex。
 * Playlist 単位の Refresh が同時に複数走って Position Pool / Manifest が壊れることを防ぐ。
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
    }
  }
}
