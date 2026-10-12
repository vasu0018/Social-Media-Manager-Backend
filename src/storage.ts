import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from './env.js'
import { signValue } from './crypto.js'

export type StoredObject = {
  read: () => Promise<Buffer>
  stream: () => NodeJS.ReadableStream
  size: () => Promise<number>
  openStream: (range?: { start: number; end: number }) => Promise<NodeJS.ReadableStream>
  publicUrl: (id: string, seconds: number, mime?: string) => Promise<string>
  remove: () => Promise<void>
}

export interface MediaStorage {
  save(key: string, body: Buffer, mime: string): Promise<void>
  open(key: string): StoredObject
}

const localRoot = path.resolve(process.cwd(), 'data', 'media')

class LocalStorage implements MediaStorage {
  async save(key: string, body: Buffer, _mime: string) {
    await mkdir(localRoot, { recursive: true })
    await writeFile(path.join(localRoot, key), body)
  }

  open(key: string): StoredObject {
    const file = path.join(localRoot, key)
    return {
      read: () => readFile(file),
      stream: () => createReadStream(file),
      size: async () => (await stat(file)).size,
      openStream: async (range) => {
        await access(file)
        return createReadStream(file, range)
      },
      publicUrl: async (id, seconds, _mime?: string) => {
        const exp = Math.floor(Date.now() / 1000) + seconds
        const sig = signValue(`${id}.${exp}`)
        return `${env.PUBLIC_BASE_URL}/api/media/public/${id}?exp=${exp}&sig=${sig}`
      },
      remove: () => rm(file, { force: true }),
    }
  }
}

function objectKey(key: string) {
  const prefix = env.S3_KEY_PREFIX.replace(/^\/+|\/+$/g, '')
  if (!prefix) return key
  if (prefix.includes('..') || prefix.includes('\\')) throw new Error('S3_KEY_PREFIX must be a single folder name.')
  return `${prefix}/${key}`
}

class S3Storage implements MediaStorage {
  private client = new S3Client({
    region: env.S3_REGION || 'auto',
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: Boolean(env.S3_ENDPOINT),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  })

  async save(key: string, body: Buffer, mime: string) {
    await this.client.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: objectKey(key),
      Body: body,
      ContentType: mime,
      ContentDisposition: 'inline',
      CacheControl: 'public, max-age=86400',
    }))
  }

  open(key: string): StoredObject {
    const remoteKey = objectKey(key)
    return {
      read: async () => {
        const result = await this.client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: remoteKey }))
        const bytes = await result.Body?.transformToByteArray()
        if (!bytes) throw new Error('Stored media is missing')
        return Buffer.from(bytes)
      },
      stream: () => {
        throw new Error('S3 preview is served through a signed URL')
      },
      size: async () => {
        const head = await this.client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: remoteKey }))
        return head.ContentLength ?? 0
      },
      openStream: async (range) => {
        const result = await this.client.send(new GetObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: remoteKey,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }))
        if (!result.Body) throw new Error('Stored media is missing')
        return result.Body as NodeJS.ReadableStream
      },
      publicUrl: (_id, seconds, mime?: string) => getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: remoteKey,
          ResponseContentDisposition: 'inline',
          ...(mime ? { ResponseContentType: mime } : {}),
        }),
        { expiresIn: seconds },
      ),
      remove: async () => {
        await this.client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: remoteKey }))
      },
    }
  }
}

class MirroredStorage implements MediaStorage {
  constructor(
    private local: LocalStorage,
    private remote: S3Storage | null,
  ) {}

  async save(key: string, body: Buffer, mime: string) {
    await this.local.save(key, body, mime)
    if (this.remote) await this.remote.save(key, body, mime)
  }

  open(key: string): StoredObject {
    const local = this.local.open(key)
    const remote = this.remote?.open(key)
    return {
      read: async () => {
        try {
          return await local.read()
        } catch (error) {
          if (!remote) throw error
          return remote.read()
        }
      },
      stream: () => local.stream(),
      size: async () => {
        try {
          return await local.size()
        } catch (error) {
          if (!remote) throw error
          return remote.size()
        }
      },
      openStream: async (range) => {
        try {
          return await local.openStream(range)
        } catch (error) {
          if (!remote) throw error
          return remote.openStream(range)
        }
      },
      publicUrl: (id, seconds, mime?: string) => (remote ? remote.publicUrl(id, seconds, mime) : local.publicUrl(id, seconds, mime)),
      remove: async () => {
        await local.remove()
        if (remote) await remote.remove()
      },
    }
  }
}

const s3Enabled = Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY)
const localDisk = new LocalStorage()
const remoteDisk = s3Enabled ? new S3Storage() : null

export const remoteCopyEnabled = s3Enabled

export const storage: MediaStorage = new MirroredStorage(localDisk, remoteDisk)

export async function sharedMediaUrl(key: string, mime: string, seconds = 6 * 24 * 60 * 60) {
  if (!remoteDisk) return null
  try {
    await remoteDisk.open(key).size()
  } catch {
    try {
      const bytes = await localDisk.open(key).read()
      await remoteDisk.save(key, bytes, mime)
    } catch {
      return null
    }
  }
  return remoteDisk.open(key).publicUrl(key, seconds, mime)
}

export function publicBaseIsLocal() {
  try {
    const host = new URL(env.PUBLIC_BASE_URL).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return true
  }
}
