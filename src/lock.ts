/**
 * キーごとの直列実行を保証する簡易 Mutex。
 * Playlist 単位の Refresh が同時に複数走って Position Pool / Manifest が壊れることを防ぐ。
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>()

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previousTail = this.tails.get(key) ?? Promise.resolve()
    let resolveTail!: () => void
    // Promise.withResolvers() は Node.js 22+ が必要 (.node-version は 20.18.1 を対象とする) ため、
    // 従来の new Promise() での resolver 抽出を使う。
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
    const thisTail = new Promise<void>((resolve) => {
      resolveTail = resolve
    })
    this.tails.set(key, thisTail)

    await previousTail
    try {
      return await task()
    } finally {
      resolveTail()
    }
  }
}
