import { HttpError, type Probe } from './domain.js'

function readU32(buffer: Buffer, offset: number) {
  return buffer.readUInt32BE(offset)
}

function jpegSize(buffer: Buffer) {
  let offset = 2
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) break
    const marker = buffer[offset + 1] ?? 0
    const length = buffer.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xc2 && marker !== 0xc1) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    if (length < 2) break
    offset += 2 + length
  }
  return null
}

function pngSize(buffer: Buffer) {
  return { width: readU32(buffer, 16), height: readU32(buffer, 20) }
}

function walkAtoms(buffer: Buffer, start: number, end: number, visit: (type: string, body: Buffer) => void) {
  let offset = start
  while (offset + 8 <= end) {
    let size = readU32(buffer, offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      if (offset + 16 > end) break
      size = Number(buffer.readBigUInt64BE(offset + 8))
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) break
    const body = buffer.subarray(offset + header, offset + size)
    visit(type, body)
    if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl') {
      walkAtoms(buffer, offset + header, offset + size, visit)
    }
    offset += size
  }
}

function videoProbe(buffer: Buffer) {
  let durationMs: number | null = null
  let width: number | null = null
  let height: number | null = null
  walkAtoms(buffer, 0, buffer.length, (type, body) => {
    if (type === 'mvhd' && body.length > 20) {
      const version = body[0] ?? 0
      if (version === 1 && body.length >= 32) {
        const timescale = readU32(body, 20)
        const duration = Number(body.readBigUInt64BE(24))
        if (timescale > 0) durationMs = Math.round((duration / timescale) * 1000)
      } else if (body.length >= 20) {
        const timescale = readU32(body, 12)
        const duration = readU32(body, 16)
        if (timescale > 0) durationMs = Math.round((duration / timescale) * 1000)
      }
    }
    if (type === 'tkhd' && body.length > 80) {
      const version = body[0] ?? 0
      const boxWidth = version === 1 ? body.readUInt32BE(88) : body.readUInt32BE(76)
      const boxHeight = version === 1 ? body.readUInt32BE(92) : body.readUInt32BE(80)
      const nextWidth = Math.round(boxWidth / 65536)
      const nextHeight = Math.round(boxHeight / 65536)
      if (nextWidth > 0 && nextHeight > 0 && (width == null || height == null || nextWidth * nextHeight > width * height)) {
        width = nextWidth
        height = nextHeight
      }
    }
  })
  return { width, height, durationMs }
}

export function probeBuffer(buffer: Buffer, mime: string, name: string): Probe {
  const lower = name.toLowerCase()
  const isJpeg = mime === 'image/jpeg' || lower.endsWith('.jpg') || lower.endsWith('.jpeg')
  const isPng = mime === 'image/png' || lower.endsWith('.png')
  const isVideo = mime.startsWith('video/') || lower.endsWith('.mp4') || lower.endsWith('.mov')
  if (isJpeg) {
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new HttpError(400, 'This file is not a JPEG image.')
    const size = jpegSize(buffer)
    return { mime: 'image/jpeg', kind: 'image', width: size?.width ?? null, height: size?.height ?? null, durationMs: null, bytes: buffer.length }
  }
  if (isPng) {
    const png = buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    if (!png) throw new HttpError(400, 'This file is not a PNG image.')
    const size = pngSize(buffer)
    return { mime: 'image/png', kind: 'image', width: size.width, height: size.height, durationMs: null, bytes: buffer.length }
  }
  if (isVideo) {
    if (buffer.toString('ascii', 4, 8) !== 'ftyp') throw new HttpError(400, 'This file is not an MP4 or MOV video.')
    const details = videoProbe(buffer)
    const videoMime = lower.endsWith('.mov') || mime === 'video/quicktime' ? 'video/quicktime' : 'video/mp4'
    return { mime: videoMime, kind: 'video', width: details.width, height: details.height, durationMs: details.durationMs, bytes: buffer.length }
  }
  throw new HttpError(400, 'Upload a JPEG, PNG, MP4, or MOV file.')
}
