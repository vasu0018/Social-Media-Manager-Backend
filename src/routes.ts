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
import { instagramErrorText, placeReference, searchPlaces } from './meta/graph.js'
import { publishOptionsSchema, readPublishOptions } from './publish-options.js'
import { socialProvider } from './meta/provider.js'
import { suggestCaption } from './ai/caption.js'
import { assertCanPublish, pageTokenCipher, permalinkFor, rollupContent, taskList } from './publish.js'
import { probeBuffer } from './probe.js'
import { mixSong, prepareStoryImage, prepareVideo } from './transcode.js'
import { enqueuePublication, removePublicationJob } from './queue.js'
import { guardRequest, rateLimit, redact } from './security.js'
import { sharedMediaUrl, storage } from './storage.js'

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
    canBrowseSongs: Boolean(pageTokenCipher(account)),
    tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
    dataAccessExpiresAt: account.dataAccessExpiresAt?.toISOString() ?? null,
    lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
  }
}

function browserPath(path: string) {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '')
  if (env.NODE_ENV === 'production' && base.startsWith('https://')) return `${base}${path}`
  return path
}

function signedMediaPath(id: string) {
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60
  const sig = signValue(`${id}.${exp}`)
  return browserPath(`/api/media/public/${id}?exp=${exp}&sig=${sig}`)
}

async function presentMedia(media: MediaAsset) {
  const captureSrc = signedMediaPath(media.id)
  const shared = await sharedMediaUrl(media.storageKey, media.mime)
  return {
    id: media.id,
    name: media.name,
    mime: media.mime,
    kind: media.kind,
    bytes: media.bytes,
    width: media.width,
    height: media.height,
    durationMs: media.durationMs,
    src: shared ?? captureSrc,
    captureSrc,
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
  const metaCode = publication.error?.match(/failed with error code (\d+)/i)?.[1] ?? null
  const explained = metaCode ? instagramErrorText(metaCode) : null
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
    errorCode: explained ? metaCode : publication.errorCode,
    error: explained ?? publication.error,
    retryable: publication.retryable,
    attemptCount: publication.attemptCount,
  }
}

async function presentContent(item: ContentRecord) {
  const destinations = item.destinations.map(presentDestination)
  const format = (destinations[0]?.format ?? item.format) as ContentFormat
  const platforms = [...new Set(destinations.map((publication) => publication.platform))]
  return {
    id: item.id,
    title: item.title,
    caption: item.caption,
    hashtags: item.hashtags,
    firstComment: item.firstComment,
    audio: item.audioId ? {
      id: item.audioId,
      title: item.audioTitle ?? 'Selected song',
      artist: item.audioArtist,
      audioVolume: item.audioVolume,
      videoVolume: item.videoVolume,
    } : null,
    coverMediaId: item.coverMediaId,
    thumbOffsetMs: item.thumbOffsetMs,
    publishOptions: readPublishOptions(item.publishOptions),
    format,
    type: coarseType(format),
    platforms: platforms.length > 0 ? platforms : [platformFor(format)],
    status: item.status,
    timezone: item.timezone,
    scheduledAt: item.scheduledAt?.toISOString() ?? null,
    publishedAt: item.publishedAt?.toISOString() ?? null,
    accountIds: destinations.map((publication) => publication.accountId),
    mediaId: item.mediaId,
    thumbnailUrl: item.media ? (await sharedMediaUrl(item.media.storageKey, item.media.mime)) ?? signedMediaPath(item.media.id) : null,
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

function safeReturn(value: unknown) {
  if (value === '/accounts' || value === '/settings' || value === '/create' || value === '/stories/compose') return value
  if (typeof value === 'string' && /^\/create\?kind=(reel|story|image|video)$/.test(value)) return value
  return ''
}

function redirectClient(res: Response, query: Record<string, string>, returnTo = '') {
  const target = new URL(safeReturn(returnTo) || '/accounts', env.CLIENT_ORIGIN)
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
  audio: z.object({
    id: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    artist: z.string().trim().max(200).nullable().optional(),
    audioVolume: z.number().int().min(1).max(100).default(100),
    videoVolume: z.number().int().min(1).max(100).default(60),
  }).nullable().optional(),
  coverMediaId: z.string().trim().min(1).nullable().optional(),
  thumbOffsetMs: z.number().int().min(0).max(15 * 60 * 1000).nullable().optional(),
  publishOptions: publishOptionsSchema.optional(),
  format: z.enum(contentFormats).optional(),
  accountId: z.string().nullable().optional(),
  destinations: z.array(destinationSchema).max(20).optional(),
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
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 100))
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
  return { items: await Promise.all(items.map((item) => presentContent(item))), page, pageSize, total }
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
    redirectUri: env.META_REDIRECT_URI,
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
      returnTo: safeReturn(req.query.returnTo),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  })
  res.redirect(socialProvider.authorizationUrl(id, purpose, req.query.comments === '1'))
})

api.post('/auth/meta/connect', requireSession, async (req, res) => {
  const parsed = z.object({
    purpose: z.enum(['instagram', 'facebook']),
    comments: z.boolean().optional(),
    returnTo: z.string().optional(),
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
      returnTo: safeReturn(parsed.data.returnTo),
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
    const existing = await prisma.socialAccount.findUnique({
      where: { platform_externalId: { platform: account.platform, externalId: account.externalId } },
    })
    const incomingToken = encryptSecret(account.token)
    let tokenCipher = incomingToken
    let catalogTokenCipher = existing?.catalogTokenCipher ?? null
    let tasks = account.tasks
    if (account.platform === 'instagram' && purpose === 'facebook') {
      catalogTokenCipher = incomingToken
      if (existing?.tokenCipher && taskList(existing.tasks).includes('INSTAGRAM_LOGIN')) {
        tokenCipher = existing.tokenCipher
        tasks = ['INSTAGRAM_LOGIN', 'FACEBOOK_LOGIN']
      }
    }
    if (account.platform === 'instagram' && purpose === 'instagram' && existing) {
      const previous = taskList(existing.tasks)
      if (!catalogTokenCipher && previous.includes('FACEBOOK_LOGIN') && existing.tokenCipher) {
        catalogTokenCipher = existing.tokenCipher
      }
      if (catalogTokenCipher) tasks = ['INSTAGRAM_LOGIN', 'FACEBOOK_LOGIN']
    }
    const data = {
      pageId: account.pageId,
      name: account.name,
      handle: account.handle,
      pictureUrl: account.pictureUrl,
      accountType: account.accountType,
      connected: true,
      followers: account.followers,
      grantedScopes: JSON.stringify(account.scopes),
      tasks: JSON.stringify(tasks),
      tokenCipher,
      catalogTokenCipher,
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
    const reason = typeof req.query.error_reason === 'string' ? req.query.error_reason : ''
    const description = typeof req.query.error_description === 'string' ? req.query.error_description : ''
    const text = `${reason} ${description}`.toLowerCase()
    const detail = text.includes('permission')
      ? 'Facebook did not grant Page access. Log in with the Facebook user who manages the Page and accept every permission.'
      : 'The Facebook login was cancelled before the Page was connected.'
    await prisma.oauthState.delete({ where: { id: saved.id } }).catch(() => undefined)
    return redirectClient(res, { error: 'denied', detail }, saved.returnTo)
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
    redirectClient(res, result.error ? { error: result.error } : { connected: result.connected }, result.error ? '' : saved.returnTo)
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

api.post('/accounts/:id/delete', requireSession, async (req, res) => {
  const account = await prisma.socialAccount.findUnique({ where: { id: String(req.params.id) } })
  if (!account) throw new HttpError(404, 'Account not found.')
  if (account.connected) throw new HttpError(400, 'Disconnect this account before deleting it.')
  const destinations = await prisma.contentDestination.findMany({ where: { accountId: account.id }, select: { id: true, contentId: true, status: true } })
  if (destinations.some((destination) => destination.status === 'processing')) {
    throw new HttpError(409, 'A post for this account is publishing right now. Wait for it to finish, then delete the account.')
  }
  for (const destination of destinations) await removePublicationJob(destination.id)
  await prisma.contentDestination.deleteMany({ where: { accountId: account.id } })
  await prisma.socialAccount.delete({ where: { id: account.id } })
  const contentIds = [...new Set(destinations.map((destination) => destination.contentId))]
  for (const contentId of contentIds) await rollupContent(contentId)
  await audit('account.delete', 'SocialAccount', account.id, `${account.name} deleted with ${destinations.length} linked publication${destinations.length === 1 ? '' : 's'}.`)
  res.json({ ok: true, removedPublications: destinations.length })
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
        ...(inspection.accountType ? { accountType: inspection.accountType } : {}),
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
  res.json({ media: await Promise.all(media.map((item) => presentMedia(item))) })
})

api.post(['/media', '/media/upload'], requireSession, rateLimit('upload', 40, 60 * 60_000), upload.single('file'), async (req, res) => {
  const file = req.file
  if (!file) throw new HttpError(400, 'Choose a file to upload.')
  const format = typeof req.body?.format === 'string' && contentFormats.includes(req.body.format as ContentFormat)
    ? req.body.format as ContentFormat
    : null
  const incomingVideo = file.mimetype.startsWith('video/') || /\.(mp4|mov)$/i.test(file.originalname)
  const incomingImage = file.mimetype.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.originalname)
  let body = file.buffer
  let mime = file.mimetype
  let name = file.originalname
  if (incomingVideo) {
    body = (await prepareVideo(file.buffer)).body
    mime = 'video/mp4'
    name = file.originalname.replace(/\.mov$/i, '.mp4')
  } else if (incomingImage && (format?.endsWith('story') || (file.mimetype !== 'image/jpeg' && file.mimetype !== 'image/png'))) {
    const prepared = await prepareStoryImage(file.buffer, file.mimetype || 'image/jpeg')
    body = prepared.body
    mime = prepared.mime
    name = file.originalname.replace(/\.[^.]+$/, '.jpg')
  }
  const probe = probeBuffer(body, mime, name)
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
  await storage.save(key, body, probe.mime)
  const media = await prisma.mediaAsset.update({ where: { id: created.id }, data: { storageKey: key } })
  res.status(201).json({ media: await presentMedia(media), errors })
})

const songMixSchema = z.object({
  format: z.enum(contentFormats as unknown as [ContentFormat, ...ContentFormat[]]).optional(),
  startSec: z.coerce.number().min(0).max(3600).default(0),
  songVolume: z.coerce.number().int().min(1).max(100).default(100),
  originalVolume: z.coerce.number().int().min(0).max(100).default(30),
  lengthSec: z.coerce.number().int().min(3).max(60).default(15),
})

api.post('/media/:id/song', requireSession, rateLimit('upload', 40, 60 * 60_000), upload.single('file'), async (req, res) => {
  const source = await prisma.mediaAsset.findUnique({ where: { id: String(req.params.id) } })
  if (!source) throw new HttpError(404, 'That file is no longer in the library. Upload it again.')
  const file = req.file
  if (!file) throw new HttpError(400, 'Choose a song file.')
  if (file.size > 50 * 1024 * 1024) throw new HttpError(400, 'The song file must be 50 MB or smaller.')
  if (!file.mimetype.startsWith('audio/') && !/\.(mp3|m4a|aac|wav|ogg)$/i.test(file.originalname)) {
    throw new HttpError(400, 'Choose an MP3, M4A, AAC, or WAV song file.')
  }
  const parsed = songMixSchema.safeParse(req.body ?? {})
  if (!parsed.success) throw new HttpError(400, 'Check the song start time and volume.')
  const { format, ...mix } = parsed.data
  if (source.kind === 'image' && format && !format.endsWith('story')) {
    throw new HttpError(400, 'A song can be added to a photo only for a story. Upload a video for a reel or feed video.')
  }
  const body = await mixSong({
    body: await storage.open(source.storageKey).read(),
    kind: source.kind === 'video' ? 'video' : 'image',
    durationMs: source.durationMs,
  }, file.buffer, mix)
  const name = `${source.name.replace(/\.[^.]+$/, '')} + ${file.originalname.replace(/\.[^.]+$/, '')}.mp4`.slice(0, 180)
  const probe = probeBuffer(body, 'video/mp4', name)
  const errors = format ? validateProbe(format, probe) : []
  const created = await prisma.mediaAsset.create({
    data: {
      name,
      mime: probe.mime,
      kind: probe.kind,
      bytes: probe.bytes,
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs,
      storageKey: 'pending',
    },
  })
  await storage.save(created.id, body, probe.mime)
  const media = await prisma.mediaAsset.update({ where: { id: created.id }, data: { storageKey: created.id } })
  await audit('media.song', 'MediaAsset', media.id, `Mixed ${file.originalname} into ${source.name}`)
  res.status(201).json({ media: await presentMedia(media), errors })
})

async function sendStoredMedia(req: Request, res: Response, media: MediaAsset, cache: string) {
  const opened = storage.open(media.storageKey)
  const size = await opened.size()
  res.setHeader('Content-Type', media.mime)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', cache)
  const requested = typeof req.headers.range === 'string' ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null
  let range: { start: number; end: number } | undefined
  if (requested && size > 0) {
    const start = requested[1] ? Number(requested[1]) : 0
    const end = requested[2] ? Number(requested[2]) : size - 1
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= size || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`)
      res.end()
      return
    }
    range = { start, end }
    res.status(206)
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    res.setHeader('Content-Length', String(end - start + 1))
  } else {
    res.setHeader('Content-Length', String(size))
  }
  const stream = await opened.openStream(range)
  stream.on('error', () => {
    if (!res.headersSent) res.status(404).end()
    else res.destroy()
  })
  stream.pipe(res)
}

api.get('/media/:id/preview', requireSession, async (req, res) => {
  const media = await prisma.mediaAsset.findUnique({ where: { id: String(req.params.id) } })
  if (!media) throw new HttpError(404, 'Media not found.')
  await sendStoredMedia(req, res, media, 'private, max-age=3600')
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
  await sendStoredMedia(req, res, media, 'public, max-age=300')
})

api.post('/media/bulk-delete', requireSession, async (req, res) => {
  const blocked = await prisma.content.findMany({
    where: {
      status: { in: ['scheduled', 'processing'] },
      OR: [{ mediaId: { not: null } }, { coverMediaId: { not: null } }],
    },
    select: { mediaId: true, coverMediaId: true },
  })
  const keep = new Set(blocked.flatMap((item) => [item.mediaId, item.coverMediaId].filter((id): id is string => Boolean(id))))
  const media = await prisma.mediaAsset.findMany({ where: keep.size > 0 ? { id: { notIn: [...keep] } } : undefined })
  const ids = media.map((item) => item.id)
  if (ids.length > 0) {
    await prisma.content.updateMany({ where: { mediaId: { in: ids } }, data: { mediaId: null } })
    await prisma.content.updateMany({ where: { coverMediaId: { in: ids } }, data: { coverMediaId: null } })
    for (const item of media) {
      await storage.open(item.storageKey).remove().catch(() => undefined)
    }
    await prisma.mediaAsset.deleteMany({ where: { id: { in: ids } } })
  }
  res.json({ ok: true, deleted: ids.length, skipped: keep.size })
})

api.delete('/media/:id', requireSession, async (req, res) => {
  const media = await prisma.mediaAsset.findUnique({ where: { id: String(req.params.id) } })
  if (!media) throw new HttpError(404, 'Media not found.')
  const used = await prisma.content.findFirst({
    where: { status: { in: ['scheduled', 'processing'] }, OR: [{ mediaId: media.id }, { coverMediaId: media.id }] },
    select: { title: true },
  })
  if (used) throw new HttpError(409, `This file is used by "${used.title}", which is scheduled or publishing. Turn off its auto-publish first, then delete the file.`)
  await prisma.content.updateMany({ where: { mediaId: media.id }, data: { mediaId: null } })
  await prisma.content.updateMany({ where: { coverMediaId: media.id }, data: { coverMediaId: null } })
  await storage.open(media.storageKey).remove().catch(() => undefined)
  await prisma.mediaAsset.delete({ where: { id: media.id } })
  await audit('media.delete', 'MediaAsset', media.id, media.name)
  res.json({ ok: true })
})

async function catalogAccess(account: SocialAccount) {
  const saved = pageTokenCipher(account)
  if (saved) return { token: saved, needsLink: false, reason: null }
  const pages = await prisma.socialAccount.findMany({
    where: { platform: 'facebook', connected: true, tokenCipher: { not: null } },
  })
  const version = env.META_GRAPH_VERSION || 'v26.0'
  for (const page of pages) {
    if (!page.tokenCipher) continue
    const response = await fetch(`https://graph.facebook.com/${version}/${page.externalId}?fields=instagram_business_account{id}`, {
      headers: { Authorization: `Bearer ${decryptSecret(page.tokenCipher)}` },
    })
    if (!response.ok) continue
    const body = await response.json() as { instagram_business_account?: { id?: string } }
    if (body.instagram_business_account?.id !== account.externalId) continue
    const tasks = [...new Set([...taskList(account.tasks), 'FACEBOOK_LOGIN'])]
    await prisma.socialAccount.update({
      where: { id: account.id },
      data: { catalogTokenCipher: page.tokenCipher, tasks: JSON.stringify(tasks) },
    })
    return { token: page.tokenCipher, needsLink: false, reason: null }
  }
  if (pages.length === 0) {
    return {
      token: null,
      needsLink: false,
      reason: 'Instagram only shares its song catalog through the Facebook Page that owns this account.',
    }
  }
  const names = pages.map((page) => page.name).join(', ')
  const linked = pages.length === 1
    ? `${names} is connected, but that Page is not linked to ${account.handle}.`
    : `${names} are connected, but none of those Pages is linked to ${account.handle}.`
  return {
    token: null,
    needsLink: true,
    reason: `${linked} In Instagram, link this professional account to that Facebook Page, then connect the Page again.`,
  }
}

function allowedAudioHost(hostname: string) {
  return hostname === 'fbcdn.net' || hostname.endsWith('.fbcdn.net')
    || hostname === 'cdninstagram.com' || hostname.endsWith('.cdninstagram.com')
    || hostname === 'fbsbx.com' || hostname.endsWith('.fbsbx.com')
    || hostname === 'instagram.com' || hostname.endsWith('.instagram.com')
}

function audioFilePath(remote: string | null) {
  if (!remote) return null
  let url: URL
  try {
    url = new URL(remote)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !allowedAudioHost(url.hostname)) return null
  const exp = Math.floor(Date.now() / 1000) + 30 * 60
  const sig = signValue(`audio.${exp}.${remote}`)
  return browserPath(`/api/audio/file?exp=${exp}&sig=${sig}&src=${encodeURIComponent(remote)}`)
}

api.get('/audio/file', async (req, res) => {
  const exp = Number(req.query.exp)
  const sig = typeof req.query.sig === 'string' ? req.query.sig : ''
  const src = typeof req.query.src === 'string' ? req.query.src : ''
  if (!exp || exp < Math.floor(Date.now() / 1000) || !signaturesMatch(sig, signValue(`audio.${exp}.${src}`))) {
    throw new HttpError(403, 'This song preview has expired. Search again.')
  }
  let url: URL
  try {
    url = new URL(src)
  } catch {
    throw new HttpError(400, 'This song has no preview.')
  }
  if (url.protocol !== 'https:' || !allowedAudioHost(url.hostname)) throw new HttpError(400, 'This song has no preview.')
  const headers: Record<string, string> = {}
  if (typeof req.headers.range === 'string') headers.Range = req.headers.range
  const upstream = await fetch(url, { headers })
  if (!upstream.ok && upstream.status !== 206) throw new HttpError(502, 'Instagram did not return this preview.')
  res.status(upstream.status === 206 ? 206 : 200)
  const type = upstream.headers.get('content-type')
  if (type) res.setHeader('Content-Type', type)
  const range = upstream.headers.get('content-range')
  if (range) res.setHeader('Content-Range', range)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.send(Buffer.from(await upstream.arrayBuffer()))
})

api.get('/audio', requireSession, async (req, res) => {
  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : ''
  const type = 'music'
  const query = typeof req.query.q === 'string' ? req.query.q : ''
  const account = accountId ? await prisma.socialAccount.findUnique({ where: { id: accountId } }) : null
  if (!account || account.platform !== 'instagram' || !account.connected || !account.tokenCipher) {
    throw new HttpError(400, 'Choose a connected Instagram account before looking up songs.')
  }
  const catalog = await catalogAccess(account)
  if (!catalog.token) {
    return res.json({ tracks: [], available: false, needsPage: true, needsLink: catalog.needsLink, reason: catalog.reason })
  }
  const tracks = (await socialProvider.searchAudio(decryptSecret(catalog.token), account.externalId, type, query)).map((track) => ({
    ...track,
    previewUrl: audioFilePath(track.previewUrl),
    artworkUrl: audioFilePath(track.artworkUrl),
  }))
  res.json({ tracks, available: true, needsPage: false, needsLink: false, reason: null })
})

api.get('/places', requireSession, rateLimit('places', 120, 60 * 60_000), async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : ''
  const accounts = await prisma.socialAccount.findMany({ where: { connected: true } })
  const sources: Array<{ token: string; pageId: string | null }> = []
  for (const account of accounts) {
    if (account.platform === 'facebook' && account.tokenCipher) {
      sources.push({ token: decryptSecret(account.tokenCipher), pageId: account.pageId })
    } else if (account.platform === 'instagram') {
      const cipher = pageTokenCipher(account)
      if (cipher) sources.push({ token: decryptSecret(cipher), pageId: account.pageId && account.pageId !== account.externalId ? account.pageId : null })
    }
  }
  const link = Boolean(query && placeReference(query))
  const saved = link ? [] : await prisma.savedPlace.findMany({
    where: query ? { name: { contains: query, mode: 'insensitive' } } : {},
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    take: 25,
  })
  const places = saved.map((place) => ({ id: place.id, name: place.name, address: place.address, saved: true, isDefault: place.isDefault }))
  if (sources.length === 0) {
    return res.json({ places, searchError: link || places.length === 0 ? 'Connect a Facebook Page first. Meta looks up places through a Facebook connection.' : null })
  }
  const found = await searchPlaces(sources, query)
  const savedIds = new Set(places.map((place) => place.id))
  for (const place of found.places) {
    if (!savedIds.has(place.id)) places.push({ ...place, saved: false, isDefault: false })
  }
  let searchError = found.searchError
  if (!link) {
    searchError = places.length > 0 || !query
      ? null
      : `No saved place matches “${query}”. Paste the Facebook link of the place once and it will be saved here for next time.`
  }
  res.json({ places: places.slice(0, 25), searchError })
})

const savedPlaceSchema = z.object({
  id: z.string().regex(/^\d{5,30}$/, 'The place number is not valid.'),
  name: z.string().trim().min(1, 'Give the place a name.').max(120),
  address: z.string().trim().max(300).nullable().optional(),
})

api.post('/places', requireSession, async (req, res) => {
  const parsed = savedPlaceSchema.safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'The place is not valid.')
  const { id, name, address } = parsed.data
  const place = await prisma.savedPlace.upsert({
    where: { id },
    create: { id, name, address: address ?? null },
    update: { name, ...(address ? { address } : {}) },
  })
  await audit('place.save', 'SavedPlace', place.id, place.name)
  res.json({ id: place.id, name: place.name, address: place.address, saved: true, isDefault: place.isDefault })
})

api.get('/places/default', requireSession, async (_req, res) => {
  const place = await prisma.savedPlace.findFirst({ where: { isDefault: true } })
  res.json({ place: place ? { id: place.id, name: place.name, address: place.address } : null })
})

api.post('/places/:id/default', requireSession, async (req, res) => {
  const id = String(req.params.id)
  const place = await prisma.savedPlace.findUnique({ where: { id } })
  if (!place) throw new HttpError(404, 'This place is no longer saved.')
  const isDefault = !place.isDefault
  await prisma.$transaction([
    prisma.savedPlace.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
    ...(isDefault ? [prisma.savedPlace.update({ where: { id }, data: { isDefault: true } })] : []),
  ])
  await audit(isDefault ? 'place.default' : 'place.undefault', 'SavedPlace', id, place.name)
  res.json({ ok: true, isDefault })
})

api.post('/places/:id/delete', requireSession, async (req, res) => {
  const id = String(req.params.id)
  await prisma.savedPlace.deleteMany({ where: { id } })
  await audit('place.delete', 'SavedPlace', id)
  res.json({ ok: true })
})

api.post('/ai/caption', requireSession, rateLimit('ai-caption', 30, 60 * 60_000), async (req, res) => {
  const parsed = z.object({
    kind: z.enum(['reel', 'story', 'image', 'video']),
    images: z.array(z.string().min(32).max(1_500_000)).min(1).max(3),
  }).safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Upload a photo or reel before asking for a caption.')
  res.json(await suggestCaption(parsed.data.kind, parsed.data.images))
})

api.get('/content', requireSession, async (req, res) => {
  res.json(await listContent(req))
})

const bulkContentTypes = z.enum(['reel', 'story', 'post', 'image'])

function formatsForTypes(types: Array<'reel' | 'story' | 'post' | 'image'>) {
  const map = {
    reel: ['instagram_reel', 'facebook_reel'],
    story: ['instagram_story', 'facebook_story'],
    image: ['instagram_feed_image', 'facebook_image'],
    post: ['instagram_feed_video', 'facebook_video'],
  } as const
  return types.flatMap((type) => [...map[type]])
}

api.post('/content/bulk-delete', requireSession, async (req, res) => {
  const parsed = z.object({ types: z.array(bulkContentTypes).min(1).max(4).optional() }).safeParse(req.body ?? {})
  if (!parsed.success) throw new HttpError(400, 'Choose which items to delete.')
  const formats = parsed.data.types?.length ? formatsForTypes(parsed.data.types) : null
  const items = await prisma.content.findMany({
    where: {
      status: { not: 'processing' },
      ...(formats ? { OR: [{ format: { in: formats } }, { destinations: { some: { format: { in: formats } } } }] } : {}),
    },
    include: { destinations: true },
  })
  for (const item of items) {
    for (const publication of item.destinations) await removePublicationJob(publication.id)
    await prisma.content.delete({ where: { id: item.id } })
    await audit('content.delete', 'Content', item.id, 'Removed from a bulk delete in the workspace. Live posts were left online.')
  }
  res.json({ ok: true, deleted: items.length })
})

api.get('/content/:id', requireSession, async (req, res) => {
  res.json({ item: await presentContent(await loadContent(String(req.params.id))) })
})

api.post('/content', requireSession, async (req, res) => {
  const parsed = contentSchema.safeParse(req.body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new HttpError(400, issue?.path.includes('publishOptions') ? issue.message : 'Check the title, format, and schedule time.')
  }
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
  const songFormats = new Set(['instagram_reel', 'instagram_feed_video'])
  if (input.audio && !destinations.some((destination) => songFormats.has(destination.format))) {
    throw new HttpError(400, 'A song from Instagram can be attached to an Instagram Reel. Stories and Facebook posts keep the audio already inside the file.')
  }
  if (input.audio) {
    const withoutPage = accounts.find((account) => !pageTokenCipher(account) && destinations.some((destination) => destination.accountId === account.id && songFormats.has(destination.format)))
    if (withoutPage) {
      throw new HttpError(400, `${withoutPage.name} is connected without its Facebook Page, so Instagram will not attach the song there. Reconnect that account through its Facebook Page, or untick it.`)
    }
  }
  const coverFormats = new Set(['instagram_reel', 'instagram_feed_video', 'facebook_reel', 'facebook_video'])
  const wantsCover = destinations.some((destination) => coverFormats.has(destination.format))
  let coverMediaId: string | null = null
  if (wantsCover && input.coverMediaId) {
    const cover = await prisma.mediaAsset.findUnique({ where: { id: input.coverMediaId } })
    if (!cover || cover.kind !== 'image' || (cover.mime !== 'image/jpeg' && cover.mime !== 'image/png')) {
      throw new HttpError(400, 'The cover must be a JPEG or PNG photo.')
    }
    coverMediaId = cover.id
  }
  const thumbOffsetMs = wantsCover && !coverMediaId ? input.thumbOffsetMs ?? null : null
  const created = await prisma.content.create({
    data: {
      title: input.title,
      caption: input.caption,
      hashtags: input.hashtags,
      firstComment: input.firstComment?.trim() || null,
      audioId: input.audio?.id ?? null,
      audioTitle: input.audio?.title ?? null,
      audioArtist: input.audio?.artist ?? null,
      audioVolume: input.audio?.audioVolume ?? 100,
      videoVolume: input.audio?.videoVolume ?? 60,
      coverMediaId,
      thumbOffsetMs,
      publishOptions: JSON.stringify(input.publishOptions ?? {}),
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
  res.status(input.action === 'publish' ? 202 : 201).json({ item: await presentContent(item) })
})

api.patch('/content/:id', requireSession, async (req, res) => {
  const item = await loadContent(String(req.params.id))
  assertEditable(item)
  const parsed = z.object({
    title: z.string().trim().min(2).max(120).optional(),
    caption: z.string().max(5000).optional(),
    hashtags: z.string().max(1000).optional(),
    firstComment: z.string().max(2200).nullable().optional(),
    mediaId: z.string().nullable().optional(),
    coverMediaId: z.string().nullable().optional(),
    thumbOffsetMs: z.number().int().min(0).max(15 * 60 * 1000).nullable().optional(),
    audio: z.object({
      id: z.string().trim().min(1).max(64),
      title: z.string().trim().min(1).max(200),
      artist: z.string().trim().max(200).nullable().optional(),
      audioVolume: z.number().int().min(1).max(100).default(100),
      videoVolume: z.number().int().min(1).max(100).default(60),
    }).nullable().optional(),
    destinations: z.array(destinationSchema).max(20).optional(),
    publishOptions: publishOptionsSchema.optional(),
  }).safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message && parsed.error.issues[0].path.includes('publishOptions') ? parsed.error.issues[0].message : 'Check the content fields.')
  const patch = parsed.data
  await prisma.content.update({
    where: { id: item.id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.caption !== undefined ? { caption: patch.caption } : {}),
      ...(patch.hashtags !== undefined ? { hashtags: patch.hashtags } : {}),
      ...(patch.firstComment !== undefined ? { firstComment: patch.firstComment } : {}),
      ...(patch.mediaId !== undefined ? { mediaId: patch.mediaId } : {}),
      ...(patch.audio !== undefined ? {
        audioId: patch.audio?.id ?? null,
        audioTitle: patch.audio?.title ?? null,
        audioArtist: patch.audio?.artist ?? null,
        audioVolume: patch.audio?.audioVolume ?? 100,
        videoVolume: patch.audio?.videoVolume ?? 60,
      } : {}),
      ...(patch.coverMediaId !== undefined ? { coverMediaId: patch.coverMediaId } : {}),
      ...(patch.thumbOffsetMs !== undefined ? { thumbOffsetMs: patch.thumbOffsetMs } : {}),
      ...(patch.publishOptions !== undefined ? { publishOptions: JSON.stringify(patch.publishOptions) } : {}),
    },
  })
  if (patch.destinations) {
    const scheduled = item.destinations.some((destination) => destination.status !== 'draft')
    const same = item.destinations.length === patch.destinations.length
      && item.destinations.every((destination) => patch.destinations?.some((next) => next.accountId === destination.accountId && next.format === destination.format))
    if (!same) {
      if (scheduled) throw new HttpError(409, 'Cancel the schedule before changing Instagram or Facebook on this item.')
      const seen = new Set<string>()
      for (const destination of patch.destinations) {
        if (platformFor(destination.format) !== destination.platform) throw new HttpError(400, 'Each destination must use a format for its own platform.')
        const key = `${destination.accountId}:${destination.format}`
        if (seen.has(key)) throw new HttpError(400, 'Each account can only be selected once for a format.')
        seen.add(key)
        const account = await prisma.socialAccount.findUnique({ where: { id: destination.accountId } })
        if (!account || !account.connected) throw new HttpError(400, 'That account is no longer connected.')
      }
      for (const destination of item.destinations) await removePublicationJob(destination.id)
      await prisma.contentDestination.deleteMany({ where: { contentId: item.id } })
      if (patch.destinations.length > 0) {
        await prisma.contentDestination.createMany({
          data: patch.destinations.map((destination) => ({
            contentId: item.id,
            accountId: destination.accountId,
            platform: destination.platform,
            format: destination.format,
            status: 'draft',
            idempotencyKey: `${item.id}:${destination.accountId}:${destination.format}`,
          })),
        })
        await prisma.content.update({ where: { id: item.id }, data: { format: patch.destinations[0]?.format ?? item.format } })
      }
    }
  }
  await audit('content.edit', 'Content', item.id, 'Updated draft or scheduled fields without creating a new publication.')
  res.json({ item: await presentContent(await loadContent(item.id)) })
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
  res.json({ item: await presentContent(await loadContent(item.id)) })
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
  res.json({ item: await presentContent(await loadContent(item.id)) })
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
  res.status(202).json({ item: await presentContent(await loadContent(item.id)) })
})

api.post('/content/:id/duplicate', requireSession, async (req, res) => {
  const existing = await loadContent(String(req.params.id))
  const item = await prisma.content.create({
    data: {
      title: `${existing.title} copy`.slice(0, 120),
      caption: existing.caption,
      hashtags: existing.hashtags,
      firstComment: existing.firstComment,
      audioId: existing.audioId,
      audioTitle: existing.audioTitle,
      audioArtist: existing.audioArtist,
      audioVolume: existing.audioVolume,
      videoVolume: existing.videoVolume,
      coverMediaId: existing.coverMediaId,
      thumbOffsetMs: existing.thumbOffsetMs,
      publishOptions: existing.publishOptions,
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
  res.status(201).json({ item: await presentContent(await loadContent(item.id)) })
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
  res.status(202).json({ item: await presentContent(await loadContent(item.id)) })
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
  res.json({ item: await presentContent(await loadContent(item.id)) })
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
  res.json({ item: await presentContent(await loadContent(schedule.destination.contentId)) })
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
  res.json({ item: await presentContent(await loadContent(destination.contentId)) })
})

api.get('/calendar', requireSession, async (req, res) => {
  res.json(await listContent(req))
})

api.get('/publishing-history', requireSession, async (req, res) => {
  res.json(await listContent(req, ['published', 'failed', 'partially_published', 'cancelled', 'processing']))
})

api.get('/publishing-history/:id', requireSession, async (req, res) => {
  res.json({ item: await presentContent(await loadContent(String(req.params.id))) })
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
  res.status(202).json({ item: await presentContent(await loadContent(item.id)) })
})

api.post('/content/:id/repost', requireSession, async (req, res) => {
  const existing = await loadContent(String(req.params.id))
  const item = await prisma.content.create({
    data: {
      title: `${existing.title} repost`.slice(0, 120),
      caption: existing.caption,
      hashtags: existing.hashtags,
      firstComment: existing.firstComment,
      audioId: existing.audioId,
      audioTitle: existing.audioTitle,
      audioArtist: existing.audioArtist,
      audioVolume: existing.audioVolume,
      videoVolume: existing.videoVolume,
      coverMediaId: existing.coverMediaId,
      thumbOffsetMs: existing.thumbOffsetMs,
      publishOptions: existing.publishOptions,
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
  res.status(201).json({ item: await presentContent(await loadContent(item.id)) })
})
