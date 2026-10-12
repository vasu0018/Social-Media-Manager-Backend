import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HttpError } from './domain.js'
import { videoPlayback } from './probe.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static') as string | null

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg is not available'))
      return
    }
    const child = spawn(ffmpegPath, args, { windowsHide: true })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString()).slice(-2000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(err || `ffmpeg exited ${code}`))
    })
  })
}

async function withTempVideo(input: Buffer, argsFor: (source: string, target: string) => string[]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'reel-'))
  const source = path.join(dir, 'in.mp4')
  const target = path.join(dir, 'out.mp4')
  try {
    await writeFile(source, input)
    await runFfmpeg(argsFor(source, target))
    return await readFile(target)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function prepareBrowserVideo(input: Buffer) {
  if (input.toString('ascii', 4, 8) !== 'ftyp') return input
  const playback = videoPlayback(input)
  if (playback.browserReady) return input
  const copyVideo = playback.videoCodec === 'avc1' || playback.videoCodec === 'avc3'
  const keepAudio = playback.audioCodec == null || playback.audioCodec === 'mp4a'
  try {
    if (copyVideo && keepAudio) {
      return await withTempVideo(input, (source, target) => [
        '-y', '-i', source, '-map', '0:v:0',
        ...(playback.audioCodec ? ['-map', '0:a:0'] : []),
        '-c', 'copy', '-movflags', '+faststart', target,
      ])
    }
    return await withTempVideo(input, (source, target) => [
      '-y', '-i', source, '-map', '0:v:0',
      ...(playback.audioCodec ? ['-map', '0:a:0'] : []),
      ...(copyVideo
        ? ['-c:v', 'copy']
        : ['-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23']),
      ...(playback.audioCodec ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'] : []),
      '-movflags', '+faststart',
      target,
    ])
  } catch {
    throw new HttpError(400, 'This video could not be prepared for playback. Export it as H.264 MP4 and try again.')
  }
}
