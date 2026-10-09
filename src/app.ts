import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import { HttpError } from './domain.js'
import { env } from './env.js'
import { api } from './routes.js'
import { redact } from './security.js'

export function createApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(cors({
    origin: env.CLIENT_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  }))
  app.use(cookieParser())
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', api)
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message })
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
    if (code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Files must be 300 MB or smaller.' })
    const message = error instanceof Error ? error.message : 'Request failed'
    console.error(redact(message))
    res.status(500).json({ error: 'Something went wrong.' })
  })
  return app
}
