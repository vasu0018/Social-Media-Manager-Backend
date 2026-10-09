export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export const contentFormats = [
  'instagram_reel',
  'instagram_story',
  'instagram_feed_image',
  'instagram_feed_video',
  'facebook_reel',
  'facebook_story',
  'facebook_image',
  'facebook_video',
] as const

export type ContentFormat = (typeof contentFormats)[number]

export function platformFor(format: ContentFormat) {
  return format.startsWith('instagram') ? 'instagram' : 'facebook'
}

export function coarseType(format: ContentFormat) {
  if (format.endsWith('reel')) return 'reel'
  if (format.endsWith('story')) return 'story'
  if (format.endsWith('image') || format === 'instagram_feed_image') return 'image'
  return 'post'
}

export type Probe = {
  mime: string
  kind: 'image' | 'video'
  width: number | null
  height: number | null
  durationMs: number | null
  bytes: number
}

export type MediaRule = {
  label: string
  kinds: Array<'image' | 'video'>
  mimes: string[]
  maxBytes: number
  minDurationMs?: number
  maxDurationMs?: number
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  minAspect?: number
  maxAspect?: number
  aspectTarget?: number
  aspectTolerance?: number
  note?: string
}

const mb = (value: number) => value * 1024 * 1024

// Limits follow Instagram User Media and Facebook Reels/Stories docs for Graph API v26.0.
export const mediaRules: Record<ContentFormat, MediaRule> = {
  instagram_feed_image: {
    label: 'Instagram feed image',
    kinds: ['image'],
    mimes: ['image/jpeg'],
    maxBytes: mb(8),
    minWidth: 320,
    maxWidth: 1440,
    minAspect: 0.8,
    maxAspect: 1.91,
    note: 'JPEG only. Aspect ratio must be between 4:5 and 1.91:1.',
  },
  instagram_reel: {
    label: 'Instagram Reel',
    kinds: ['video'],
    mimes: ['video/mp4', 'video/quicktime'],
    maxBytes: mb(300),
    minDurationMs: 3000,
    maxDurationMs: 15 * 60 * 1000,
    maxWidth: 1920,
    minAspect: 0.01,
    maxAspect: 10,
    note: 'MP4 or MOV, 3 seconds to 15 minutes, up to 300 MB. 9:16 is recommended.',
  },
  instagram_feed_video: {
    label: 'Instagram feed video',
    kinds: ['video'],
    mimes: ['video/mp4', 'video/quicktime'],
    maxBytes: mb(300),
    minDurationMs: 3000,
    maxDurationMs: 15 * 60 * 1000,
    maxWidth: 1920,
    minAspect: 0.01,
    maxAspect: 10,
    note: 'Graph API v26 publishes feed video as a Reel with share_to_feed enabled.',
  },
  instagram_story: {
    label: 'Instagram Story',
    kinds: ['image', 'video'],
    mimes: ['image/jpeg', 'video/mp4', 'video/quicktime'],
    maxBytes: mb(100),
    minDurationMs: 3000,
    maxDurationMs: 60_000,
    maxWidth: 1920,
    note: 'Stories publish only to Instagram Business accounts. Video is 3 to 60 seconds. 9:16 is recommended.',
  },
  facebook_image: {
    label: 'Facebook image post',
    kinds: ['image'],
    mimes: ['image/jpeg', 'image/png'],
    maxBytes: mb(10),
    minWidth: 320,
    note: 'JPEG or PNG, up to 10 MB.',
  },
  facebook_video: {
    label: 'Facebook video post',
    kinds: ['video'],
    mimes: ['video/mp4', 'video/quicktime'],
    maxBytes: mb(300),
    minDurationMs: 1000,
    maxDurationMs: 20 * 60 * 1000,
    note: 'MP4 or MOV, up to 300 MB.',
  },
  facebook_reel: {
    label: 'Facebook Reel',
    kinds: ['video'],
    mimes: ['video/mp4', 'video/quicktime'],
    maxBytes: mb(300),
    minDurationMs: 3000,
    maxDurationMs: 90_000,
    minWidth: 540,
    minHeight: 960,
    aspectTarget: 9 / 16,
    aspectTolerance: 0.03,
    note: '9:16 video, at least 540×960, 3 to 90 seconds.',
  },
  facebook_story: {
    label: 'Facebook Story',
    kinds: ['image', 'video'],
    mimes: ['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime'],
    maxBytes: mb(100),
    minDurationMs: 3000,
    maxDurationMs: 60_000,
    minWidth: 540,
    minHeight: 960,
    aspectTarget: 9 / 16,
    aspectTolerance: 0.06,
    note: '9:16 photo or video. Video stories are 3 to 60 seconds and at least 540×960.',
  },
}

export function validateProbe(format: ContentFormat, probe: Probe) {
  const rule = mediaRules[format]
  const errors: string[] = []
  if (!rule.kinds.includes(probe.kind)) {
    errors.push(`${rule.label} needs ${rule.kinds.join(' or ')} file.`)
  }
  if (!rule.mimes.includes(probe.mime)) {
    errors.push(`${rule.label} accepts ${rule.mimes.join(', ')}.`)
  }
  const imageCap = format.startsWith('instagram') && probe.kind === 'image' ? 8 * 1024 * 1024 : rule.maxBytes
  if (probe.bytes > imageCap) {
    errors.push(`${rule.label} must be ${Math.round(imageCap / (1024 * 1024))} MB or smaller.`)
  }
  if (probe.kind === 'video') {
    if (probe.durationMs == null) errors.push('The video duration could not be read. Export a standard MP4 and try again.')
    else {
      if (rule.minDurationMs && probe.durationMs < rule.minDurationMs) {
        errors.push(`${rule.label} must be at least ${rule.minDurationMs / 1000} seconds.`)
      }
      if (rule.maxDurationMs && probe.durationMs > rule.maxDurationMs) {
        errors.push(`${rule.label} must be ${rule.maxDurationMs / 1000} seconds or shorter.`)
      }
    }
  }
  if (probe.width != null && probe.height != null && probe.height > 0) {
    const aspect = probe.width / probe.height
    const sizeFloor = !(format === 'facebook_story' && probe.kind === 'image')
    if (sizeFloor && rule.minWidth && probe.width < rule.minWidth) errors.push(`Width must be at least ${rule.minWidth} pixels.`)
    if (rule.maxWidth && probe.width > rule.maxWidth) errors.push(`Width must be ${rule.maxWidth} pixels or less.`)
    if (sizeFloor && rule.minHeight && probe.height < rule.minHeight) errors.push(`Height must be at least ${rule.minHeight} pixels.`)
    if (rule.minAspect && aspect < rule.minAspect - 0.01) errors.push('The aspect ratio is taller than this format allows.')
    if (rule.maxAspect && aspect > rule.maxAspect + 0.01) errors.push('The aspect ratio is wider than this format allows.')
    if (rule.aspectTarget && rule.aspectTolerance && Math.abs(aspect - rule.aspectTarget) > rule.aspectTolerance) {
      errors.push(`${rule.label} needs a 9:16 frame.`)
    }
  } else if (probe.kind === 'image' || format === 'facebook_reel' || format === 'facebook_story') {
    errors.push('The file dimensions could not be read.')
  }
  return errors
}
