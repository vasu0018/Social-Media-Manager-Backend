import type { NextFunction, Request, Response } from 'express'
import { env } from './env.js'

const buckets = new Map<string, { count: number; reset: number }>()

export function resetLimits() {
  buckets.clear()
}

export function redact(value: string) {
  return value
    .replace(/EAA[A-Za-z0-9]+/g, '[redacted]')
    .replace(/(access_token|client_secret|password|authorization|token)=([^&\s]+)/gi, '$1=[redacted]')
}

export function rateLimit(name: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'local'
    const key = `${name}:${ip}`
    const now = Date.now()
    const current = buckets.get(key)
    if (!current || current.reset <= now) {
      buckets.set(key, { count: 1, reset: now + windowMs })
      return next()
    }
    if (current.count >= max) {
      res.setHeader('Retry-After', String(Math.ceil((current.reset - now) / 1000)))
      return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' })
    }
    current.count += 1
    next()
  }
}

function allowedOrigin(value: string | undefined) {
  if (!value) return false
  try {
    return new URL(value).origin === env.CLIENT_ORIGIN
  } catch {
    return value === env.CLIENT_ORIGIN
  }
}

export function guardRequest(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  if (req.path === '/oauth/callback' || req.path === '/auth/meta/callback') return next()
  const origin = req.get('origin')
  const referer = req.get('referer')
  if (origin) {
    if (!allowedOrigin(origin)) return res.status(403).json({ error: 'This request was blocked.' })
    return next()
  }
  if (referer) {
    if (!allowedOrigin(referer)) return res.status(403).json({ error: 'This request was blocked.' })
    return next()
  }
  if (env.NODE_ENV === 'production') return res.status(403).json({ error: 'This request was blocked.' })
  next()
}
