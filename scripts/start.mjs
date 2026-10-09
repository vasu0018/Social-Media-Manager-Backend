import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${args.at(-2) ?? 'command'} exited with code ${code}`))
    })
  })
}

const attempts = 12
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy'])
    break
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    if (attempt === attempts) process.exit(1)
    console.error(`Database is not ready (${attempt}/${attempts}). Retrying in 5s.`)
    await delay(5000)
  }
}

await run(['node_modules/tsx/dist/cli.mjs', 'src/index.ts'])
