import { Queue, UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { env } from './env.js'
import { prisma } from './db.js'
import { deliver, isPermanent, rollupContent } from './publish.js'

const QUEUE_NAME = 'publish'

let queue: Queue<{ publicationId: string }> | null = null
let worker: Worker<{ publicationId: string }> | null = null
let connection: Redis | null = null
let memoryRedis: { stop: () => Promise<boolean> } | null = null

function redisConnection(url: string, probe = false) {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    connectTimeout: 2000,
    retryStrategy: probe ? () => null : (attempt) => Math.min(attempt * 200, 2000),
  })
}

async function redisIsCurrent(url: string) {
  const probe = redisConnection(url, true)
  try {
    const info = await probe.info('server')
    const match = /redis_version:(\d+)/.exec(info)
    return Number(match?.[1] ?? 0) >= 5
  } catch {
    return false
  } finally {
    probe.disconnect()
  }
}

export async function ensureRedis() {
  if (await redisIsCurrent(env.REDIS_URL)) return env.REDIS_URL
  console.log('Configured Redis is older than 5. Starting a compatible Redis for the publishing queue.')
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
  const url = await ensureRedis()
  connection = redisConnection(url)
  const options = { connection: connection as unknown as ConnectionOptions }
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

  await recoverPublications(enqueuePublication)
}
