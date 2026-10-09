import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from './env.js'

function encryptionKey() {
  const raw = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64')
  if (raw.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes of base64')
  }
  return raw
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

export function decryptSecret(payload: string) {
  const [ivPart, tagPart, dataPart] = payload.split('.')
  if (!ivPart || !tagPart || !dataPart) throw new Error('Stored credential is unreadable')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivPart, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ])
  return plain.toString('utf8')
}

export function signValue(value: string) {
  return createHmac('sha256', env.MEDIA_URL_SECRET).update(value).digest('base64url')
}

export function signaturesMatch(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function randomId() {
  return randomBytes(32).toString('hex')
}
