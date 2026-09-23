import { randomUUID } from 'node:crypto'
import express, { type Express } from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { AppConfig } from './config'
import { logger, normalizeError } from './logger'
import { adminRouter } from './routes/admin'
import { healthRouter } from './routes/health'
import { liveRouter } from './routes/live'
import { manifestRouter } from './routes/manifest'
import { mediaRouter } from './routes/media'
import { rootRouter } from './routes/root'
import { videoRouter } from './routes/video'

/** Express の route template を返し、未解決時に raw request path を露出させない。 */
function routeTemplate(req: Request): string {
  const matchedRoute = req.route as unknown as { path?: unknown } | undefined
  const routePath = matchedRoute?.path
  const mountedPath: unknown = req.baseUrl
  const baseUrl = typeof mountedPath === 'string' ? mountedPath : ''
  if (typeof routePath === 'string') return `${baseUrl}${routePath}`
  if (Array.isArray(routePath)) return `${baseUrl}${routePath.join('|')}`
  return 'unmatched'
}

export function createApp(config: AppConfig): Express {
  const app = express()
  app.set('trust proxy', config.trustProxy)
  app.disable('x-powered-by')

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = randomUUID()
    const startedAt = performance.now()
    res.setHeader('X-Request-Id', requestId)

    logger.withContext({ request_id: requestId }, () => {
      res.once('finish', () => {
        const route = routeTemplate(req)
        const isHealthCheck = req.method === 'GET' && route === '/health'
        const isRelaySegmentRequest =
          route === '/live/:videoId/:file' ||
          route === '/:playlistId/:position/live/:file'
        const statusCode = res.statusCode
        if ((isHealthCheck || isRelaySegmentRequest) && statusCode < 400) return

        const fields = {
          method: req.method,
          route,
          status_code: statusCode,
          duration_ms: Math.round(performance.now() - startedAt),
        }
        const message = 'HTTP request completed'
        if (statusCode >= 500) {
          logger.error('http.request.completed', message, fields)
        } else if (statusCode >= 400) {
          logger.warn('http.request.completed', message, fields)
        } else {
          logger.info('http.request.completed', message, fields)
        }
      })

      res.once('close', () => {
        if (res.writableFinished) return
        logger.warn('http.request.aborted', 'HTTP request was aborted', {
          method: req.method,
          route: 'incomplete',
          duration_ms: Math.round(performance.now() - startedAt),
        })
      })

      next()
    })
  })

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

  app.use(
    (
      error: unknown,
      req: Request,
      _res: Response,
      next: NextFunction
    ): void => {
      const route = routeTemplate(req)
      const errorStatus =
        typeof error === 'object' && error !== null && 'status' in error
          ? error.status
          : typeof error === 'object' && error !== null && 'statusCode' in error
            ? error.statusCode
            : 500
      const statusCode = typeof errorStatus === 'number' ? errorStatus : 500
      const fields = {
        method: req.method,
        route,
        status_code: statusCode,
        error: normalizeError(error),
      }
      if (statusCode < 500) {
        logger.warn('http.request.failed', 'HTTP request failed', fields)
      } else {
        logger.error(
          'http.request.failed',
          'HTTP request handler failed',
          fields
        )
      }
      next(error)
    }
  )

  return app
}
