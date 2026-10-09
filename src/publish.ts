import type { Content, ContentDestination, MediaAsset, SocialAccount } from '@prisma/client'
import { prisma } from './db.js'
import { HttpError, platformFor, validateProbe, type ContentFormat } from './domain.js'
import { socialProvider } from './meta/provider.js'
import { publicBaseIsLocal, remoteCopyEnabled, storage } from './storage.js'

export class PermanentPublishError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message)
    this.name = 'PermanentPublishError'
  }
}

export function isPermanent(error: unknown) {
  return error instanceof PermanentPublishError || (error instanceof HttpError && error.status !== 429 && error.status < 500)
}

function scopesOf(account: SocialAccount) {
  try {
    return JSON.parse(account.grantedScopes) as string[]
  } catch {
    return []
  }
}

export function storySupport(account: SocialAccount | null, format: ContentFormat) {
  if (!format.endsWith('story')) return { supported: true, message: 'This format is supported by the current Graph API integration.' }
  if (!account) {
    return { supported: false, message: 'Not supported by current API integration until an eligible account is connected.' }
  }
  const scopes = scopesOf(account)
  if (format === 'instagram_story') {
    if (account.accountType === 'MEDIA_CREATOR') {
      return { supported: false, message: 'Not supported by current API integration. Instagram Stories publish only to Business accounts.' }
    }
    if (account.accountType !== 'BUSINESS') {
      return { supported: false, message: 'Not supported by current API integration. Instagram Stories require a confirmed Business account.' }
    }
    if (!scopes.some((scope) => scope === 'instagram_business_content_publish' || scope === 'instagram_content_publish')) {
      return { supported: false, message: 'Not supported by current API integration. Reconnect Instagram and grant publishing permission.' }
    }
    return { supported: true, message: 'Instagram Stories are supported for this Business account.' }
  }
  if (!scopes.includes('pages_manage_posts')) {
    return { supported: false, message: 'Not supported by current API integration. Facebook Stories need Page posting permission.' }
  }
  if (!account.eligible) {
    return { supported: false, message: account.eligibilityReason || 'Not supported by current API integration for this Page role.' }
  }
  return { supported: true, message: 'Facebook photo and video Stories are supported for this Page.' }
}

export function assertCanPublish(account: SocialAccount, format: ContentFormat, firstComment: string | null) {
  if (!account.connected || !account.tokenCipher) {
    throw new PermanentPublishError(400, 'Connect this account before publishing.')
  }
  if (account.tokenStatus === 'expired' || account.tokenStatus === 'revoked' || account.tokenStatus === 'disconnected') {
    throw new PermanentPublishError(400, 'Reconnect this account. Its access expired or was revoked.')
  }
  if (account.platform !== platformFor(format)) {
    throw new PermanentPublishError(400, 'Choose an account on the same platform as this content.')
  }
  const scopes = scopesOf(account)
  if (format.startsWith('instagram') && !scopes.some((scope) => scope === 'instagram_business_content_publish' || scope === 'instagram_content_publish')) {
    throw new PermanentPublishError(400, 'This Instagram connection is missing publishing permission. Reconnect it.')
  }
  if (format.startsWith('facebook') && !scopes.includes('pages_manage_posts')) {
    throw new PermanentPublishError(400, 'This Page connection is missing posting permission. Reconnect it.')
  }
  if (!account.eligible) {
    throw new PermanentPublishError(400, account.eligibilityReason || 'This account is not eligible to publish.')
  }
  const stories = storySupport(account, format)
  if (!stories.supported) throw new PermanentPublishError(400, stories.message)
  if (firstComment?.trim() && format.startsWith('instagram') && !scopes.some((scope) => scope === 'instagram_business_manage_comments' || scope === 'instagram_manage_comments')) {
    throw new PermanentPublishError(400, 'Reconnect Instagram and allow comment permission before adding a first comment.')
  }
  if (firstComment?.trim() && !format.startsWith('instagram')) {
    throw new PermanentPublishError(400, 'A first comment is available for Instagram feed posts and Reels.')
  }
}

export function quotaError(count: number, format: ContentFormat) {
  if (format.startsWith('instagram') && count >= 100) return 'This Instagram account reached the 100 API-published posts allowed in 24 hours.'
  if (format === 'facebook_reel' && count >= 30) return 'This Page reached the 30 Reels allowed in 24 hours.'
  return null
}

async function assertRateLimit(accountId: string, format: ContentFormat) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const count = await prisma.contentDestination.count({
    where: {
      accountId,
      status: 'published',
      publishedAt: { gte: since },
      format: format.startsWith('instagram') ? { startsWith: 'instagram' } : format,
    },
  })
  const message = quotaError(count, format)
  if (message) throw new HttpError(429, message)
}

const terminal = new Set(['published', 'failed', 'cancelled'])

export function rollupStatus(statuses: string[]) {
  if (statuses.length === 0) return 'draft'
  if (statuses.every((status) => status === 'cancelled')) return 'cancelled'
  if (statuses.every((status) => status === 'draft')) return 'draft'
  if (statuses.some((status) => status === 'processing')) return 'processing'
  if (statuses.every((status) => status === 'scheduled')) return 'scheduled'
  if (statuses.every((status) => status === 'published')) return 'published'
  if (statuses.every((status) => status === 'failed')) return 'failed'
  if (statuses.some((status) => status === 'published') && statuses.some((status) => status === 'failed')) return 'partially_published'
  if (statuses.some((status) => status === 'scheduled')) return 'scheduled'
  if (statuses.every((status) => terminal.has(status)) && statuses.some((status) => status === 'published')) return 'partially_published'
  return 'processing'
}

export async function rollupContent(contentId: string) {
  const item = await prisma.content.findUnique({
    where: { id: contentId },
    include: { destinations: true },
  })
  if (!item) return null
  const statuses = item.destinations.map((publication) => publication.status)
  const status = rollupStatus(statuses)
  const scheduledAt = item.destinations
    .map((publication) => publication.scheduledAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null
  const publishedAt = item.destinations
    .map((publication) => publication.publishedAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())
    .at(-1) ?? null
  const error = item.destinations.find((publication) => publication.error)?.error ?? null
  const updated = await prisma.content.update({
    where: { id: contentId },
    data: { status, scheduledAt, publishedAt, error: status === 'published' ? null : error },
  })
  if (item.status !== status && (status === 'published' || status === 'failed' || status === 'partially_published')) {
    const failed = item.destinations.filter((publication) => publication.status === 'failed')
    const published = item.destinations.filter((publication) => publication.status === 'published')
    const body = status === 'published'
      ? `${item.title} was published.`
      : status === 'partially_published'
        ? `${item.title} published on ${published.map((publication) => publication.platform).join(' and ')}. ${failed.map((publication) => `${publication.platform}: ${publication.error ?? 'failed'}`).join(' ')}`
        : `${item.title} failed. ${failed.map((publication) => publication.error).filter(Boolean).join(' ') || error || 'The publishing job failed.'}`
    await prisma.notification.create({
      data: {
        contentId,
        kind: status === 'published' ? 'success' : status === 'partially_published' ? 'partial' : 'failure',
        title: item.title,
        body,
      },
    })
  }
  return updated
}

export function permalinkFor(platform: string, externalId: string | null) {
  if (!externalId) return null
  if (externalId.startsWith('https://')) return externalId
  if (platform === 'facebook' && /^\d+_\d+$/.test(externalId)) {
    const [pageId, postId] = externalId.split('_')
    return `https://www.facebook.com/${pageId}/posts/${postId}`
  }
  return null
}

type Loaded = ContentDestination & { content: Content & { media: MediaAsset | null }; account: SocialAccount }

export async function deliver(publicationId: string) {
  const existing = await prisma.contentDestination.findUnique({
    where: { id: publicationId },
    include: { content: { include: { media: true } }, account: true },
  })
  if (!existing) return
  if (existing.externalId) {
    if (existing.status !== 'published') {
      await prisma.contentDestination.update({
        where: { id: existing.id },
        data: { status: 'published', lockedAt: null },
      })
      await rollupContent(existing.contentId)
    }
    return
  }
  const stale = new Date(Date.now() - 10 * 60 * 1000)
  const claimed = await prisma.contentDestination.updateMany({
    where: {
      id: publicationId,
      externalId: null,
      status: { in: ['scheduled', 'processing', 'failed'] },
      OR: [{ lockedAt: null }, { lockedAt: { lt: stale } }],
    },
    data: { status: 'processing', lockedAt: new Date(), error: null },
  })
  if (claimed.count === 0) return
  await rollupContent(existing.contentId)
  const started = new Date()
  try {
    await publishClaimed(existing)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Publishing failed before Meta accepted the content.'
    const retryable = !isPermanent(error)
    const errorCode = error instanceof HttpError ? String(error.status) : 'publish_failed'
    await prisma.publishingAttempt.create({
      data: {
        destinationId: publicationId,
        startedAt: started,
        finishedAt: new Date(),
        outcome: 'failed',
        errorCode,
        message,
        retryable,
      },
    })
    await prisma.contentDestination.update({
      where: { id: publicationId },
      data: {
        status: retryable ? 'processing' : 'failed',
        errorCode,
        error: message,
        retryable,
        lockedAt: null,
        attemptCount: { increment: 1 },
      },
    })
    await rollupContent(existing.contentId)
    throw error
  }
}

async function publishClaimed(existing: Loaded) {
  const { content, account } = existing
  if (!content.media) throw new PermanentPublishError(400, 'Upload media before publishing.')
  const format = existing.format as ContentFormat
  assertCanPublish(account, format, content.firstComment)
  await assertRateLimit(account.id, format)
  const bytes = await storage.open(content.media.storageKey).read()
  const errors = validateProbe(format, {
    mime: content.media.mime,
    kind: content.media.kind as 'image' | 'video',
    width: content.media.width,
    height: content.media.height,
    durationMs: content.media.durationMs,
    bytes: bytes.length,
  })
  if (errors.length > 0) throw new PermanentPublishError(400, errors[0] ?? 'This file does not meet the platform requirements.')
  let publicUrl: string | null = null
  if (content.media.kind === 'image' && format.startsWith('instagram')) {
    if (!remoteCopyEnabled && publicBaseIsLocal()) {
      throw new PermanentPublishError(400, 'Instagram has to download the image from a public HTTPS URL. Set PUBLIC_BASE_URL to a public address, or configure S3 storage.')
    }
    publicUrl = await storage.open(content.media.storageKey).publicUrl(content.media.id, 60 * 60)
  }
  if (!account.tokenCipher) throw new PermanentPublishError(400, 'Reconnect this account before publishing.')
  const { decryptSecret } = await import('./crypto.js')
  const result = await socialProvider.publish({
    format,
    caption: content.caption,
    hashtags: content.hashtags,
    firstComment: content.firstComment,
    token: decryptSecret(account.tokenCipher),
    pageId: account.pageId,
    igId: account.platform === 'instagram' ? account.externalId : null,
    instagramLogin: account.tasks.includes('INSTAGRAM_LOGIN'),
    kind: content.media.kind as 'image' | 'video',
    mime: content.media.mime,
    bytes,
    publicUrl,
    audio: content.audioId ? {
      id: content.audioId,
      audioVolume: content.audioVolume,
      videoVolume: content.videoVolume,
    } : null,
  })
  await prisma.contentDestination.update({
    where: { id: existing.id },
    data: {
      status: 'published',
      publishedAt: new Date(),
      externalId: result.externalId,
      permalink: permalinkFor(existing.platform, result.externalId),
      errorCode: null,
      responseMeta: JSON.stringify({ externalId: result.externalId, warning: result.warning ?? null }),
      error: result.warning ?? null,
      retryable: false,
      lockedAt: null,
      attemptCount: { increment: 1 },
    },
  })
  await prisma.publishingAttempt.create({
    data: {
      destinationId: existing.id,
      finishedAt: new Date(),
      outcome: 'succeeded',
      message: result.warning ?? `Published as ${result.externalId}`,
      retryable: false,
    },
  })
  await prisma.auditLog.create({
    data: {
      action: 'publish.confirmed',
      entityType: 'ContentDestination',
      entityId: existing.id,
      detail: result.externalId,
    },
  })
  await rollupContent(existing.contentId)
}
