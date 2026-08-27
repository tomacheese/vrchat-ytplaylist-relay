import { createApp } from './app'
import { loadConfig } from './config'
import { logger } from './logger'

const config = loadConfig()
const app = createApp(config)

app.listen(config.port, () => {
  logger.info(`listening on :${config.port}`)
  logger.info(
    `playlists: ${config.playlists.map((p) => p.playlistId).join(', ')}`
  )
  if (!config.adminToken) {
    logger.warn(
      'ADMIN_TOKEN is not set: /admin/refresh endpoints are disabled. Use `pnpm run refresh` (CLI) instead.'
    )
  }
})
