import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { zonedToUtc } from '../../Client/src/lib/time.ts'
import { createApp } from '../src/app.js'
import { encryptSecret } from '../src/crypto.js'
import { prisma } from '../src/db.js'
import { env } from '../src/env.js'
import { classifyMetaError } from '../src/meta/graph.js'
import { probeBuffer } from '../src/probe.js'
import { assertCanPublish, deliver, isPermanent, permalinkFor, quotaError, rollupStatus, storySupport } from '../src/publish.js'
import { recoverPublications, retryDecision } from '../src/queue.js'
import { resetLimits } from '../src/security.js'
import type { SocialAccount } from '@prisma/client'

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
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

function account(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: 'account',
    platform: 'instagram',
    externalId: 'ig',
    pageId: 'page',
    name: 'Studio',
    handle: '@studio',
    pictureUrl: null,
    accountType: 'BUSINESS',
    connected: true,
    followers: 0,
    grantedScopes: JSON.stringify(['instagram_content_publish']),
    tasks: '[]',
    tokenCipher: 'stored',
    tokenExpiresAt: null,
    dataAccessExpiresAt: null,
    tokenStatus: 'valid',
    eligible: true,
    eligibilityReason: null,
    lastSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe('publishing rules', () => {
  it('converts a zoned schedule to UTC', () => {
    const when = zonedToUtc('2026-10-10', '10:00', 'Asia/Kolkata')
    assert.equal(when.toISOString(), '2026-10-10T04:30:00.000Z')
  })

  it('rejects Creator stories and expired tokens', () => {
    const creator = storySupport(account({ accountType: 'MEDIA_CREATOR' }), 'instagram_story')
    assert.equal(creator.supported, false)
    assert.match(creator.message, /Not supported by current API integration/)
    const business = storySupport(account(), 'instagram_story')
    assert.equal(business.supported, true)
    assert.throws(() => assertCanPublish(account({ tokenStatus: 'expired' }), 'instagram_reel', null), /expired or was revoked/)
  })

  it('classifies Meta failures and stops permanent errors', () => {
    const expired = classifyMetaError(400, 'The session has expired')
    const limited = classifyMetaError(429, 'too many calls')
    const denied = classifyMetaError(400, 'permission denied')
    assert.equal(expired.status, 401)
    assert.equal(limited.status, 429)
    assert.equal(isPermanent(expired), true)
    assert.equal(isPermanent(limited), false)
    assert.equal(isPermanent(denied), true)
    assert.equal(retryDecision(limited, 1, 5), 'retry')
    assert.equal(retryDecision(denied, 1, 5), 'fail')
    assert.equal(retryDecision(limited, 5, 5), 'fail')
  })

  it('reports platform quotas and partial publication', () => {
    assert.match(quotaError(100, 'instagram_reel') ?? '', /100/)
    assert.equal(quotaError(99, 'instagram_reel'), null)
    assert.match(quotaError(30, 'facebook_reel') ?? '', /30/)
    assert.equal(rollupStatus(['published', 'failed']), 'partially_published')
    assert.equal(permalinkFor('instagram', '1789000'), null)
    assert.equal(permalinkFor('facebook', '10_20'), 'https://www.facebook.com/10/posts/20')
  })

  it('accepts a JPEG signature and rejects a renamed text file', () => {
    const jpeg = probeBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg', 'tiny.jpg')
    assert.equal(jpeg.kind, 'image')
    assert.throws(() => probeBuffer(Buffer.from('hello'), 'image/jpeg', 'tiny.jpg'), /JPEG/)
  })
})

describe('content workflow', () => {
  let app: Awaited<ReturnType<typeof listen>>
  let cookie = ''

  before(async () => {
    resetLimits()
    app = await listen()
    const login = await fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: origin,
      body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
    })
    cookie = sessionCookie(login)
  })

  after(async () => {
    await app.close()
  })

  it('creates and edits a draft, then refuses to edit it after publication', async () => {
    const created = await fetch(`${app.url}/api/content`, {
      method: 'POST',
      headers: { ...origin, cookie },
      body: JSON.stringify({
        title: 'Security draft',
        caption: 'First caption',
        action: 'draft',
        timezone: 'Asia/Kolkata',
      }),
    })
    assert.equal(created.status, 201)
    const { item } = await created.json() as { item: { id: string; status: string } }
    assert.equal(item.status, 'draft')

    const edited = await fetch(`${app.url}/api/content/${item.id}`, {
      method: 'PATCH',
      headers: { ...origin, cookie },
      body: JSON.stringify({ caption: 'Updated caption' }),
    })
    assert.equal(edited.status, 200)

    await prisma.content.update({ where: { id: item.id }, data: { status: 'published' } })
    const blocked = await fetch(`${app.url}/api/content/${item.id}`, {
      method: 'PATCH',
      headers: { ...origin, cookie },
      body: JSON.stringify({ caption: 'This must not publish again' }),
    })
    assert.equal(blocked.status, 409)
    await prisma.content.delete({ where: { id: item.id } })
  })
})

describe('worker recovery and duplicate protection', () => {
  it('does not publish again when a destination already has a post id, and recovers a locked job', async () => {
    const stored = await prisma.socialAccount.create({
      data: {
        platform: 'facebook',
        externalId: 'worker-test-page',
        pageId: 'worker-test-page',
        name: 'Worker Test',
        handle: 'Worker Test',
        grantedScopes: JSON.stringify(['pages_manage_posts']),
        tasks: '[]',
        tokenCipher: encryptSecret('EAAWorkerTestToken'),
        tokenStatus: 'expired',
        eligible: true,
        connected: true,
      },
    })
    const content = await prisma.content.create({
      data: { title: 'Worker test', format: 'facebook_image', status: 'processing', timezone: 'UTC' },
    })
    const destination = await prisma.contentDestination.create({
      data: {
        contentId: content.id,
        accountId: stored.id,
        platform: 'facebook',
        format: 'facebook_image',
        status: 'published',
        externalId: 'post-keep',
        idempotencyKey: `${content.id}:${stored.id}:facebook_image`,
      },
    })
    const processing = await prisma.contentDestination.create({
      data: {
        contentId: content.id,
        accountId: stored.id,
        platform: 'facebook',
        format: 'facebook_video',
        status: 'processing',
        lockedAt: new Date(),
        idempotencyKey: `${content.id}:processing`,
      },
    })
    try {
      await deliver(destination.id)
      const unchanged = await prisma.contentDestination.findUnique({ where: { id: destination.id }, include: { attempts: true } })
      assert.equal(unchanged?.externalId, 'post-keep')
      assert.equal(unchanged?.attempts.length, 0)
      const queued: string[] = []
      await recoverPublications(async (id) => { queued.push(id) })
      assert.equal(queued.includes(processing.id), true)
      assert.equal(queued.includes(destination.id), false)
      const recovered = await prisma.contentDestination.findUnique({ where: { id: processing.id } })
      assert.equal(recovered?.status, 'scheduled')
      assert.equal(recovered?.lockedAt, null)
    } finally {
      await prisma.content.delete({ where: { id: content.id } })
      await prisma.socialAccount.delete({ where: { id: stored.id } })
    }
  })
})
