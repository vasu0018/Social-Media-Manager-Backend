import { config } from 'dotenv'
import { z } from 'zod'

config()

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
  SESSION_SECRET: z.string().min(16),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  MEDIA_URL_SECRET: z.string().min(16),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(8),
  META_GRAPH_VERSION: z.string().default('v26.0'),
  META_APP_ID: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  META_REDIRECT_URI: z.string().default(''),
  INSTAGRAM_APP_ID: z.string().default(''),
  INSTAGRAM_APP_SECRET: z.string().default(''),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_KEY_PREFIX: z.string().default(''),
})

export const env = schema.parse(process.env)

export const metaConfigured = Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_REDIRECT_URI)
export const instagramConfigured = Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET && env.META_REDIRECT_URI)

export function isDevelopment() {
  return env.NODE_ENV !== 'production'
}
