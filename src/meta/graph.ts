import { env, instagramConfigured, metaConfigured } from '../env.js'
import { HttpError, type ContentFormat } from '../domain.js'
import { facebookTargeting, type FacebookOptions, type InstagramOptions } from '../publish-options.js'
import { redact } from '../security.js'

export type DiscoveredAccount = {
  platform: 'instagram' | 'facebook'
  externalId: string
  pageId: string
  name: string
  handle: string
  pictureUrl: string | null
  accountType: string | null
  followers: number
  scopes: string[]
  tasks: string[]
  token: string
  tokenExpiresAt: Date | null
  dataAccessExpiresAt: Date | null
  tokenStatus: string
  eligible: boolean
  eligibilityReason: string | null
}

type DebugData = {
  is_valid?: boolean
  scopes?: string[]
  granular_scopes?: Array<{ scope?: string; target_ids?: string[] }>
  expires_at?: number
  data_access_expires_at?: number
  error?: { code?: number; message?: string }
}

const createTasks = new Set([
  'CREATE_CONTENT',
  'MANAGE',
  'PROFILE_PLUS_CREATE_CONTENT',
  'PROFILE_PLUS_FULL_CONTROL',
])

function version() {
  return env.META_GRAPH_VERSION || 'v26.0'
}

export function classifyMetaError(status: number, message: string, code?: string) {
  if (message.includes('revoked') || message.includes('session has expired')) return new HttpError(401, message, code)
  if (status === 429 || ['4', '17', '32', '613'].includes(code ?? '') || /request limit|rate limit|too many calls|temporarily unavailable/i.test(message)) return new HttpError(429, message, code)
  if (status >= 400 && status < 500) return new HttpError(status, message, code)
  return new HttpError(503, message, code)
}

const reelSpecs = 'Instagram Reel specs: MP4 with H.264 video (max 25 Mbps, max 60 fps, 8-bit 4:2:0 colour, no HDR) and AAC audio (max 128 kbps, 48 kHz), vertical 9:16.'

const instagramErrors: Record<string, string> = {
  '2207001': 'Instagram had a server error while processing this media. Publish again in a few minutes.',
  '2207003': 'Instagram took too long to download this media. Publish again; if it keeps failing, upload a smaller file.',
  '2207004': 'This image is larger than Instagram allows (8 MB). Upload a smaller image.',
  '2207005': 'Instagram does not accept this image format. Upload a JPEG photo.',
  '2207008': 'The Instagram upload expired before it was published. Publish again.',
  '2207009': 'Instagram does not accept this aspect ratio. Feed photos must be between 4:5 and 1.91:1; Reels and Stories should be 9:16.',
  '2207010': 'The caption is longer than Instagram allows (2,200 characters).',
  '2207020': 'The Instagram upload expired before it was published. Publish again.',
  '2207026': `Instagram does not accept this video file. ${reelSpecs} Export the video again and re-upload it.`,
  '2207042': 'This Instagram account reached the daily publishing limit set by Instagram. Try again after 24 hours.',
  '2207050': 'Instagram has restricted this account. Open the Instagram app and check the account status.',
  '2207051': 'Instagram blocked this post as possible spam or a policy issue. Change the caption or media and try again.',
  '2207052': 'Instagram could not download the media from the storage link. Check that the S3 bucket is reachable from the internet, then publish again.',
  '2207053': 'Instagram hit an unknown error while uploading the video. Publish again.',
  '2207057': 'The cover frame time is outside the video. Pick a cover frame inside the video, then publish again.',
  '2207077': `Instagram downloaded the video but could not process it. This happens when the file breaks the ${reelSpecs} It also happens when Instagram does not allow the chosen song on this account, or when Instagram's video processing fails for a while. Publish again; if it fails again, remove the song or re-export the video.`,
}

export const transientInstagramErrors = new Set(['2207001', '2207003', '2207053', '2207077'])

export function instagramErrorText(code: string) {
  return instagramErrors[code] ?? null
}

function scrub(value: string) {
  return redact(value).slice(0, 500)
}

type MetaErrorBody = { error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } }

function errorText(parsed: MetaErrorBody) {
  const message = parsed.error?.message ?? 'Meta rejected the request.'
  if (parsed.error?.code === 190) return 'The connection was revoked. Reconnect the account.'
  if (/validating client secret/i.test(message)) {
    return 'The app secret does not match this Meta app. Paste the Facebook App secret into META_APP_SECRET, then restart the API.'
  }
  const subcode = parsed.error?.error_subcode ? String(parsed.error.error_subcode) : null
  const known = subcode ? instagramErrorText(subcode) : null
  if (known) return known
  return scrub(parsed.error?.error_user_msg || message)
}

async function readError(response: Response) {
  const body = await response.text()
  try {
    return errorText(JSON.parse(body) as MetaErrorBody)
  } catch {
    return 'Meta rejected the request.'
  }
}

async function readFailure(response: Response) {
  const body = await response.text()
  try {
    const parsed = JSON.parse(body) as MetaErrorBody
    const code = parsed.error?.error_subcode ?? parsed.error?.code
    return classifyMetaError(response.status, errorText(parsed), code ? String(code) : undefined)
  } catch {
    return classifyMetaError(response.status, 'Meta rejected the request.')
  }
}

async function graph<T>(pathname: string, token: string, init?: { method?: string; body?: BodyInit; host?: string }) {
  const host = init?.host ?? 'https://graph.facebook.com'
  const response = await fetch(`${host}/${version()}${pathname}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body instanceof URLSearchParams ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: init?.body,
  })
  if (!response.ok) throw await readFailure(response)
  return response.json() as Promise<T>
}

function form(fields: Record<string, string>) {
  return new URLSearchParams(fields)
}

function permissionList(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  if (typeof value === 'string') return value.split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean)
  return []
}

function hasScope(scopes: string[], names: string[]) {
  return names.some((name) => scopes.includes(name))
}

const instagramHost = 'https://graph.instagram.com'

function scopesFor(purpose: 'instagram' | 'facebook', includeComments: boolean) {
  if (purpose === 'instagram') {
    const scopes = ['instagram_business_basic', 'instagram_business_content_publish']
    if (includeComments) scopes.push('instagram_business_manage_comments')
    return scopes
  }
  return ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish', 'business_management']
}

function expiryDate(epoch?: number) {
  if (!epoch || epoch <= 0) return null
  return new Date(epoch * 1000)
}

function statusFromDebug(data: DebugData) {
  if (!data.is_valid) return 'revoked'
  const now = Date.now() / 1000
  const expiry = data.expires_at ?? 0
  const access = data.data_access_expires_at ?? 0
  if ((expiry > 0 && expiry <= now) || (access > 0 && access <= now)) return 'expired'
  if ((expiry > 0 && expiry - now < 7 * 86400) || (access > 0 && access - now < 7 * 86400)) return 'expiring'
  return 'valid'
}

function cleanPicture(url?: string | null) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('access_token')
    return parsed.toString()
  } catch {
    return null
  }
}

function canCreate(tasks: string[]) {
  if (tasks.length === 0) return true
  return tasks.some((task) => createTasks.has(task))
}

async function debugToken(token: string): Promise<DebugData> {
  const appToken = `${env.META_APP_ID}|${env.META_APP_SECRET}`
  const result = await graph<{ data: DebugData }>(`/debug_token?input_token=${encodeURIComponent(token)}`, appToken)
  return result.data
}

type PageNode = {
  id: string
  name: string
  access_token: string
  tasks?: string[]
  fan_count?: number
  picture?: { data?: { url?: string } }
  instagram_business_account?: {
    id: string
    username?: string
    name?: string
    profile_picture_url?: string
    followers_count?: number
  }
}

const pageFields = 'id,name,access_token,tasks,fan_count,picture{url},instagram_business_account{id,username,name,profile_picture_url,followers_count}'

async function readPages(url: string, token: string) {
  const pages: PageNode[] = []
  let next: string | null = url
  while (next && pages.length < 100) {
    const response = await fetch(next, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw await readFailure(response)
    const data = await response.json() as { data?: PageNode[]; paging?: { next?: string } }
    pages.push(...(data.data ?? []))
    next = data.paging?.next ?? null
  }
  return pages
}

async function listBusinessPages(userToken: string) {
  let businesses: Array<{ id: string }> = []
  try {
    const result = await graph<{ data?: Array<{ id: string }> }>('/me/businesses?fields=id&limit=25', userToken)
    businesses = result.data ?? []
  } catch {
    return []
  }
  const pages: PageNode[] = []
  for (const business of businesses) {
    for (const edge of ['owned_pages', 'client_pages']) {
      try {
        const result = await graph<{ data?: PageNode[] }>(`/${business.id}/${edge}?fields=${pageFields}&limit=50`, userToken)
        pages.push(...(result.data ?? []))
      } catch {
        // This business edge is not available to the logged-in user.
      }
    }
  }
  return pages
}

async function listPages(userToken: string) {
  const direct = await readPages(`https://graph.facebook.com/${version()}/me/accounts?fields=${encodeURIComponent(pageFields)}&limit=50`, userToken)
  const managed = await listBusinessPages(userToken)
  const byId = new Map<string, PageNode>()
  for (const page of [...direct, ...managed]) {
    if (!page.id) continue
    const current = byId.get(page.id)
    byId.set(page.id, current ? { ...current, ...page, access_token: page.access_token || current.access_token } : page)
  }
  const pages = [...byId.values()]
  for (const page of pages) {
    if (page.access_token) continue
    try {
      const loaded = await graph<PageNode>(`/${page.id}?fields=${pageFields}`, userToken)
      Object.assign(page, { ...loaded, access_token: loaded.access_token || page.access_token })
    } catch {
      // The Page is visible, but this login cannot manage it.
    }
  }
  return pages.filter((page) => Boolean(page.access_token))
}

function missingPageMessage(debug: DebugData | null) {
  const scopes = debug?.scopes ?? []
  if (!scopes.includes('pages_show_list')) {
    return 'Facebook did not grant Page access. Connect again and allow your Pages.'
  }
  const pageScope = debug?.granular_scopes?.find((entry) => entry.scope === 'pages_show_list')
  if (pageScope && Array.isArray(pageScope.target_ids) && pageScope.target_ids.length === 0) {
    return 'No Page was selected. Connect again and tick the Page that owns the Instagram account.'
  }
  return 'This Facebook login does not manage a Page. Log in as the person who manages the Page, and select that Page when Facebook asks.'
}

type PlaceNode = {
  id: string
  name?: string
  link?: string
  location?: { street?: string; city?: string; state?: string; country?: string; zip?: string; latitude?: number; longitude?: number }
}

export type PlaceResult = { id: string; name: string; address: string | null }

function placeResult(node: PlaceNode): PlaceResult | null {
  if (!node.id || !node.name || !node.location) return null
  const where = [node.location.street, node.location.city, node.location.state, node.location.country].filter(Boolean).join(', ')
  return { id: node.id, name: node.name, address: where || null }
}

export function placeReference(query: string) {
  if (/^\d{5,30}$/.test(query)) return query
  try {
    const url = new URL(query)
    if (!/(^|\.)facebook\.com$/.test(url.hostname)) return null
    const id = url.searchParams.get('id')
    if (id && /^\d+$/.test(id)) return id
    const slug = url.pathname.split('/').filter(Boolean).pop() ?? ''
    const numeric = slug.match(/(\d{5,30})$/)?.[1]
    return numeric ?? (/^[A-Za-z0-9.]{3,80}$/.test(slug) ? slug : null)
  } catch {
    return null
  }
}

function nameFromLink(query: string, id: string) {
  try {
    const parts = new URL(query).pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
    const label = parts
      .map((part) => part.replace(id, '').replace(/[-_]+/g, ' ').trim())
      .filter((part) => part && !/^(pages|places|profile\.php)$/i.test(part))
      .pop()
    if (label) return label.slice(0, 120)
  } catch {
    // Not a link.
  }
  return `Facebook place ${id}`
}

const placeFields = 'id,name,link,location{street,city,state,country,zip,latitude,longitude}'

export async function searchPlaces(sources: Array<{ token: string; pageId: string | null }>, query: string) {
  const found = new Map<string, PlaceResult>()
  let searchError: string | null = null
  const add = (node: PlaceNode) => {
    const place = placeResult(node)
    if (place && !found.has(place.id)) found.set(place.id, place)
  }
  const reference = query ? placeReference(query) : null
  if (reference) {
    for (const source of sources) {
      try {
        add(await graph<PlaceNode>(`/${encodeURIComponent(reference)}?fields=${encodeURIComponent(placeFields)}`, source.token))
        break
      } catch {
        // Try the next connection.
      }
    }
    if (found.size === 0 && /^\d+$/.test(reference)) {
      found.set(reference, { id: reference, name: nameFromLink(query, reference), address: null })
      searchError = 'Meta would not show the details of this place to the app, so it is used exactly as pasted. Instagram and Facebook check it when the post is published.'
    } else if (found.size === 0) {
      searchError = 'That link has no place number, and Meta would not look up the name. Open the place on Facebook and copy a link that ends in its number, for example facebook.com/pages/Mumbai/1234567890.'
    }
  } else if (query.length >= 2) {
    let lastError = ''
    for (const source of sources) {
      try {
        const result = await graph<{ data?: PlaceNode[] }>(`/pages/search?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(placeFields)}&limit=25`, source.token)
        for (const node of result.data ?? []) add(node)
        lastError = ''
        break
      } catch (error) {
        lastError = error instanceof Error ? error.message : ''
      }
    }
    if (lastError) {
      searchError = 'Searching places by name needs Meta to approve the Page Public Metadata Access feature for this app. Until then, open the place on Facebook and paste its link here (a link that ends in a number, for example facebook.com/pages/Mumbai/1234567890).'
    }
  }
  const searchBlocked = Boolean(searchError) && !reference
  const lowered = query.toLowerCase()
  for (const source of sources) {
    if (!source.pageId) continue
    try {
      const page = await graph<PlaceNode>(`/${source.pageId}?fields=${encodeURIComponent(placeFields)}`, source.token)
      if (!lowered || reference || page.name?.toLowerCase().includes(lowered) || page.location?.city?.toLowerCase().includes(lowered)) add(page)
    } catch {
      // This Page has no readable location.
    }
  }
  if (searchBlocked && found.size > 0) searchError += ' Your own Pages with an address are listed above.'
  return { places: [...found.values()].slice(0, 25), searchError }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForContainer(id: string, token: string, host?: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const status = await graph<{ status_code?: string; status?: string }>(`/${id}?fields=status_code,status`, token, { host })
    if (status.status_code === 'FINISHED') return
    if (status.status_code === 'EXPIRED') {
      throw new HttpError(400, instagramErrors['2207020'] ?? 'The Instagram upload expired. Publish again.', 'EXPIRED')
    }
    if (status.status_code === 'ERROR') {
      const code = status.status?.match(/error code (\d+)/i)?.[1]
      const known = code ? instagramErrorText(code) : null
      const raw = status.status ? scrub(status.status) : 'Instagram could not process this media.'
      throw new HttpError(400, known ?? raw, code ?? 'ERROR')
    }
    await sleep(4000)
  }
  throw new HttpError(504, 'Instagram is still processing this media. Try publishing again in a few minutes.')
}

function captionFor(format: ContentFormat, caption: string, hashtags: string) {
  const text = [caption.trim(), hashtags.trim()].filter(Boolean).join('\n\n')
  const limit = format.startsWith('instagram') ? 2200 : 5000
  if (text.length > limit) throw new HttpError(400, `The caption must be ${limit.toLocaleString()} characters or fewer.`)
  if (format.startsWith('instagram') && (text.match(/#[^\s#]+/g) ?? []).length > 30) {
    throw new HttpError(400, 'Instagram allows up to 30 hashtags.')
  }
  return text
}

async function uploadInstagramVideo(containerId: string, token: string, bytes: Buffer) {
  const response = await fetch(`https://rupload.facebook.com/ig-api-upload/${version()}/${containerId}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${token}`,
      offset: '0',
      file_size: String(bytes.length),
    },
    body: new Uint8Array(bytes),
  })
  if (!response.ok) throw await readFailure(response)
}

async function publishInstagram(input: PublishInput) {
  if (!input.igId) throw new HttpError(400, 'This Instagram account is missing its professional account id.')
  const host = input.instagramLogin ? instagramHost : undefined
  const text = captionFor(input.format, input.caption, input.hashtags)
  const fields: Record<string, string> = {}
  if (input.format === 'instagram_story') fields.media_type = 'STORIES'
  if (input.format === 'instagram_reel' || input.format === 'instagram_feed_video') {
    fields.media_type = 'REELS'
    if (input.format === 'instagram_feed_video') fields.share_to_feed = 'true'
  }
  if (text && input.format !== 'instagram_story') fields.caption = text
  const reel = input.format === 'instagram_reel' || input.format === 'instagram_feed_video'
  if (input.audio && reel && input.kind === 'video') {
    if (input.instagramLogin) {
      throw new HttpError(400, 'A trending song can be added when this Instagram account is connected through its Facebook Page. Reconnect the Page, then choose that Instagram account.')
    }
    fields.audio_configuration = JSON.stringify({
      audio_id: input.audio.id,
      audio_volume: input.audio.audioVolume,
      video_volume: input.audio.videoVolume,
    })
  }
  if (reel && input.kind === 'video' && input.coverUrl) fields.cover_url = input.coverUrl
  else if (reel && input.kind === 'video' && input.thumbOffsetMs && input.thumbOffsetMs > 0) {
    fields.thumb_offset = String(Math.round(input.thumbOffsetMs))
  }
  const options = input.instagram ?? {}
  if (options.location) fields.location_id = options.location.id
  if (options.userTags && options.userTags.length > 0) {
    fields.user_tags = JSON.stringify(options.userTags.map((tag) => input.kind === 'image'
      ? { username: tag.username, x: tag.x ?? 0.5, y: tag.y ?? 0.5 }
      : { username: tag.username }))
  }
  if (options.collaborators && options.collaborators.length > 0) fields.collaborators = JSON.stringify(options.collaborators)
  if (options.altText) fields.alt_text = options.altText
  if (input.format === 'instagram_reel' && options.shareToFeed !== undefined) fields.share_to_feed = String(options.shareToFeed)
  if (reel && options.trialReel && options.trialReel !== 'off') fields.trial_params = JSON.stringify({ graduation_strategy: options.trialReel })
  if (reel && options.audioName && !input.audio) fields.audio_name = options.audioName

  if (input.kind === 'image') {
    if (!input.publicUrl) {
      throw new HttpError(400, 'Instagram image publishing needs a public HTTPS media URL. Set PUBLIC_BASE_URL to an address Meta can reach, or configure private S3 storage.')
    }
    fields.image_url = input.publicUrl
  } else if (input.audio && reel) {
    if (!input.publicUrl?.startsWith('https://')) {
      throw new HttpError(400, 'Instagram attaches a catalog song only when it downloads the video from a public HTTPS address. Set PUBLIC_BASE_URL to an address Meta can reach.')
    }
    fields.video_url = input.publicUrl
  } else {
    fields.upload_type = 'resumable'
  }

  const warnings: string[] = []
  const startContainer = async () => {
    try {
      return await graph<{ id: string }>(`/${input.igId}/media`, input.token, { method: 'POST', body: form(fields), host })
    } catch (error) {
      if (!fields.location_id || !(error instanceof HttpError) || error.status !== 400 || (error.code && instagramErrorText(error.code))) throw error
      delete fields.location_id
      const container = await graph<{ id: string }>(`/${input.igId}/media`, input.token, { method: 'POST', body: form(fields), host })
      warnings.push(`Published without the location "${options.location?.name}", because Instagram did not accept that place. Paste the place link again in Add location.`)
      return container
    }
  }
  const createContainer = async () => {
    const container = await startContainer()
    if (fields.upload_type === 'resumable') await uploadInstagramVideo(container.id, input.token, input.bytes)
    await waitForContainer(container.id, input.token, host)
    return container.id
  }

  let containerId = ''
  try {
    containerId = await createContainer()
  } catch (error) {
    if (!(error instanceof HttpError) || !error.code || !transientInstagramErrors.has(error.code)) throw error
    await sleep(15000)
    containerId = await createContainer()
  }
  const published = await graph<{ id: string }>(`/${input.igId}/media_publish`, input.token, {
    method: 'POST',
    body: form({ creation_id: containerId }),
    host,
  })
  if (input.firstComment && input.format !== 'instagram_story') {
    try {
      await graph(`/${published.id}/comments`, input.token, { method: 'POST', body: form({ message: input.firstComment }), host })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The first comment was not added.'
      warnings.push(`Published, but the first comment was not added. ${message}`)
    }
  }
  if (options.commentsOff) {
    try {
      await graph(`/${published.id}`, input.token, { method: 'POST', body: form({ comment_enabled: 'false' }), host })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Instagram did not turn off comments.'
      warnings.push(`Published, but commenting is still on. Turn it off in the Instagram app. ${message}`)
    }
  }
  return { externalId: published.id, warning: warnings.length > 0 ? warnings.join(' ') : undefined }
}

async function uploadFacebookBinary(uploadUrl: string, token: string, bytes: Buffer) {
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${token}`,
      offset: '0',
      file_size: String(bytes.length),
    },
    body: new Uint8Array(bytes),
  })
  if (!response.ok) throw await readFailure(response)
}

async function publishFacebook(input: PublishInput) {
  const text = captionFor(input.format, input.caption, input.hashtags)
  const file = new File([new Uint8Array(input.bytes)], input.kind === 'image' ? 'upload.jpg' : 'upload.mp4', { type: input.mime })

  const options = input.facebook ?? {}
  const targeting = facebookTargeting(options)

  if (input.format === 'facebook_image') {
    const photo = (place: boolean) => {
      const body = new FormData()
      if (text) body.set('caption', text)
      if (place && options.place) body.set('place', options.place.id)
      if (targeting) body.set('targeting', targeting)
      if (options.altText) body.set('alt_text_custom', options.altText)
      body.set('source', file)
      return graph<{ id: string }>(`/${input.pageId}/photos`, input.token, { method: 'POST', body })
    }
    try {
      const result = await photo(true)
      return { externalId: result.id }
    } catch (error) {
      if (!options.place || !(error instanceof HttpError) || error.status !== 400) throw error
      const result = await photo(false)
      return {
        externalId: result.id,
        warning: `Published without the check-in "${options.place.name}", because Facebook did not accept that place. Paste the place link again in Check in.`,
      }
    }
  }

  if (input.format === 'facebook_video') {
    const body = new FormData()
    if (text) body.set('description', text)
    if (options.videoTitle) body.set('title', options.videoTitle)
    if (targeting) body.set('targeting', targeting)
    body.set('source', file)
    const result = await graph<{ id: string }>(`/${input.pageId}/videos`, input.token, {
      method: 'POST',
      body,
      host: 'https://graph-video.facebook.com',
    })
    const warning = await preferFacebookCover(result.id, input)
    return { externalId: result.id, warning }
  }

  if (input.format === 'facebook_reel' || (input.format === 'facebook_story' && input.kind === 'video')) {
    const edge = input.format === 'facebook_reel' ? 'video_reels' : 'video_stories'
    const start = await graph<{ video_id: string; upload_url: string }>(`/${input.pageId}/${edge}`, input.token, {
      method: 'POST',
      body: form({ upload_phase: 'start' }),
    })
    await uploadFacebookBinary(start.upload_url, input.token, input.bytes)
    await graph(`/${input.pageId}/${edge}`, input.token, {
      method: 'POST',
      body: form({
        upload_phase: 'finish',
        video_id: start.video_id,
        video_state: 'PUBLISHED',
        description: text,
      }),
    })
    const warning = input.format === 'facebook_reel' ? await preferFacebookCover(start.video_id, input) : undefined
    return { externalId: start.video_id, warning }
  }

  const photo = new FormData()
  photo.set('published', 'false')
  photo.set('source', file)
  const uploaded = await graph<{ id: string }>(`/${input.pageId}/photos`, input.token, { method: 'POST', body: photo })
  const story = await graph<{ post_id?: string; id?: string }>(`/${input.pageId}/photo_stories`, input.token, {
    method: 'POST',
    body: form({ photo_id: uploaded.id }),
  })
  return { externalId: story.post_id ?? story.id ?? uploaded.id }
}

export type PublishInput = {
  format: ContentFormat
  caption: string
  hashtags: string
  firstComment: string | null
  token: string
  pageId: string
  igId: string | null
  instagramLogin?: boolean
  kind: 'image' | 'video'
  mime: string
  bytes: Buffer
  publicUrl: string | null
  audio?: { id: string; audioVolume: number; videoVolume: number } | null
  coverUrl?: string | null
  thumbOffsetMs?: number | null
  coverBytes?: Buffer | null
  coverMime?: string | null
  instagram?: InstagramOptions
  facebook?: FacebookOptions
}

async function preferFacebookCover(videoId: string, input: PublishInput) {
  if (!input.coverBytes || !input.coverMime) return undefined
  try {
    const thumb = new FormData()
    thumb.set('is_preferred', 'true')
    thumb.set('source', new File([new Uint8Array(input.coverBytes)], 'cover.jpg', { type: input.coverMime }))
    await graph(`/${videoId}/thumbnails`, input.token, { method: 'POST', body: thumb })
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Facebook did not accept the cover.'
    return `Published, but Facebook did not use the cover image. ${message}`
  }
}

export type InstagramAudio = {
  id: string
  title: string
  artist: string | null
  durationMs: number | null
  artworkUrl: string | null
  previewUrl: string | null
  type: 'music' | 'original_sound'
}

async function exchangeInstagram(code: string): Promise<DiscoveredAccount[]> {
  if (!instagramConfigured) throw new HttpError(503, 'Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET from API setup with Instagram login.')
  const short = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID,
      client_secret: env.INSTAGRAM_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: env.META_REDIRECT_URI,
      code: code.replace(/#_$/, ''),
    }),
  })
  if (!short.ok) throw new HttpError(502, await readError(short))
  const payload = await short.json() as {
    access_token?: string
    user_id?: string | number
    permissions?: string | string[]
    data?: Array<{ access_token?: string; user_id?: string | number; permissions?: string | string[] }>
  }
  const first = payload.data?.[0]
  const shortToken = payload.access_token ?? first?.access_token
  if (!shortToken) throw new HttpError(502, 'Instagram did not return an access token.')
  const long = await fetch(`https://graph.instagram.com/access_token?${new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: env.INSTAGRAM_APP_SECRET,
    access_token: shortToken,
  })}`)
  if (!long.ok) throw new HttpError(502, await readError(long))
  const longToken = await long.json() as { access_token?: string; expires_in?: number }
  const token = longToken.access_token ?? shortToken
  const scopes = permissionList(payload.permissions ?? first?.permissions)
  const profile = await graph<{
    user_id?: string
    id?: string
    username?: string
    name?: string
    account_type?: string
    profile_picture_url?: string
    followers_count?: number
  }>(`/me?fields=user_id,username,name,account_type,profile_picture_url,followers_count`, token, { host: instagramHost })
  const id = String(profile.user_id ?? profile.id ?? first?.user_id ?? payload.user_id ?? '')
  if (!id) throw new HttpError(502, 'Instagram did not return the professional account id.')
  const accountType = profile.account_type ?? null
  const professional = accountType === 'BUSINESS' || accountType === 'MEDIA_CREATOR' || !accountType
  let reason: string | null = null
  if (!professional) reason = 'Only Instagram Business and Creator accounts can publish through the API.'
  else if (!hasScope(scopes, ['instagram_business_content_publish', 'instagram_content_publish'])) reason = 'Publishing permission was not granted. Add instagram_business_content_publish and connect again.'
  const expiresAt = longToken.expires_in ? new Date(Date.now() + longToken.expires_in * 1000) : null
  return [{
    platform: 'instagram',
    externalId: id,
    pageId: id,
    name: profile.name || profile.username || 'Instagram',
    handle: profile.username ? `@${profile.username}` : 'Instagram',
    pictureUrl: cleanPicture(profile.profile_picture_url),
    accountType,
    followers: profile.followers_count ?? 0,
    scopes,
    tasks: ['INSTAGRAM_LOGIN'],
    token,
    tokenExpiresAt: expiresAt,
    dataAccessExpiresAt: expiresAt,
    tokenStatus: 'valid',
    eligible: reason == null,
    eligibilityReason: reason,
  }]
}

function audioText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export type AudioPage = {
  songs: InstagramAudio[]
  nextCursor: string | null
  hasMore: boolean
}

export type AudioRequest = {
  audioType?: 'music' | 'original_sound'
  searchQuery?: string | null
  cursor?: string | null
  limit?: number
}

const audioFields = 'audio_id,title,display_artist,ig_username,duration_in_ms,download_url,cover_artwork_thumbnail_uri,cover_artwork_thumbnail_url,profile_picture_url'
// Meta answers with at most about 50 songs per page, and search never returns more than one page.
const audioPageLimit = 50

function audioSearch(query: string | null | undefined) {
  const search = (query ?? '').trim().slice(0, 80)
  return search.length >= 2 ? search : null
}

function audioFailure(error: unknown, cursor: string | null | undefined): never {
  if (!(error instanceof HttpError)) throw error
  if (error.status === 429) throw new HttpError(429, 'Instagram is limiting song lookups right now. Wait a minute, then try again.', error.code)
  if (error.status === 401) throw new HttpError(401, 'The Facebook Page connection for songs expired. Connect the Page again on Social Accounts.', error.code)
  if (cursor && error.status === 400) throw new HttpError(400, 'The song list changed on Instagram. Search again to start from the top.', error.code)
  throw error
}

// Meta pages ig_audio with paging.cursors.after only (no paging.next URL); a missing or repeated cursor means the list ended.
export async function fetchInstagramAudio(token: string, igUserId: string, request: AudioRequest = {}): Promise<AudioPage> {
  const audioType = request.audioType ?? 'music'
  const search = audioSearch(request.searchQuery)
  const params = new URLSearchParams({
    audio_type: audioType,
    user_id: igUserId,
    fields: audioFields,
    limit: String(Math.min(Math.max(Math.round(request.limit ?? 25), 1), audioPageLimit)),
  })
  if (search) params.set('search_query', search)
  if (request.cursor) params.set('after', request.cursor)
  let result: { audio?: Array<Record<string, unknown>>; paging?: { cursors?: { after?: string } } }
  try {
    result = await graph(`/ig_audio?${params.toString()}`, token)
  } catch (error) {
    audioFailure(error, request.cursor)
  }
  const batch = result.audio ?? []
  const songs = batch.map((item) => mapAudio(item, audioType)).filter((track): track is InstagramAudio => track !== null)
  const after = result.paging?.cursors?.after ?? null
  const nextCursor = after && after !== request.cursor && batch.length > 0 ? after : null
  return { songs: search ? rankAudio(songs, search) : songs, nextCursor, hasMore: nextCursor !== null }
}

// Loads several pages in a row, skipping songs Meta repeats across pages, and pauses between calls to stay under rate limits.
export async function fetchInstagramAudioPages(
  token: string,
  igUserId: string,
  request: AudioRequest & { maxPages?: number; delayMs?: number } = {},
): Promise<AudioPage> {
  const maxPages = Math.min(Math.max(request.maxPages ?? 3, 1), 5)
  const delayMs = request.delayMs ?? 250
  const seen = new Set<string>()
  const songs: InstagramAudio[] = []
  let cursor = request.cursor ?? null
  for (let page = 0; page < maxPages; page += 1) {
    if (page > 0) await sleep(delayMs)
    const result = await fetchInstagramAudio(token, igUserId, { ...request, cursor })
    const fresh = result.songs.filter((song) => !seen.has(song.id))
    for (const song of fresh) seen.add(song.id)
    songs.push(...fresh)
    cursor = fresh.length > 0 ? result.nextCursor : null
    if (!cursor) break
  }
  return { songs, nextCursor: cursor, hasMore: cursor !== null }
}

function mapAudio(item: Record<string, unknown>, audioType: 'music' | 'original_sound'): InstagramAudio | null {
  const id = String(item.audio_id ?? '')
  if (!id) return null
  return {
    id,
    title: audioText(item.title) ?? 'Untitled audio',
    artist: audioText(item.display_artist) ?? audioText(item.ig_username),
    durationMs: typeof item.duration_in_ms === 'number' ? item.duration_in_ms : null,
    artworkUrl: audioText(item.cover_artwork_thumbnail_uri) ?? audioText(item.cover_artwork_thumbnail_url) ?? audioText(item.profile_picture_url),
    previewUrl: audioText(item.download_url),
    type: audioType,
  }
}

function rankAudio(tracks: InstagramAudio[], query: string) {
  const needle = query.toLowerCase()
  const score = (track: InstagramAudio) => {
    const title = track.title.toLowerCase()
    const artist = (track.artist ?? '').toLowerCase()
    if (title === needle || artist === needle) return 0
    if (title.startsWith(needle) || artist.startsWith(needle)) return 1
    if (title.includes(needle) || artist.includes(needle)) return 2
    return 3
  }
  return [...tracks].sort((left, right) => score(left) - score(right))
}

export const metaProvider = {
  apiVersion: version(),
  configured: metaConfigured,
  instagramConfigured,
  authorizationUrl(state: string, purpose: 'instagram' | 'facebook', includeComments: boolean) {
    if (purpose === 'instagram') {
      if (!instagramConfigured) throw new HttpError(503, 'Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET from API setup with Instagram login.')
      const params = new URLSearchParams({
        client_id: env.INSTAGRAM_APP_ID,
        redirect_uri: env.META_REDIRECT_URI,
        state,
        response_type: 'code',
        scope: scopesFor('instagram', includeComments).join(','),
      })
      return `https://www.instagram.com/oauth/authorize?${params.toString()}`
    }
    if (!metaConfigured) throw new HttpError(503, 'Add META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI before connecting accounts.')
    const params = new URLSearchParams({
      client_id: env.META_APP_ID,
      redirect_uri: env.META_REDIRECT_URI,
      state,
      response_type: 'code',
      scope: scopesFor('facebook', includeComments).join(','),
      auth_type: 'rerequest',
    })
    return `https://www.facebook.com/${version()}/dialog/oauth?${params.toString()}`
  },
  async exchangeCode(code: string, purpose: 'instagram' | 'facebook') {
    if (purpose === 'instagram') return exchangeInstagram(code)
    if (!metaConfigured) throw new HttpError(503, 'Meta app credentials are not configured.')
    const short = await fetch(`https://graph.facebook.com/${version()}/oauth/access_token?${new URLSearchParams({
      client_id: env.META_APP_ID,
      redirect_uri: env.META_REDIRECT_URI,
      client_secret: env.META_APP_SECRET,
      code,
    })}`)
    if (!short.ok) throw new HttpError(502, await readError(short))
    const shortToken = await short.json() as { access_token?: string }
    if (!shortToken.access_token) throw new HttpError(502, 'Meta did not return an access token.')
    const long = await fetch(`https://graph.facebook.com/${version()}/oauth/access_token?${new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: env.META_APP_ID,
      client_secret: env.META_APP_SECRET,
      fb_exchange_token: shortToken.access_token,
    })}`)
    if (!long.ok) throw new HttpError(502, await readError(long))
    const longToken = await long.json() as { access_token?: string }
    const userToken = longToken.access_token ?? shortToken.access_token
    const pages = await listPages(userToken)
    if (pages.length === 0) {
      const debug = await debugToken(userToken).catch(() => null)
      throw new HttpError(400, missingPageMessage(debug))
    }
    const accounts: DiscoveredAccount[] = []

    for (const page of pages) {
      const debug: DebugData = await debugToken(page.access_token).catch(() => ({ is_valid: true, scopes: scopesFor(purpose, false) }))
      const scopes = debug.scopes ?? []
      const tasks = page.tasks ?? []
      const tokenStatus = statusFromDebug(debug)
      const shared = {
        pageId: page.id,
        scopes,
        tasks,
        token: page.access_token,
        tokenExpiresAt: expiryDate(debug.expires_at),
        dataAccessExpiresAt: expiryDate(debug.data_access_expires_at),
        tokenStatus,
      }
      let reason: string | null = null
      if (!canCreate(tasks)) reason = 'Your Page role cannot create content.'
      else if (tokenStatus === 'revoked' || tokenStatus === 'expired') reason = 'Reconnect this Page. Access expired or was revoked.'
      else if (!scopes.includes('pages_manage_posts')) reason = 'Page posting permission was not granted.'
      const ig = page.instagram_business_account
      if (ig?.id) {
        const musicScopes = scopes.some((scope) => scope === 'instagram_content_publish' || scope === 'instagram_basic')
        const igReason = tokenStatus === 'revoked' || tokenStatus === 'expired'
          ? 'Reconnect this Page. Access expired or was revoked.'
          : musicScopes
            ? null
            : 'Reconnect the Facebook Page and allow Instagram content publishing. That connection is what can attach a song.'
        accounts.push({
          platform: 'instagram',
          externalId: ig.id,
          pageId: ig.id,
          name: ig.name || ig.username || page.name,
          handle: ig.username ? `@${ig.username}` : page.name,
          pictureUrl: cleanPicture(ig.profile_picture_url),
          accountType: 'BUSINESS',
          followers: ig.followers_count ?? 0,
          scopes,
          tasks: ['FACEBOOK_LOGIN'],
          token: page.access_token,
          tokenExpiresAt: expiryDate(debug.expires_at),
          dataAccessExpiresAt: expiryDate(debug.data_access_expires_at),
          tokenStatus,
          eligible: igReason == null,
          eligibilityReason: igReason,
        })
      }
      accounts.push({
        ...shared,
        platform: 'facebook',
        externalId: page.id,
        name: page.name,
        handle: page.name,
        pictureUrl: cleanPicture(page.picture?.data?.url),
        accountType: 'PAGE',
        followers: page.fan_count ?? 0,
        eligible: reason == null,
        eligibilityReason: reason,
      })
    }
    return accounts
  },
  async inspect(token: string, instagramLogin = false) {
    if (instagramLogin) {
      const profile = await graph<{ account_type?: string }>('/me?fields=user_id,username,account_type', token, { host: instagramHost })
      return { tokenStatus: 'valid', scopes: [], tokenExpiresAt: null, dataAccessExpiresAt: null, accountType: profile.account_type ?? null }
    }
    const debug = await debugToken(token)
    return {
      tokenStatus: statusFromDebug(debug),
      scopes: debug.scopes ?? [],
      tokenExpiresAt: expiryDate(debug.expires_at),
      dataAccessExpiresAt: expiryDate(debug.data_access_expires_at),
    }
  },
  publish(input: PublishInput): Promise<{ externalId: string; warning?: string }> {
    return input.format.startsWith('instagram') ? publishInstagram(input) : publishFacebook(input)
  },
  searchAudio(token: string, igUserId: string, request: AudioRequest & { maxPages?: number }) {
    return fetchInstagramAudioPages(token, igUserId, request)
  },
}
