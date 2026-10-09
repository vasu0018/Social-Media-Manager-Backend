import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createApp } from './app.js'
import { env, isDevelopment } from './env.js'
import { startWorker } from './queue.js'

const app = createApp()

await mkdir('data', { recursive: true })

const container = existsSync('/.dockerenv') || existsSync('/run/.containerenv')
if (env.CLIENT_ORIGIN.includes('localhost') && (container || !isDevelopment())) {
  console.error('CLIENT_ORIGIN still points at localhost. Sign-in from the public site will be blocked until it matches the frontend URL.')
}

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`Reel Studio API listening on 0.0.0.0:${env.PORT}`)
})
server.on('error', (error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

process.on('unhandledRejection', (error) => {
  console.error(error instanceof Error ? error.message : error)
})

void bootQueue()

async function bootQueue() {
  const waits = [0, 5_000, 15_000, 30_000]
  for (const wait of waits) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    try {
      await startWorker()
      console.log('Publishing queue is running.')
      return
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'The publishing queue failed to start.')
    }
  }
  console.error('Publishing queue is offline. Sign-in and drafts still work.')
}
