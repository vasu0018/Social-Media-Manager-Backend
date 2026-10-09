import { createHash, timingSafeEqual } from 'node:crypto'
import type { MediaAsset, Prisma, SocialAccount } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { decryptSecret, encryptSecret, randomId, signaturesMatch, signValue } from './crypto.js'
import { prisma } from './db.js'
import { coarseType, contentFormats, HttpError, platformFor, validateProbe, type ContentFormat } from './domain.js'
import { env, instagramConfigured, isDevelopment, metaConfigured } from './env.js'
import { socialProvider } from './meta/provider.js'
import { assertCanPublish, permalinkFor, rollupContent } from './publish.js'
import { probeBuffer } from './probe.js'
import { enqueuePublication, removePublicationJob } from './queue.js'
import { guardRequest, rateLimit, redact } from './security.js'
import { storage } from './storage.js'

const SESSION_COOKIE = 'reel_studio_session'
const WEEK = 7 * 24 * 60 * 60 * 1000

function sameSecret(left: string, right: string) {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

function presentAccount(account: SocialAccount) {
  return {
    id: account.id,
    platform: account.platform,
    name: account.name,
    handle: account.handle,
    connected: account.connected,
    followers: account.followers,
    pictureUrl: account.pictureUrl,
    accountType: account.accountType,
    tokenStatus: account.connected ? account.tokenStatus : 'disconnected',
    eligible: account.connected && account.eligible,
    eligibilityReason: account.eligibilityReason,
    grantedScopes: JSON.parse(account.grantedScopes) as string[],
    tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
    dataAccessExpiresAt: account.dataAccessExpiresAt?.toISOString() ?? null,
    lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
  }
}

function presentMedia(media: MediaAsset) {
  return {
    id: media.id,
    name: media.name,
    mime: media.mime,
    kind: media.kind,
    bytes: media.bytes,
    width: media.width,
    height: media.height,
    durationMs: media.durationMs,
    src: `/api/media/${media.id}/preview`,
    createdAt: media.createdAt.toISOString(),
  }
}

const contentInclude = {
  media: true,
  destinations: {
    include: { account: true, attempts: { orderBy: { startedAt: 'asc' as const } }, schedule: true },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.ContentInclude

type ContentRecord = Prisma.ContentGetPayload<{ include: typeof contentInclude }>

function presentDestination(publication: ContentRecord['destinations'][number]) {
  return {
    id: publication.id,
    scheduleId: publication.schedule?.id ?? null,
    platform: publication.platform,
    format: publication.format,
    accountId: publication.accountId,
    accountName: publication.account.name,
    status: publication.status,
    scheduledAt: publication.scheduledAt?.toISOString() ?? null,
    publishedAt: publication.publishedAt?.toISOString() ?? null,
    externalId: publication.externalId,
    permalink: publication.permalink,
    errorCode: publication.errorCode,
    error: publication.error,
    retryable: publication.retryable,
    attemptCount: publication.attemptCount,
  }
}

function presentContent(item: ContentRecord) {
  const destinations = item.destinations.map(presentDestination)
  const format = (destinations[0]?.format ?? item.format) as ContentFormat
  const platforms = [...new Set(destinations.map((publication) => publication.platform))]
  return {
    id: item.id,
    title: item.title,
    caption: item.caption,
    hashtags: item.hashtags,
    firstComment: item.firstComment,
    format,
    type: coarseType(format),
    platforms: platforms.length > 0 ? platforms : [platformFor(format)],
    status: item.status,
    timezone: item.timezone,
    scheduledAt: item.scheduledAt?.toISOString() ?? null,
    publishedAt: item.publishedAt?.toISOString() ?? null,
    accountIds: destinations.map((publication) => publication.accountId),
    mediaId: item.mediaId,
    thumbnailUrl: item.media ? `/api/media/${item.media.id}/preview` : null,
    error: item.error,
    externalId: destinations.map((publication) => publication.externalId).filter(Boolean).join(', ') || null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    destinations,
    publications: destinations,
    attempts: item.destinations.flatMap((publication) => publication.attempts.map((attempt) => ({
      id: attempt.id,
      publicationId: publication.id,
      platform: publication.platform,
      startedAt: attempt.startedAt.toISOString(),
      finishedAt: attempt.finishedAt?.toISOString() ?? null,
      outcome: attempt.outcome,
      errorCode: attempt.errorCode,
      message: attempt.message,
    }))),
  }
}

async function loadSession(req: Request) {
  const id = req.cookies?.[SESSION_COOKIE] as string | undefined
  if (!id) return null
  const session = await prisma.adminSession.findUnique({ where: { id }, include: { user: true } })
  if (!session || session.expiresAt < new Date()) {
    if (session) await prisma.adminSession.delete({ where: { id } }).catch(() => undefined)
    return null
  }
  return session
}

async function sessionId(req: Request) {
  const session = await loadSession(req)
  return session?.id ?? null
}

async function requireSession(req: Request, res: Response, next: NextFunction) {
  const session = await loadSession(req)
  if (!session) return res.status(401).json({ error: 'Sign in to continue.' })
  if (session.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' })
  res.locals.sessionId = session.id
  next()
}

function redirectClient(res: Response, query: Record<string, string>) {
  const target = new URL('/accounts', env.CLIENT_ORIGIN)
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value)
  res.redirect(target.toString())
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 },
})

const destinationSchema = z.object({
  platform: z.enum(['instagram', 'facebook']),
  accountId: z.string().min(1),
  format: z.enum(contentFormats),
})

const contentSchema = z.object({
  title: z.string().trim().min(1).max(120),
  caption: z.string().max(5000).default(''),
  hashtags: z.string().max(1000).default(''),
  firstComment: z.string().max(2200).nullable().optional(),
  format: z.enum(contentFormats).optional(),
  accountId: z.string().nullable().optional(),
  destinations: z.array(destinationSchema).max(6).optional(),
  mediaId: z.string().nullable().optional(),
  action: z.enum(['draft', 'schedule', 'publish']),
  scheduledAt: z.string().nullable().optional(),
  timezone: z.string().default('UTC'),
})

function assertTimezone(value: string) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value })
  } catch {
    throw new HttpError(400, 'Choose a valid timezone.')
  }
}

async function loadContent(id: string) {
  const item = await prisma.content.findUnique({ where: { id }, include: contentInclude })
  if (!item) throw new HttpError(404, 'Content not found.')
  return item
}

async function ensureUser() {
  return prisma.user.upsert({
    where: { email: env.ADMIN_EMAIL },
    update: { name: 'Studio Admin' },
    create: { email: env.ADMIN_EMAIL, name: 'Studio Admin', role: 'admin' },
  })
}

async function audit(action: string, entityType: string, entityId: string, detail?: string) {
  const user = await ensureUser()
  await prisma.auditLog.create({
    data: { userId: user.id, action, entityType, entityId, detail: detail ?? null },
  })
}

async function attachSchedules(contentId: string, scheduledAt: Date, timezone: string) {
  const destinations = await prisma.contentDestination.findMany({ where: { contentId } })
  for (const destination of destinations) {
    await prisma.scheduledPublication.upsert({
      where: { destinationId: destination.id },
      create: { destinationId: destination.id, scheduledAt, timezone, status: 'scheduled' },
      update: { scheduledAt, timezone, status: 'scheduled' },
    })
  }
}

function assertEditable(item: ContentRecord) {
  if (item.destinations.some((destination) => destination.externalId)) {
    throw new HttpError(409, 'This content already has a published destination. Editing it does not change the live post and does not create another publication. Use Repost as a new draft.')
  }
  if (!['draft', 'scheduled'].includes(item.status)) {
    throw new HttpError(409, 'Only a draft or a scheduled item can be edited. Repost creates a new draft and leaves this record unchanged.')
  }
}

function pageQuery(req: Request) {
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 100))
  return { page, pageSize, skip: (page - 1) * pageSize }
}

function contentWhere(req: Request, statuses?: string[]): Prisma.ContentWhereInput {
  const where: Prisma.ContentWhereInput = {}
  const status = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : undefined
  const platform = typeof req.query.platform === 'string' && req.query.platform !== 'all' ? req.query.platform : undefined
  const type = typeof req.query.type === 'string' && req.query.type !== 'all' ? req.query.type : undefined
  const accountId = typeof req.query.accountId === 'string' && req.query.accountId ? req.query.accountId : undefined
  const from = typeof req.query.from === 'string' ? new Date(req.query.from) : null
  const to = typeof req.query.to === 'string' ? new Date(req.query.to) : null
  if (statuses) where.status = { in: statuses }
  if (status) where.status = status
  if (type) where.format = { in: contentFormats.filter((format) => coarseType(format) === type) }
  if (platform || accountId) {
    where.destinations = { some: { ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}) } }
  }
  const range: Prisma.DateTimeFilter = {}
  if (from && !Number.isNaN(from.getTime())) range.gte = from
  if (to && !Number.isNaN(to.getTime())) range.lte = to
  if (range.gte || range.lte) {
    where.AND = [{ OR: [{ scheduledAt: range }, { publishedAt: range }, { createdAt: range }] }]
  }
  return where
}

async function listContent(req: Request, statuses?: string[]) {
  const { page, pageSize, skip } = pageQuery(req)
  const where = contentWhere(req, statuses)
  const [total, items] = await prisma.$transaction([
    prisma.content.count({ where }),
    prisma.content.findMany({ where, include: contentInclude, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
  ])
  return { items: items.map(presentContent), page, pageSize, total }
}

export const api = Router()

api.use(guardRequest)
api.use(rateLimit('api', 300, 60_000))

api.get('/health', (_req, res) => {
  res.json({ ok: true })
})

api.get('/meta/status', (_req, res) => {
  res.json({
    configured: metaConfigured || instagramConfigured,
    instagram: instagramConfigured,
    facebook: metaConfigured,
    apiVersion: socialProvider.apiVersion,
    required: ['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI'],
  })
})

api.get('/auth/config', (_req, res) => {
  const local = isDevelopment() && env.CLIENT_ORIGIN.includes('localhost')
  if (!local) return res.json({ demo: null })
  res.json({ demo: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } })
})

api.get('/auth/session', async (req, res) => {
  const id = await sessionId(req)
  res.json({ user: id ? { email: env.ADMIN_EMAIL, name: 'Studio Admin' } : null })
})

api.post('/auth/login', rateLimit('login', 8, 15 * 60_000), async (req, res) => {
  const parsed = z.object({ email: z.email(), password: z.string().min(1) }).safeParse(req.body)
  if (!parsed.success || !sameSecret(parsed.data.email, env.ADMIN_EMAIL) || !sameSecret(parsed.data.password, env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' })
  }
  const id = randomId()
  const expiresAt = new Date(Date.now() + WEEK)
  const user = await ensureUser()
  await prisma.adminSession.create({ data: { id, userId: user.id, expiresAt } })
  await audit('auth.login', 'User', user.id)
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production' || env.CLIENT_ORIGIN.startsWith('https://'),
    path: '/',
    expires: expiresAt,
  })
  res.json({ user: { email: env.ADMIN_EMAIL, name: 'Studio Admin' } })
})

api.post('/auth/logout', async (req, res) => {
  const id = await sessionId(req)
  if (id) await prisma.adminSession.delete({ where: { id } }).catch(() => undefined)
  res.clearCookie(SESSION_COOKIE, {
    path: '/',
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production' || env.CLIENT_ORIGIN.startsWith('https://'),
  })
  res.json({ ok: true })
})

api.get('/oauth/start', requireSession, async (req, res) => {
  const purpose = req.query.purpose === 'facebook' ? 'facebook' : req.query.purpose === 'instagram' ? 'instagram' : null
  if (!purpose) throw new HttpError(400, 'Choose Instagram or a Facebook Page.')
  if (purpose === 'instagram' && !instagramConfigured) {
    throw new HttpError(503, 'Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET from API setup with Instagram login.')
  }
  if (purpose === 'facebook' && !metaConfigured) {
    throw new HttpError(503, 'Add META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI on the server before connecting a Page.')
  }
  const id = randomId()
  await prisma.oauthState.create({
    data: {
      id,
      sessionId: res.locals.sessionId as string,
      purpose,
      includeComments: req.query.comments === '1',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  })
  res.redirect(socialProvider.authorizationUrl(id, purpose, req.query.comments === '1'))
})

api.post('/auth/meta/connect', requireSession, async (req, res) => {
  const parsed = z.object({
    purpose: z.enum(['instagram', 'facebook']),
    comments: z.boolean().optional(),
  }).safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Choose Instagram or a Facebook Page.')
  if (parsed.data.purpose === 'instagram' && !instagramConfigured) {
    throw new HttpError(503, 'Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET from API setup with Instagram login.')
  }
  if (parsed.data.purpose === 'facebook' && !metaConfigured) {
    throw new HttpError(503, 'Add META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI on the server before connecting a Page.')
  }
  const id = randomId()
  await prisma.oauthState.create({
    data: {
      id,
      sessionId: res.locals.sessionId as string,
      purpose: parsed.data.purpose,
      includeComments: parsed.data.comments === true,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  })
  res.json({ url: socialProvider.authorizationUrl(id, parsed.data.purpose, parsed.data.comments === true) })
})

async function storeConnectedAccounts(code: string, purpose: 'instagram' | 'facebook') {
  const found = await socialProvider.exchangeCode(code, purpose)
  if (found.length === 0) {
    return { error: purpose === 'instagram' ? 'no_instagram_account' : 'no_page' } as const
  }
  for (const account of found) {
    const data = {
      pageId: account.pageId,
      name: account.name,
      handle: account.handle,
      pictureUrl: account.pictureUrl,
      accountType: account.accountType,
      connected: true,
      followers: account.followers,
      grantedScopes: JSON.stringify(account.scopes),
      tasks: JSON.stringify(account.tasks),
      tokenCipher: encryptSecret(account.token),
      tokenExpiresAt: account.tokenExpiresAt,
      dataAccessExpiresAt: account.dataAccessExpiresAt,
      tokenStatus: account.tokenStatus,
      eligible: account.eligible,
      eligibilityReason: account.eligibilityReason,
      lastSyncedAt: new Date(),
    }
    const stored = await prisma.socialAccount.upsert({
      where: { platform_externalId: { platform: account.platform, externalId: account.externalId } },
      create: { platform: account.platform, externalId: account.externalId, ...data },
      update: data,
    })
    await audit('account.connect', 'SocialAccount', stored.id, account.platform)
  }
  return { connected: purpose } as const
}

api.get(['/oauth/callback', '/auth/meta/callback'], async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const saved = state ? await prisma.oauthState.findUnique({ where: { id: state } }) : null
  if (!saved || saved.expiresAt < new Date()) {
    if (saved) await prisma.oauthState.delete({ where: { id: saved.id } }).catch(() => undefined)
    return redirectClient(res, { error: 'signin' })
  }
  if (saved.purpose !== 'instagram' && saved.purpose !== 'facebook') {
    await prisma.oauthState.delete({ where: { id: saved.id } }).catch(() => undefined)
    return redirectClient(res, { error: 'denied' })
  }
  if (typeof req.query.error === 'string') {
    await prisma.oauthState.delete({ where: { id: saved.id } }).catch(() => undefined)
    return redirectClient(res, { error: 'denied' })
  }
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  if (!code) {
    await prisma.oauthState.delete({ where: { id: saved.id } }).catch(() => undefined)
    return redirectClient(res, { error: 'missing_code' })
  }
  const current = await sessionId(req)
  if (!current || !sameSecret(saved.sessionId, current)) {
    return redirectClient(res, { resume: saved.id, code })
  }
  await prisma.oauthState.delete({ where: { id: saved.id } }).catch(() => undefined)
  const purpose = saved.purpose === 'facebook' ? 'facebook' : 'instagram'
  try {
    const result = await storeConnectedAccounts(code, purpose)
    redirectClient(res, result.error ? { error: result.error } : { connected: result.connected })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'connection_failed'
    redirectClient(res, { error: 'connection_failed', detail: redact(message).slice(0, 180) })
  }
})

api.post('/oauth/finish', requireSession, async (req, res) => {
  const parsed = z.object({ state: z.string().min(1), code: z.string().min(1) }).safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'The connection could not be completed.')
  const saved = await prisma.oauthState.findUnique({ where: { id: parsed.data.state } })
  if (!saved || saved.expiresAt < new Date() || !sameSecret(saved.sessionId, res.locals.sessionId as string)) {
    if (saved) await prisma.oauthState.delete({ where: { id: saved.id } }).catch(() => undefined)
    throw new HttpError(401, 'Sign in again, then retry the connection.')
  }
  if (saved.purpose !== 'instagram' && saved.purpose !== 'facebook') throw new HttpError(400, 'The connection could not be completed.')
  const claimed = await prisma.oauthState.deleteMany({ where: { id: saved.id } })
  if (claimed.count !== 1) throw new HttpError(409, 'This connection attempt was already used. Connect again.')
  const purpose = saved.purpose === 'facebook' ? 'facebook' : 'instagram'
  try {
    const result = await storeConnectedAccounts(parsed.data.code, purpose)
    if (result.error) throw new HttpError(400, result.error === 'no_instagram_account' ? 'Instagram did not return a professional account.' : 'No Facebook Page was available for this login.')
    res.json({ connected: result.connected })
  } catch (error) {
    if (error instanceof HttpError) throw error
    const message = error instanceof Error ? error.message : 'The connection could not be completed.'
    throw new HttpError(502, redact(message).slice(0, 180))
  }
})

api.get(['/accounts', '/social-accounts'], requireSession, async (_req, res) => {
  const accounts = await prisma.socialAccount.findMany({ orderBy: { createdAt: 'asc' } })
  res.json({ accounts: accounts.map(presentAccount) })
})

api.delete('/social-accounts/:id', requireSession, async (req, res) => {
  const account = await prisma.socialAccount.findUnique({ where: { id: String(req.params.id) } })
  if (!account) throw new HttpError(404, 'Account not found.')
  const destinations = await prisma.contentDestination.count({ where: { accountId: account.id } })
  if (destinations > 0) {
    const updated = await prisma.socialAccount.update({
      where: { id: account.id },
      data: {
        connected: false,
        tokenCipher: null,
        tokenStatus: 'disconnected',
        eligible: false,
        eligibilityReason: 'Disconnected. Connect the account again to publish.',
      },
    })
    await audit('account.disconnect', 'SocialAccount', account.id, 'Token removed. Publishing history for this account was kept.')
    return res.json({ account: presentAccount(updated), removed: false })
  }
  await prisma.socialAccount.delete({ where: { id: account.id } })
  await audit('account.delete', 'SocialAccount', account.id)
  res.json({ ok: true, removed: true })
})

api.post('/accounts/:id/disconnect', requireSession, async (req, res) => {
  const account = await prisma.socialAccount.findUnique({ where: { id: String(req.params.id) } })
  if (!account) throw new HttpError(404, 'Account not found.')
  const updated = await prisma.socialAccount.update({
    where: { id: account.id },
    data: {
      connected: false,
      tokenCipher: null,
      tokenStatus: 'disconnected',
      eligible: false,
      eligibilityReason: 'Disconnected. Connect the account again to publish.',
    },
  })
  res.json({ account: presentAccount(updated) })
})

api.post('/accounts/:id/refresh', requireSession, async (req, res) => {
  const account = await prisma.socialAccount.findUnique({ where: { id: String(req.params.id) } })
  if (!account?.tokenCipher || !account.connected) throw new HttpError(400, 'Reconnect this account to refresh it.')
  try {
    const instagramLogin = account.tasks.includes('INSTAGRAM_LOGIN')
    const inspection = await socialProvider.inspect(decryptSecret(account.tokenCipher), instagramLogin)
    const usable = inspection.tokenStatus === 'valid' || inspection.tokenStatus === 'expiring'
    const updated = await prisma.socialAccount.update({
      where: { id: account.id },
      data: {
        tokenStatus: inspection.tokenStatus,
        grantedScopes: inspection.scopes.length > 0 ? JSON.stringify(inspection.scopes) : account.grantedScopes,
        tokenExpiresAt: inspection.tokenExpiresAt,
        dataAccessExpiresAt: inspection.dataAccessExpiresAt,
        eligible: usable && account.eligible,
        eligibilityReason: usable ? account.eligibilityReason : 'Reconnect this account. Access expired or was revoked.',
        lastSyncedAt: new Date(),
      },
    })
    res.json({ account: presentAccount(updated) })
  } catch (error) {
    const updated = await prisma.socialAccount.update({
      where: { id: account.id },
      data: {
        tokenStatus: 'revoked',
        eligible: false,
        eligibilityReason: 'Meta rejected this connection. Reconnect the account.',
      },
    })
    res.json({ account: presentAccount(updated), warning: error instanceof Error ? error.message : 'Refresh failed.' })
  }
})

api.get('/media', requireSession, async (_req, res) => {
  const media = await prisma.mediaAsset.findMany({ orderBy: { createdAt: 'desc' } })
  res.json({ media: media.map(presentMedia) })
})

api.post(['/media', '/media/upload'], requireSession, rateLimit('upload', 40, 60 * 60_000), upload.single('file'), async (req, res) => {
  const file = req.file
  if (!file) throw new HttpError(400, 'Choose a file to upload.')
  const probe = probeBuffer(file.buffer, file.mimetype, file.originalname)
  const format = typeof req.body?.format === 'string' && contentFormats.includes(req.body.format as ContentFormat)
    ? req.body.format as ContentFormat
    : null
  const errors = format ? validateProbe(format, probe) : []
  const created = await prisma.mediaAsset.create({
    data: {
      name: file.originalname.slice(0, 180) || 'upload',
      mime: probe.mime,
      kind: probe.kind,
      bytes: probe.bytes,
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs,
      storageKey: 'pending',
    },
  })
  const key = created.id
  await storage.save(key, file.buffer, probe.mime)
  const media = await prisma.mediaAsset.update({ where: { id: created.id }, data: { storageKey: key } })
  res.status(201).json({ media: presentMedia(media), errors })
})

api.get('/media/:id/preview', requireSession, async (req, res) => {
  const media = await prisma.mediaAsset.findUnique({ where: { id: String(req.params.id) } })
  if (!media) throw new HttpError(404, 'Media not found.')
  res.setHeader('Content-Type', media.mime)
  res.setHeader('Cache-Control', 'private, max-age=3600')
  const opened = storage.open(media.storageKey)
  try {
    opened.stream().pipe(res)
  } catch {
    res.send(await opened.read())
  }
})

api.get('/media/public/:id', async (req, res) => {
  const exp = Number(req.query.exp)
  const sig = typeof req.query.sig === 'string' ? req.query.sig : ''
  const id = String(req.params.id)
  if (!exp || exp < Math.floor(Date.now() / 1000) || !signaturesMatch(sig, signValue(`${id}.${exp}`))) {
    throw new HttpError(403, 'This media link has expired.')
  }
  const media = await prisma.mediaAsset.findUnique({ where: { id } })
  if (!media) throw new HttpError(404, 'Media not found.')
  res.setHeader('Content-Type', media.mime)
  res.setHeader('Cache-Control', 'public, max-age=300')
  const opened = storage.open(media.storageKey)
  try {
    opened.stream().pipe(res)
  } catch {
    res.send(await opened.read())
  }
})

api.delete('/media/:id', requireSession, async (req, res) => {
  const media = await prisma.mediaAsset.findUnique({ where: { id: String(req.params.id) } })
  if (!media) throw new HttpError(404, 'Media not found.')
  const used = await prisma.content.count({
    where: { mediaId: media.id, status: { in: ['scheduled', 'processing'] } },
  })
  if (used > 0) throw new HttpError(400, 'This file is attached to scheduled content.')
  await storage.open(media.storageKey).remove()
  await prisma.mediaAsset.delete({ where: { id: media.id } })
  res.json({ ok: true })
})

api.get('/content', requireSession, async (req, res) => {
  res.json(await listContent(req))
})

api.get('/content/:id', requireSession, async (req, res) => {
  res.json({ item: presentContent(await loadContent(String(req.params.id))) })
})

api.post('/content', requireSession, async (req, res) => {
  const parsed = contentSchema.safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Check the title, format, and schedule time.')
  const input = parsed.data
  assertTimezone(input.timezone)
  const destinations = input.destinations?.length
    ? input.destinations
    : input.format && input.accountId
      ? [{ platform: platformFor(input.format), accountId: input.accountId, format: input.format }]
      : []
  if (input.action !== 'draft' && destinations.length === 0) throw new HttpError(400, 'Choose at least one destination account.')
  const needsCopy = destinations.some((destination) => !destination.format.endsWith('story'))
  if (input.action !== 'draft' && needsCopy && !input.caption.trim()) {
    throw new HttpError(400, 'Write the caption before scheduling or publishing.')
  }
  if (input.action !== 'draft' && needsCopy && !/#\S+/.test(input.hashtags)) {
    throw new HttpError(400, 'Add at least one hashtag before scheduling or publishing.')
  }
  if (input.action !== 'draft' && !input.mediaId) throw new HttpError(400, 'Upload media before publishing.')
  const seen = new Set<string>()
  for (const destination of destinations) {
    if (platformFor(destination.format) !== destination.platform) {
      throw new HttpError(400, 'Each destination must use a format for its own platform.')
    }
    const key = `${destination.accountId}:${destination.format}`
    if (seen.has(key)) throw new HttpError(400, 'Each account can only be selected once for a format.')
    seen.add(key)
  }
  const media = input.mediaId ? await prisma.mediaAsset.findUnique({ where: { id: input.mediaId } }) : null
  if (input.mediaId && !media) throw new HttpError(400, 'That media file is no longer available.')
  const accounts = await prisma.socialAccount.findMany({ where: { id: { in: destinations.map((destination) => destination.accountId) } } })
  let scheduledAt: Date | null = null
  if (input.action === 'schedule') {
    scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null
    if (!scheduledAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 60_000) {
      throw new HttpError(400, 'Choose a schedule time at least a minute from now.')
    }
  }
  for (const destination of destinations) {
    const account = accounts.find((entry) => entry.id === destination.accountId)
    if (!account) throw new HttpError(400, 'That account is no longer connected.')
    if (media && input.action !== 'draft') {
      const errors = validateProbe(destination.format, {
        mime: media.mime,
        kind: media.kind as 'image' | 'video',
        width: media.width,
        height: media.height,
        durationMs: media.durationMs,
        bytes: media.bytes,
      })
      if (errors.length > 0) throw new HttpError(400, errors[0] ?? 'This file does not meet the platform requirements.')
    }
    if (input.action !== 'draft') assertCanPublish(account, destination.format, input.firstComment ?? null)
  }
  const created = await prisma.content.create({
    data: {
      title: input.title,
      caption: input.caption,
      hashtags: input.hashtags,
      firstComment: input.firstComment?.trim() || null,
      format: destinations[0]?.format ?? input.format ?? 'instagram_reel',
      status: input.action === 'publish' ? 'processing' : input.action === 'schedule' ? 'scheduled' : 'draft',
      timezone: input.timezone,
      scheduledAt,
      mediaId: media?.id,
    },
  })
  if (destinations.length > 0) {
    await prisma.contentDestination.createMany({
      data: destinations.map((destination) => ({
        contentId: created.id,
        accountId: destination.accountId,
        platform: destination.platform,
        format: destination.format,
        status: input.action === 'publish' ? 'processing' : input.action === 'schedule' ? 'scheduled' : 'draft',
        scheduledAt,
        idempotencyKey: `${created.id}:${destination.accountId}:${destination.format}`,
      })),
    })
  }
  if (input.action === 'schedule' && scheduledAt) await attachSchedules(created.id, scheduledAt, input.timezone)
  const item = await loadContent(created.id)
  await audit(input.action === 'publish' ? 'content.publish' : input.action === 'schedule' ? 'content.schedule' : 'content.draft', 'Content', item.id)
  if (input.action !== 'draft') {
    for (const publication of item.destinations) {
      await enqueuePublication(publication.id, input.action === 'schedule' ? scheduledAt : new Date())
    }
  }
  res.status(input.action === 'publish' ? 202 : 201).json({ item: presentContent(item) })
})

api.patch('/content/:id', requireSession, async (req, res) => {
  const item = await loadContent(String(req.params.id))
  assertEditable(item)
  const parsed = z.object({
    title: z.string().trim().min(2).max(120).optional(),
    caption: z.string().max(5000).optional(),
    hashtags: z.string().max(1000).optional(),
    firstComment: z.string().max(2200).nullable().optional(),
  }).safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Check the content fields.')
  await prisma.content.update({ where: { id: item.id }, data: parsed.data })
  await audit('content.edit', 'Content', item.id, 'Updated draft or scheduled fields without creating a new publication.')
  res.json({ item: presentContent(await loadContent(item.id)) })
})

api.delete('/content/:id', requireSession, async (req, res) => {
  const item = await loadContent(String(req.params.id))
  if (item.status === 'processing') throw new HttpError(409, 'This item is publishing. Wait for it to finish before deleting the workspace record.')
  const livePostKept = item.destinations.some((destination) => Boolean(destination.externalId))
  for (const publication of item.destinations) await removePublicationJob(publication.id)
  await prisma.content.delete({ where: { id: item.id } })
  await audit('content.delete', 'Content', item.id, livePostKept ? 'Removed the workspace record. The live post was left online.' : 'Removed a workspace record that had not been published.')
  res.json({ ok: true, livePostKept })
})

api.post('/content/:id/cancel', requireSession, async (req, res) => {
  const item = await loadContent(String(req.params.id))
  const scheduled = item.destinations.filter((publication) => publication.status === 'scheduled')
  if (scheduled.length === 0) throw new HttpError(400, 'Only scheduled content can be cancelled.')
  for (const publication of scheduled) {
    await removePublicationJob(publication.id)
    await prisma.contentDestination.update({ where: { id: publication.id }, data: { status: 'cancelled', scheduledAt: null } })
    if (publication.schedule) {
      await prisma.scheduledPublication.update({ where: { id: publication.schedule.id }, data: { status: 'cancelled' } })
    }
  }
  await rollupContent(item.id)
  res.json({ item: presentContent(await loadContent(item.id)) })
})

api.post('/content/:id/reschedule', requireSession, async (req, res) => {
  const item = await loadContent(String(req.params.id))
  if (!item.destinations.every((publication) => publication.status === 'scheduled')) {
    throw new HttpError(400, 'Reschedule is available before publication begins.')
  }
  const parsed = z.object({ scheduledAt: z.string(), timezone: z.string() }).safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Choose a date, time, and timezone.')
  assertTimezone(parsed.data.timezone)
  const scheduledAt = new Date(parsed.data.scheduledAt)
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 60_000) {
    throw new HttpError(400, 'Choose a schedule time at least a minute from now.')
  }
  await prisma.content.update({ where: { id: item.id }, data: { timezone: parsed.data.timezone, scheduledAt } })
  await attachSchedules(item.id, scheduledAt, parsed.data.timezone)
  for (const publication of item.destinations) {
    await prisma.contentDestination.update({ where: { id: publication.id }, data: { scheduledAt } })
    await enqueuePublication(publication.id, scheduledAt)
  }
  await audit('content.reschedule', 'Content', item.id, scheduledAt.toISOString())
  res.json({ item: presentContent(await loadContent(item.id)) })
})

api.post('/content/:id/retry', requireSession, async (req, res) => {
  const item = await loadContent(String(req.params.id))
  const failed = item.destinations.filter((publication) => publication.status === 'failed' && !publication.externalId)
  if (failed.length === 0) throw new HttpError(400, 'There is no failed destination to retry.')
  for (const publication of failed) {
    assertCanPublish(publication.account, publication.format as ContentFormat, item.firstComment)
    await prisma.contentDestination.update({
      where: { id: publication.id },
      data: { status: 'processing', error: null, lockedAt: null },
    })
    await enqueuePublication(publication.id, new Date())
  }
  await rollupContent(item.id)
  res.status(202).json({ item: presentContent(await loadContent(item.id)) })
})

api.post('/content/:id/duplicate', requireSession, async (req, res) => {
  const existing = await loadContent(String(req.params.id))
  const item = await prisma.content.create({
    data: {
      title: `${existing.title} copy`.slice(0, 120),
      caption: existing.caption,
      hashtags: existing.hashtags,
      firstComment: existing.firstComment,
      format: existing.format,
      status: 'draft',
      timezone: existing.timezone,
      mediaId: existing.mediaId,
    },
  })
  if (existing.destinations.length > 0) {
    await prisma.contentDestination.createMany({
      data: existing.destinations.map((publication) => ({
        contentId: item.id,
        accountId: publication.accountId,
        platform: publication.platform,
        format: publication.format,
        status: 'draft',
        idempotencyKey: `${item.id}:${publication.accountId}:${publication.format}`,
      })),
    })
  }
  res.status(201).json({ item: presentContent(await loadContent(item.id)) })
})

api.get('/notices', requireSession, async (_req, res) => {
  const notices = await prisma.notification.findMany({
    where: { readAt: null },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })
  res.json({
    notices: notices.map((notice) => ({
      id: notice.id,
      kind: notice.kind,
      title: notice.title,
      body: notice.body,
      contentId: notice.contentId,
      createdAt: notice.createdAt.toISOString(),
    })),
  })
})

api.post('/notices/:id/read', requireSession, async (req, res) => {
  await prisma.notification.update({ where: { id: String(req.params.id) }, data: { readAt: new Date() } }).catch(() => undefined)
  res.json({ ok: true })
})

api.post('/content/:id/publish', requireSession, async (req, res) => {
  const item = await loadContent(String(req.params.id))
  if (item.destinations.some((destination) => destination.externalId)) {
    throw new HttpError(409, 'A destination already has a platform post ID. Publishing again would duplicate it. Retry only a failed destination, or repost as a new draft.')
  }
  const pending = item.destinations.filter((destination) => destination.status === 'draft' || destination.status === 'failed' || destination.status === 'scheduled')
  if (pending.length === 0) throw new HttpError(400, 'Choose at least one destination account.')
  if (!item.media) throw new HttpError(400, 'Upload media before publishing.')
  for (const destination of pending) {
    const errors = validateProbe(destination.format as ContentFormat, {
      mime: item.media.mime,
      kind: item.media.kind as 'image' | 'video',
      width: item.media.width,
      height: item.media.height,
      durationMs: item.media.durationMs,
      bytes: item.media.bytes,
    })
    if (errors.length > 0) throw new HttpError(400, errors[0] ?? 'This file does not meet the platform requirements.')
    assertCanPublish(destination.account, destination.format as ContentFormat, item.firstComment)
  }
  for (const destination of pending) {
    await removePublicationJob(destination.id)
    await prisma.contentDestination.update({
      where: { id: destination.id },
      data: { status: 'processing', scheduledAt: null, error: null, errorCode: null, lockedAt: null },
    })
    if (destination.schedule) await prisma.scheduledPublication.update({ where: { id: destination.schedule.id }, data: { status: 'dispatched' } })
    await enqueuePublication(destination.id, new Date())
  }
  await rollupContent(item.id)
  await audit('content.publish', 'Content', item.id)
  res.status(202).json({ item: presentContent(await loadContent(item.id)) })
})

api.post('/content/:id/schedule', requireSession, async (req, res) => {
  const item = await loadContent(String(req.params.id))
  assertEditable(item)
  if (!item.destinations.every((destination) => destination.status === 'draft' || destination.status === 'scheduled')) {
    throw new HttpError(409, 'Schedule is available before publication begins.')
  }
  const parsed = z.object({ scheduledAt: z.string(), timezone: z.string() }).safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Choose a date, time, and timezone.')
  assertTimezone(parsed.data.timezone)
  const scheduledAt = new Date(parsed.data.scheduledAt)
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 60_000) {
    throw new HttpError(400, 'Choose a schedule time at least a minute from now.')
  }
  if (!item.mediaId) throw new HttpError(400, 'Upload media before scheduling.')
  for (const destination of item.destinations) assertCanPublish(destination.account, destination.format as ContentFormat, item.firstComment)
  await prisma.content.update({ where: { id: item.id }, data: { timezone: parsed.data.timezone, scheduledAt, status: 'scheduled' } })
  for (const destination of item.destinations) {
    await prisma.contentDestination.update({ where: { id: destination.id }, data: { status: 'scheduled', scheduledAt, error: null, errorCode: null } })
    await enqueuePublication(destination.id, scheduledAt)
  }
  await attachSchedules(item.id, scheduledAt, parsed.data.timezone)
  await audit('content.schedule', 'Content', item.id, scheduledAt.toISOString())
  res.json({ item: presentContent(await loadContent(item.id)) })
})

api.patch('/scheduled-publications/:id', requireSession, async (req, res) => {
  const schedule = await prisma.scheduledPublication.findUnique({
    where: { id: String(req.params.id) },
    include: { destination: { include: { content: true } } },
  })
  if (!schedule) throw new HttpError(404, 'Scheduled publication not found.')
  if (schedule.destination.status !== 'scheduled' || schedule.destination.externalId) {
    throw new HttpError(409, 'Reschedule is available before publication begins.')
  }
  const parsed = z.object({ scheduledAt: z.string(), timezone: z.string() }).safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Choose a date, time, and timezone.')
  assertTimezone(parsed.data.timezone)
  const scheduledAt = new Date(parsed.data.scheduledAt)
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 60_000) {
    throw new HttpError(400, 'Choose a schedule time at least a minute from now.')
  }
  await prisma.scheduledPublication.update({
    where: { id: schedule.id },
    data: { scheduledAt, timezone: parsed.data.timezone, status: 'scheduled' },
  })
  await prisma.contentDestination.update({ where: { id: schedule.destinationId }, data: { scheduledAt } })
  await enqueuePublication(schedule.destinationId, scheduledAt)
  await rollupContent(schedule.destination.contentId)
  await audit('schedule.update', 'ScheduledPublication', schedule.id, scheduledAt.toISOString())
  res.json({ item: presentContent(await loadContent(schedule.destination.contentId)) })
})

api.delete('/scheduled-publications/:id', requireSession, async (req, res) => {
  const schedule = await prisma.scheduledPublication.findUnique({ where: { id: String(req.params.id) } })
  if (!schedule) throw new HttpError(404, 'Scheduled publication not found.')
  const destination = await prisma.contentDestination.findUnique({ where: { id: schedule.destinationId } })
  if (!destination || destination.status !== 'scheduled') throw new HttpError(409, 'Only a scheduled destination can be cancelled.')
  await removePublicationJob(destination.id)
  await prisma.contentDestination.update({ where: { id: destination.id }, data: { status: 'cancelled', scheduledAt: null } })
  await prisma.scheduledPublication.update({ where: { id: schedule.id }, data: { status: 'cancelled' } })
  await rollupContent(destination.contentId)
  await audit('schedule.cancel', 'ScheduledPublication', schedule.id)
  res.json({ item: presentContent(await loadContent(destination.contentId)) })
})

api.get('/calendar', requireSession, async (req, res) => {
  res.json(await listContent(req))
})

api.get('/publishing-history', requireSession, async (req, res) => {
  res.json(await listContent(req, ['published', 'failed', 'partially_published', 'cancelled', 'processing']))
})

api.get('/publishing-history/:id', requireSession, async (req, res) => {
  res.json({ item: presentContent(await loadContent(String(req.params.id))) })
})

api.post('/publishing-history/:id/retry', requireSession, async (req, res) => {
  const item = await loadContent(String(req.params.id))
  const failed = item.destinations.filter((destination) => destination.status === 'failed' && !destination.externalId)
  if (failed.length === 0) throw new HttpError(400, 'There is no failed destination to retry.')
  for (const destination of failed) {
    assertCanPublish(destination.account, destination.format as ContentFormat, item.firstComment)
    await prisma.contentDestination.update({
      where: { id: destination.id },
      data: { status: 'processing', error: null, errorCode: null, lockedAt: null },
    })
    await enqueuePublication(destination.id, new Date())
  }
  await rollupContent(item.id)
  await audit('content.retry', 'Content', item.id, `Retried ${failed.length} destination(s) without a post ID.`)
  res.status(202).json({ item: presentContent(await loadContent(item.id)) })
})

api.post('/content/:id/repost', requireSession, async (req, res) => {
  const existing = await loadContent(String(req.params.id))
  const item = await prisma.content.create({
    data: {
      title: `${existing.title} repost`.slice(0, 120),
      caption: existing.caption,
      hashtags: existing.hashtags,
      firstComment: existing.firstComment,
      format: existing.format,
      status: 'draft',
      timezone: existing.timezone,
      mediaId: existing.mediaId,
    },
  })
  if (existing.destinations.length > 0) {
    await prisma.contentDestination.createMany({
      data: existing.destinations.map((destination) => ({
        contentId: item.id,
        accountId: destination.accountId,
        platform: destination.platform,
        format: destination.format,
        status: 'draft',
        idempotencyKey: `${item.id}:${destination.accountId}:${destination.format}`,
      })),
    })
  }
  await audit('content.repost', 'Content', item.id, `New draft copied from ${existing.id}. The original publication was left unchanged.`)
  res.status(201).json({ item: presentContent(await loadContent(item.id)) })
})
