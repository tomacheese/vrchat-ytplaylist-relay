import { createApp } from './app'
import { loadConfig } from './config'
import { logger } from './logger'

const config = loadConfig()
const app = createApp(config)

app.listen(config.port, () => {
  logger.info('server.started', 'HTTP server started', {
    port: config.port,
    media_delivery_mode: config.mediaDeliveryMode,
    live_delivery_mode: config.liveDeliveryMode,
    playlist_count: config.playlists.length,
  })
  if (!config.adminToken) {
    logger.warn(
      'server.admin_disabled',
      'Admin refresh endpoints are disabled because ADMIN_TOKEN is not set'
    )
  }
})
