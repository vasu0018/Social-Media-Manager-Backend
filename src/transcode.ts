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

export async function prepareStoryImage(input: Buffer, mime: string) {
  if (mime === 'image/jpeg' && input[0] === 0xff && input[1] === 0xd8) return { body: input, mime: 'image/jpeg', name: 'story.jpg' }
  const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : mime === 'image/gif' ? '.gif' : mime === 'image/bmp' ? '.bmp' : '.img'
  const dir = await mkdtemp(path.join(tmpdir(), 'story-'))
  const source = path.join(dir, `in${ext}`)
  const target = path.join(dir, 'out.jpg')
  try {
    await writeFile(source, input)
    await runFfmpeg(['-y', '-i', source, '-frames:v', '1', '-q:v', '2', target])
    return { body: await readFile(target), mime: 'image/jpeg', name: 'story.jpg' }
  } catch {
    throw new HttpError(400, 'This photo could not be prepared. Use a JPEG, PNG, WebP, or GIF.')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

type StreamInfo = {
  video: { codec: string; pixFmt: string | null; fps: number | null; kbps: number | null; hdr: boolean } | null
  audio: { codec: string; hz: number | null; channels: string | null; kbps: number | null } | null
}

function inspectVideo(file: string) {
  return new Promise<StreamInfo>((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg is not available'))
      return
    }
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', () => {
      const total = Number(err.match(/bitrate: (\d+) kb\/s/)?.[1]) || null
      const videoLine = err.split('\n').find((line) => /Stream #.*Video:/.test(line) && !/attached pic/.test(line))
      const audioLine = err.split('\n').find((line) => /Stream #.*Audio:/.test(line))
      resolve({
        video: videoLine ? {
          codec: videoLine.match(/Video: (\w+)/)?.[1] ?? '',
          pixFmt: videoLine.match(/\b(yuvj?\d{3}p\w*|p010\w*|nv12|gbrp\w*|rgb\w+|bgr\w+)\b/)?.[1] ?? null,
          fps: Number(videoLine.match(/([\d.]+) fps/)?.[1]) || null,
          kbps: Number(videoLine.match(/(\d+) kb\/s/)?.[1]) || total,
          hdr: /smpte2084|arib-std-b67|bt2020/.test(videoLine),
        } : null,
        audio: audioLine ? {
          codec: audioLine.match(/Audio: (\w+)/)?.[1] ?? '',
          hz: Number(audioLine.match(/(\d+) Hz/)?.[1]) || null,
          channels: audioLine.match(/Hz, ([^,]+)/)?.[1]?.trim() ?? null,
          kbps: Number(audioLine.match(/(\d+) kb\/s/)?.[1]) || null,
        } : null,
      })
    })
  })
}

// Instagram rejects Reels outside these limits with opaque processing errors such as 2207077.
function videoFits(video: NonNullable<StreamInfo['video']>) {
  return video.codec === 'h264'
    && (video.pixFmt === 'yuv420p' || video.pixFmt === 'yuvj420p')
    && !video.hdr
    && (video.fps == null || video.fps <= 60)
    && (video.kbps == null || video.kbps <= 25000)
}

function audioFits(audio: NonNullable<StreamInfo['audio']>) {
  return audio.codec === 'aac'
    && (audio.hz == null || audio.hz <= 48000)
    && (audio.channels == null || audio.channels === 'mono' || audio.channels === 'stereo')
    && (audio.kbps == null || audio.kbps <= 128)
}

export type SongMix = {
  startSec: number
  songVolume: number
  originalVolume: number
  lengthSec: number
}

const storyFrame = '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[bg];'
  + '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg];'
  + '[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]'

export async function mixSong(media: { body: Buffer; kind: 'image' | 'video'; durationMs: number | null }, song: Buffer, mix: SongMix) {
  if (!ffmpegPath) throw new HttpError(503, 'Songs cannot be added because ffmpeg is not installed on the server.')
  const dir = await mkdtemp(path.join(tmpdir(), 'song-'))
  const source = path.join(dir, media.kind === 'video' ? 'in.mp4' : 'in.img')
  const track = path.join(dir, 'song.audio')
  const target = path.join(dir, 'out.mp4')
  try {
    await writeFile(source, media.body)
    await writeFile(track, song)
    const length = media.kind === 'video' && media.durationMs ? media.durationMs / 1000 : mix.lengthSec
    const fadeAt = Math.max(0, length - 1.5).toFixed(2)
    const songChain = `[1:a]volume=${(mix.songVolume / 100).toFixed(2)},afade=t=out:st=${fadeAt}:d=1.5`
    const songInput = ['-ss', String(mix.startSec), '-i', track]
    const audioOut = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']
    if (media.kind === 'video') {
      const info = await inspectVideo(source)
      if (!info.video) throw new HttpError(400, 'This video has no picture track.')
      const keepOriginal = info.audio != null && mix.originalVolume > 0
      const filter = keepOriginal
        ? `${songChain}[s];[0:a]volume=${(mix.originalVolume / 100).toFixed(2)}[o];[o][s]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`
        : `${songChain}[a]`
      await runFfmpeg([
        '-y', '-i', source, ...songInput,
        '-filter_complex', filter,
        '-map', '0:v:0', '-map', '[a]',
        '-c:v', 'copy', ...audioOut,
        '-t', length.toFixed(2),
        '-movflags', '+faststart',
        target,
      ])
    } else {
      await runFfmpeg([
        '-y', '-loop', '1', '-framerate', '30', '-i', source, ...songInput,
        '-filter_complex', `${storyFrame};${songChain}[a]`,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast', '-crf', '23', '-tune', 'stillimage', '-r', '30',
        ...audioOut,
        '-t', length.toFixed(2),
        '-movflags', '+faststart',
        target,
      ])
    }
    return await readFile(target)
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'The song could not be added. Use an MP3, M4A, AAC, or WAV file and try again.')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function prepareVideo(input: Buffer): Promise<{ body: Buffer; changed: boolean }> {
  if (input.toString('ascii', 4, 8) !== 'ftyp' || !ffmpegPath) return { body: input, changed: false }
  const dir = await mkdtemp(path.join(tmpdir(), 'reel-'))
  const source = path.join(dir, 'in.mp4')
  const target = path.join(dir, 'out.mp4')
  try {
    await writeFile(source, input)
    const info = await inspectVideo(source)
    if (!info.video) throw new Error('no video stream')
    const copyVideo = videoFits(info.video)
    const copyAudio = info.audio == null || audioFits(info.audio)
    if (copyVideo && copyAudio && videoPlayback(input).moovBeforeMdat) return { body: input, changed: false }
    await runFfmpeg([
      '-y', '-i', source, '-map', '0:v:0',
      ...(info.audio ? ['-map', '0:a:0'] : []),
      ...(copyVideo
        ? ['-c:v', 'copy']
        : [
          '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
          '-preset', 'veryfast', '-crf', '23', '-maxrate', '20M', '-bufsize', '40M',
          ...(info.video.fps && info.video.fps > 60 ? ['-r', '30'] : []),
          ...(info.video.hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
        ]),
      ...(info.audio ? (copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']) : []),
      '-movflags', '+faststart',
      target,
    ])
    return { body: await readFile(target), changed: true }
  } catch {
    throw new HttpError(400, 'This video could not be prepared for Instagram. Export it as an H.264 MP4 with AAC audio and try again.')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
