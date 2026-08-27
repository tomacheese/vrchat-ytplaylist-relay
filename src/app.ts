import express, { type Express } from 'express'
import type { AppConfig } from './config'
import { adminRouter } from './routes/admin'
import { healthRouter } from './routes/health'
import { manifestRouter } from './routes/manifest'
import { mediaRouter } from './routes/media'
import { rootRouter } from './routes/root'

export function createApp(config: AppConfig): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())

  app.use(rootRouter(config))
  app.use(healthRouter(config))
  app.use(adminRouter(config))
  // manifest.json ("/:playlistId/manifest.json") を media ("/:playlistId/:positionFile") より先に登録する。
  // media 側は "\d+\.mp4" のみ受理するので誤って manifest.json を飲み込むことはないが、意図を明確にするため順序も揃える。
  app.use(manifestRouter(config))
  app.use(mediaRouter(config))

  return app
}
