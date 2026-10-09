import { existsSync } from 'node:fs'
import { Queue, UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { env, isDevelopment } from './env.js'
import { prisma } from './db.js'
import { deliver, isPermanent, rollupContent } from './publish.js'

const QUEUE_NAME = 'publish'

let queue: Queue<{ publicationId: string }> | null = null
let worker: Worker<{ publicationId: string }> | null = null
let connection: Redis | null = null
let memoryRedis: { stop: () => Promise<boolean> } | null = null

function redisTarget(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || '6379'}`
  } catch {
    return 'the configured Redis server'
  }
}

function redisConnection(url: string, probe = false) {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    connectTimeout: probe ? 5000 : 10000,
    lazyConnect: probe,
    retryStrategy: probe ? () => null : (attempt) => Math.min(attempt * 200, 2000),
  })
  client.on('error', (error: Error) => {
    if (!probe) console.error(`Redis: ${error.message}`)
  })
  return client
}

async function redisIsCurrent(url: string) {
  const probe = redisConnection(url, true)
  try {
    await probe.connect()
    const info = await probe.info('server')
    const match = /redis_version:(\d+)/.exec(info)
    return Number(match?.[1] ?? 0) >= 5
  } catch (error) {
    const message = error instanceof Error ? error.message : 'connection failed'
    console.error(`Redis probe failed for ${redisTarget(url)}: ${message}`)
    return false
  } finally {
    probe.disconnect()
  }
}

function allowEmbeddedRedis() {
  if (process.env.REDIS_EMBEDDED === '1') return true
  if (process.env.REDIS_EMBEDDED === '0') return false
  if (!isDevelopment()) return false
  return !existsSync('/.dockerenv') && !existsSync('/run/.containerenv')
}

export async function ensureRedis() {
  if (await redisIsCurrent(env.REDIS_URL)) return env.REDIS_URL
  if (!allowEmbeddedRedis()) {
    throw new Error(`Redis at ${redisTarget(env.REDIS_URL)} is unreachable or older than version 5. Set REDIS_URL to a Redis 5+ service.`)
  }
  console.log('Configured Redis is unreachable or older than 5. Starting a local Redis for the publishing queue.')
  const { RedisMemoryServer } = await import('redis-memory-server')
  const memory = new RedisMemoryServer({ instance: { port: 6380 } })
  memoryRedis = memory
  const host = await memory.getHost()
  const port = await memory.getPort()
  return `redis://${host}:${port}`
}

export async function enqueuePublication(publicationId: string, runAt: Date | null) {
  if (!queue) throw new Error('The publishing queue is not running.')
  const delay = Math.max(0, (runAt?.getTime() ?? Date.now()) - Date.now())
  const existing = await queue.getJob(publicationId)
  if (existing) await existing.remove().catch(() => undefined)
  await queue.add('publish', { publicationId }, {
    jobId: publicationId,
    delay,
    attempts: 5,
    backoff: { type: 'exponential', delay: 20_000 },
    removeOnComplete: 200,
    removeOnFail: 200,
  })
}

export async function removePublicationJob(publicationId: string) {
  const existing = await queue?.getJob(publicationId)
  if (existing) await existing.remove().catch(() => undefined)
}

export function retryDecision(error: unknown, attemptsMade: number, maxAttempts: number) {
  if (isPermanent(error)) return 'fail'
  if (attemptsMade < maxAttempts) return 'retry'
  return 'fail'
}

export async function recoverPublications(enqueue: (publicationId: string, runAt: Date | null) => Promise<void>) {
  const pending = await prisma.contentDestination.findMany({
    where: { externalId: null, status: { in: ['scheduled', 'processing'] } },
  })
  for (const publication of pending) {
    if (publication.status === 'processing') {
      await prisma.contentDestination.update({
        where: { id: publication.id },
        data: { status: 'scheduled', lockedAt: null },
      })
    }
    await enqueue(publication.id, publication.scheduledAt)
  }
}

export async function startWorker() {
  if (queue) return
  const url = await ensureRedis()
  const next = redisConnection(url)
  connection = next
  const options = { connection: next as unknown as ConnectionOptions }
  queue = new Queue(QUEUE_NAME, options)
  worker = new Worker(QUEUE_NAME, async (job) => {
    try {
      await deliver(job.data.publicationId)
    } catch (error) {
      if (retryDecision(error, job.attemptsMade, job.opts.attempts ?? 1) === 'fail' && isPermanent(error)) {
        throw new UnrecoverableError(error instanceof Error ? error.message : 'Publishing was rejected.')
      }
      throw error
    }
  }, { ...options, concurrency: 2 })

  worker.on('error', (error) => {
    console.error(`Publishing worker: ${error.message}`)
  })
  queue.on('error', (error) => {
    console.error(`Publishing queue: ${error.message}`)
  })

  worker.on('failed', (job, error) => {
    if (!job) return
    const attempts = job.opts.attempts ?? 1
    const permanent = error instanceof UnrecoverableError || error.name === 'UnrecoverableError'
    if (!permanent && job.attemptsMade < attempts) return
    void prisma.contentDestination.updateMany({
      where: { id: job.data.publicationId, externalId: null, status: { not: 'published' } },
      data: {
        status: 'failed',
        retryable: !permanent,
        lockedAt: null,
        error: error.message,
      },
    }).then(async () => {
      const publication = await prisma.contentDestination.findUnique({ where: { id: job.data.publicationId } })
      if (publication) await rollupContent(publication.contentId)
    })
  })

  try {
    await recoverPublications(enqueuePublication)
  } catch (error) {
    await worker.close().catch(() => undefined)
    await queue.close().catch(() => undefined)
    next.disconnect()
    worker = null
    queue = null
    connection = null
    throw error
  }
}
