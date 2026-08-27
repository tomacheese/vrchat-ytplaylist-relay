#!/usr/bin/env node
import { loadConfig } from './config'
import { logger } from './logger'
import { refreshAll, refreshPlaylist } from './refresh'

/**
 * SSH 経由の管理操作用 CLI。
 *
 *   playlistctl refresh              # 全 Playlist を Refresh
 *   playlistctl refresh <playlistId> # 指定 Playlist のみ Refresh
 *
 * HTTP を経由せず直接 Refresh 処理を呼ぶため、ADMIN_TOKEN が未設定でも動作する。
 * Manifest は Client 要求時に TTL キャッシュ付きで自動取得されるため、通常運用でこの CLI を
 * 実行する必要はない。TTL 経過を待たずにキャッシュを強制的に無効化したい場合にのみ使う。
 */
async function main() {
  // process.argv.slice(2) は string[] (要素が足りなければ undefined) を返すため、
  // タプル型として明示し command 未指定 (引数なし) のケースを型上も表現する。
  const [command, playlistId] = process.argv.slice(2) as [string?, string?]
  if (command !== 'refresh') {
    logger.error(
      `Unknown command: ${command ?? '(none)'}. Usage: playlistctl refresh [playlistId]`
    )
    process.exitCode = 1
    return
  }

  const config = loadConfig()

  if (playlistId) {
    const result = await refreshPlaylist(config, playlistId)
    logger.info(JSON.stringify(result))
    process.exitCode = result.ok ? 0 : 1
    return
  }

  const results = await refreshAll(config)
  logger.info(JSON.stringify(results))
  process.exitCode = results.every((r) => r.ok) ? 0 : 1
}

main().catch((err: unknown) => {
  logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})
