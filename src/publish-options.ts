import { z } from 'zod'
import type { ContentFormat } from './domain.js'

const handle = z.string().trim().transform((value) => value.replace(/^@+/, '')).pipe(z.string().regex(/^[A-Za-z0-9._]{1,30}$/, 'Instagram usernames use letters, numbers, periods, and underscores.'))
const placeId = z.string().trim().regex(/^\d{3,30}$/, 'Choose a place from the search results.')
const unit = z.number().min(0).max(1)

export const facebookAgeLimits = [13, 15, 17, 18, 19, 21, 25, 65] as const

export const publishOptionsSchema = z.object({
  instagram: z.object({
    location: z.object({ id: placeId, name: z.string().trim().min(1).max(200) }).nullable().optional(),
    userTags: z.array(z.object({ username: handle, x: unit.optional(), y: unit.optional() })).max(20).optional(),
    collaborators: z.array(handle).max(3).optional(),
    altText: z.string().trim().max(1000).optional(),
    shareToFeed: z.boolean().optional(),
    trialReel: z.enum(['off', 'MANUAL', 'SS_PERFORMANCE']).optional(),
    audioName: z.string().trim().max(100).optional(),
    commentsOff: z.boolean().optional(),
  }).optional(),
  facebook: z.object({
    place: z.object({ id: placeId, name: z.string().trim().min(1).max(200) }).nullable().optional(),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(25).optional(),
    ageMin: z.number().int().refine((value) => (facebookAgeLimits as readonly number[]).includes(value), 'Choose a supported age limit.').nullable().optional(),
    altText: z.string().trim().max(1000).optional(),
    videoTitle: z.string().trim().max(255).optional(),
  }).optional(),
})

export type PublishOptions = z.infer<typeof publishOptionsSchema>

export function readPublishOptions(raw: string | null | undefined): PublishOptions {
  if (!raw) return {}
  try {
    const parsed = publishOptionsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

export type InstagramOptions = NonNullable<PublishOptions['instagram']>
export type FacebookOptions = NonNullable<PublishOptions['facebook']>

// Meta ignores or rejects these fields on formats that do not support them, so drop them before sending.
export function instagramOptionsFor(format: ContentFormat, options: PublishOptions): InstagramOptions {
  const source = options.instagram ?? {}
  if (format === 'instagram_story') return {}
  const reel = format === 'instagram_reel' || format === 'instagram_feed_video'
  return {
    location: source.location ?? null,
    userTags: source.userTags ?? [],
    collaborators: source.collaborators ?? [],
    altText: source.altText || undefined,
    shareToFeed: reel ? source.shareToFeed : undefined,
    trialReel: reel ? source.trialReel : undefined,
    audioName: reel ? source.audioName || undefined : undefined,
    commentsOff: source.commentsOff ?? false,
  }
}

export function facebookOptionsFor(format: ContentFormat, options: PublishOptions): FacebookOptions {
  const source = options.facebook ?? {}
  if (format === 'facebook_image') {
    return { place: source.place ?? null, countries: source.countries ?? [], ageMin: source.ageMin ?? null, altText: source.altText || undefined }
  }
  if (format === 'facebook_video') {
    return { countries: source.countries ?? [], ageMin: source.ageMin ?? null, videoTitle: source.videoTitle || undefined }
  }
  return {}
}

export function facebookTargeting(options: FacebookOptions) {
  const countries = options.countries ?? []
  if (countries.length === 0 && !options.ageMin) return null
  return JSON.stringify({
    ...(countries.length > 0 ? { geo_locations: { countries } } : {}),
    ...(options.ageMin ? { age_min: options.ageMin } : {}),
  })
}
