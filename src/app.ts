import express, { type Express } from 'express'
import type { AppConfig } from './config'
import { adminRouter } from './routes/admin'
import { healthRouter } from './routes/health'
import { liveRouter } from './routes/live'
import { manifestRouter } from './routes/manifest'
import { mediaRouter } from './routes/media'
import { rootRouter } from './routes/root'
import { videoRouter } from './routes/video'

export function createApp(config: AppConfig): Express {
  const app = express()
  app.set('trust proxy', config.trustProxy)
  app.disable('x-powered-by')
  app.use(express.json())

  app.use(rootRouter(config))
  app.use(healthRouter(config))
  app.use(adminRouter(config))
  // manifest.json ("/:playlistId/manifest.json") / live ("/:playlistId/:position/live/:file",
  // "/live/:videoId/:file") を media ("/:playlistId/:positionFile") より先に登録する。media 側は
  // "\d+\.mp4" のみ受理するので誤ってこれらを飲み込むことはないが、より具体的なパスを先に登録する
  // 慣習として順序も揃える。
  // video ("/video/:videoIdParam") は media と同じ 2 セグメント構造を持つ。
  // そのため media より先に登録しないと、playlistId="video" として media 側に奪われ恒久的に到達不能になる。
  app.use(manifestRouter(config))
  app.use(liveRouter(config))
  app.use(videoRouter(config))
  app.use(mediaRouter(config))

  return app
}
