#!/usr/bin/env node
import { loadConfig } from './config'
import { logger } from './logger'
import { refreshAll, refreshPlaylist } from './refresh'

/**
 * CLI for administration over SSH.
 *
 *   playlistctl refresh              # refresh all playlists
 *   playlistctl refresh <playlistId> # refresh only the given playlist
 *
 * Calls the refresh logic directly without HTTP, so it works even when ADMIN_TOKEN is unset.
 * Manifests are fetched automatically (with a TTL cache) on client requests, so normal operation
 * does not need this CLI. Use it only to force-invalidate the cache without waiting for the TTL.
 */
async function main() {
  // process.argv.slice(2) is typed string[] (elements may be undefined when missing), so
  // spell it as a tuple type to also express the no-command (no arguments) case.
  const [command, playlistId] = process.argv.slice(2) as [string?, string?]
  if (command !== 'refresh') {
    logger.error('cli.command.failed', 'Unknown command', {
      command: command ?? '(none)',
      usage: 'playlistctl refresh [playlistId]',
    })
    process.exitCode = 1
    return
  }

  const config = loadConfig()

  if (playlistId) {
    const result = await refreshPlaylist(config, playlistId, {
      warmRelayVideos: false,
    })
    logger.info('cli.refresh.completed', 'Playlist refresh command completed', {
      ...result,
    })
    process.exitCode = result.ok ? 0 : 1
    return
  }

  const results = await refreshAll(config, { warmRelayVideos: false })
  logger.info(
    'cli.refresh_all.completed',
    'Playlist refresh command completed',
    {
      results,
    }
  )
  process.exitCode = results.every((r) => r.ok) ? 0 : 1
}

main().catch((err: unknown) => {
  logger.error('cli.command.failed', 'CLI command failed', {
    error: err instanceof Error ? err : new Error(String(err)),
  })
  process.exitCode = 1
})
