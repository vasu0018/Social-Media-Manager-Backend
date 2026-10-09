import { mkdir } from 'node:fs/promises'
import { createApp } from './app.js'
import { env } from './env.js'
import { startWorker } from './queue.js'

const app = createApp()

await mkdir('data', { recursive: true })
await startWorker()
app.listen(env.PORT, () => {
  console.log(`Reel Studio API listening on ${env.PORT}`)
})
