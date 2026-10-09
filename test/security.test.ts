import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { prisma } from '../src/db.js'
import { env } from '../src/env.js'
import { probeBuffer } from '../src/probe.js'
import { encryptSecret } from '../src/crypto.js'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { redact, resetLimits } from '../src/security.js'
import { storage } from '../src/storage.js'

const origin = { Origin: env.CLIENT_ORIGIN, 'Content-Type': 'application/json' }

async function listen() {
  const server = createApp().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function sessionCookie(response: Response) {
  const header = response.headers.get('set-cookie') ?? ''
  return header.split(';')[0] ?? ''
}

describe('authentication and request guards', () => {
  let app: Awaited<ReturnType<typeof listen>>

  before(async () => {
    resetLimits()
    app = await listen()
  })

  after(async () => {
    await app.close()
  })

  it('rejects a wrong password and accepts the administrator', async () => {
    const denied = await fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: origin,
      body: JSON.stringify({ email: env.ADMIN_EMAIL, password: 'not-the-password' }),
    })
    assert.equal(denied.status, 401)

    const allowed = await fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: origin,
      body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
    })
    assert.equal(allowed.status, 200)
    const body = await allowed.json() as { user: { email: string } }
    assert.equal(body.user.email, env.ADMIN_EMAIL)
    assert.equal(JSON.stringify(body).includes('tokenCipher'), false)

    const session = await fetch(`${app.url}/api/content`, { headers: { cookie: sessionCookie(allowed) } })
    assert.equal(session.status, 200)
    const unsigned = await fetch(`${app.url}/api/content`)
    assert.equal(unsigned.status, 401)
  })

  it('blocks a cross-site mutation', async () => {
    const blocked = await fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: { ...origin, Origin: 'https://evil.example' },
      body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
    })
    assert.equal(blocked.status, 403)
  })

  it('rejects an OAuth callback without a saved state', async () => {
    const response = await fetch(`${app.url}/api/oauth/callback?state=missing-state`, { redirect: 'manual' })
    assert.equal(response.status, 302)
    assert.match(response.headers.get('location') ?? '', /error=signin/)
  })

  it('rejects a file whose bytes do not match the declared type', async () => {
    const login = await fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: origin,
      body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
    })
    const form = new FormData()
    form.set('file', new Blob([Buffer.from('not-an-image')], { type: 'image/jpeg' }), 'photo.jpg')
    const upload = await fetch(`${app.url}/api/media/upload`, {
      method: 'POST',
      headers: { cookie: sessionCookie(login), Origin: env.CLIENT_ORIGIN },
      body: form,
    })
    assert.equal(upload.status, 400)
    assert.throws(() => probeBuffer(Buffer.from('not-video'), 'video/mp4', 'clip.mp4'), /MP4 or MOV/)
  })

  it('does not return an access token from the account API', async () => {
    const login = await fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: origin,
      body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
    })
    const account = await prisma.socialAccount.create({
      data: {
        platform: 'facebook',
        externalId: 'security-test-page',
        pageId: 'security-test-page',
        name: 'Security Test Page',
        handle: 'Security Test Page',
        grantedScopes: '[]',
        tasks: '[]',
        tokenCipher: encryptSecret('EAASecurityTestToken'),
        tokenStatus: 'valid',
        eligible: false,
      },
    })
    try {
      const response = await fetch(`${app.url}/api/social-accounts`, { headers: { cookie: sessionCookie(login) } })
      const text = await response.text()
      assert.equal(response.status, 200)
      assert.equal(text.includes('tokenCipher'), false)
      assert.equal(text.includes('EAASecurityTestToken'), false)
    } finally {
      await prisma.socialAccount.delete({ where: { id: account.id } })
    }
  })
})

describe('local media storage', () => {
  it('writes every upload to Server/data/media', async () => {
    const key = `local-save-test-${Date.now()}`
    const body = Buffer.from('local-copy')
    await storage.save(key, body, 'text/plain')
    const file = path.resolve(process.cwd(), 'data', 'media', key)
    try {
      await access(file)
      assert.deepEqual(await storage.open(key).read(), body)
    } finally {
      await storage.open(key).remove()
    }
  })
})

describe('secret redaction', () => {
  it('removes tokens from log text', () => {
    const cleaned = redact('failed access_token=EAA1234567890abcdef&client_secret=super-secret')
    assert.equal(cleaned.includes('EAA1234567890abcdef'), false)
    assert.equal(cleaned.includes('super-secret'), false)
  })
})
