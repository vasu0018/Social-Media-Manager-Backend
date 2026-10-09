import { mkdir } from 'node:fs/promises'
import { createApp } from './app.js'
import { env, isDevelopment } from './env.js'
import { startWorker } from './queue.js'

const app = createApp()

await mkdir('data', { recursive: true })

if (!isDevelopment() && env.CLIENT_ORIGIN.includes('localhost')) {
  console.error('CLIENT_ORIGIN still points at localhost. Sign-in from the public site will be blocked until it matches the frontend URL.')
}

app.listen(env.PORT, () => {
  console.log(`Reel Studio API listening on ${env.PORT}`)
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
