import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from './env.js'
import { signValue } from './crypto.js'

export type StoredObject = {
  read: () => Promise<Buffer>
  stream: () => NodeJS.ReadableStream
  publicUrl: (id: string, seconds: number) => Promise<string>
  remove: () => Promise<void>
}

export interface MediaStorage {
  save(key: string, body: Buffer, mime: string): Promise<void>
  open(key: string): StoredObject
}

const localRoot = path.resolve(process.cwd(), 'data', 'media')

class LocalStorage implements MediaStorage {
  async save(key: string, body: Buffer) {
    await mkdir(localRoot, { recursive: true })
    await writeFile(path.join(localRoot, key), body)
  }

  open(key: string): StoredObject {
    const file = path.join(localRoot, key)
    return {
      read: () => readFile(file),
      stream: () => createReadStream(file),
      publicUrl: async (id, seconds) => {
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
      publicUrl: (_id, seconds) => getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: remoteKey }),
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
      publicUrl: (id, seconds) => (remote ? remote.publicUrl(id, seconds) : local.publicUrl(id, seconds)),
      remove: async () => {
        await local.remove()
        if (remote) await remote.remove()
      },
    }
  }
}

const s3Enabled = Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY)

export const remoteCopyEnabled = s3Enabled

export const storage: MediaStorage = new MirroredStorage(new LocalStorage(), s3Enabled ? new S3Storage() : null)

export function publicBaseIsLocal() {
  try {
    const host = new URL(env.PUBLIC_BASE_URL).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return true
  }
}
