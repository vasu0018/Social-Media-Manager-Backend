import { env, instagramConfigured, metaConfigured } from '../env.js'
import { HttpError, type ContentFormat } from '../domain.js'
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

export function classifyMetaError(status: number, message: string) {
  if (message.includes('revoked') || message.includes('session has expired')) return new HttpError(401, message)
  if (status === 429 || /request limit|too many calls|temporarily unavailable/i.test(message)) return new HttpError(429, message)
  if (status >= 400 && status < 500) return new HttpError(status, message)
  return new HttpError(503, message)
}

function scrub(value: string) {
  return redact(value).slice(0, 500)
}

async function readError(response: Response) {
  const body = await response.text()
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: number } }
    const message = parsed.error?.message ?? 'Meta rejected the request.'
    if (parsed.error?.code === 190) return 'The connection was revoked. Reconnect the account.'
    return scrub(message)
  } catch {
    return 'Meta rejected the request.'
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
  if (!response.ok) throw classifyMetaError(response.status, await readError(response))
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
  return ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management']
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

async function listPages(userToken: string) {
  const fields = 'id,name,access_token,tasks,fan_count,picture{url},instagram_business_account{id,username,name,profile_picture_url,followers_count}'
  let next: string | null = `https://graph.facebook.com/${version()}/me/accounts?fields=${fields}&limit=50`
  const pages: PageNode[] = []
  while (next && pages.length < 100) {
    const response = await fetch(next, { headers: { Authorization: `Bearer ${userToken}` } })
    if (!response.ok) throw classifyMetaError(response.status, await readError(response))
    const data = await response.json() as { data?: PageNode[]; paging?: { next?: string } }
    pages.push(...(data.data ?? []))
    next = data.paging?.next ?? null
  }
  return pages
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForContainer(id: string, token: string, host?: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const status = await graph<{ status_code?: string; status?: string }>(`/${id}?fields=status_code,status`, token, { host })
    if (status.status_code === 'FINISHED') return
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new HttpError(400, status.status || 'Instagram could not process this media.')
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
  if (!response.ok) throw classifyMetaError(response.status, await readError(response))
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

  let containerId = ''
  if (input.kind === 'image') {
    if (!input.publicUrl) {
      throw new HttpError(400, 'Instagram image publishing needs a public HTTPS media URL. Set PUBLIC_BASE_URL to an address Meta can reach, or configure private S3 storage.')
    }
    fields.image_url = input.publicUrl
    const container = await graph<{ id: string }>(`/${input.igId}/media`, input.token, { method: 'POST', body: form(fields), host })
    containerId = container.id
  } else {
    fields.upload_type = 'resumable'
    const container = await graph<{ id: string }>(`/${input.igId}/media`, input.token, { method: 'POST', body: form(fields), host })
    containerId = container.id
    await uploadInstagramVideo(container.id, input.token, input.bytes)
  }

  await waitForContainer(containerId, input.token, host)
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
      return { externalId: published.id, warning: `Published, but the first comment was not added. ${message}` }
    }
  }
  return { externalId: published.id }
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
  if (!response.ok) throw classifyMetaError(response.status, await readError(response))
}

async function publishFacebook(input: PublishInput) {
  const text = captionFor(input.format, input.caption, input.hashtags)
  const file = new File([new Uint8Array(input.bytes)], input.kind === 'image' ? 'upload.jpg' : 'upload.mp4', { type: input.mime })

  if (input.format === 'facebook_image') {
    const body = new FormData()
    if (text) body.set('caption', text)
    body.set('source', file)
    const result = await graph<{ id: string }>(`/${input.pageId}/photos`, input.token, { method: 'POST', body })
    return { externalId: result.id }
  }

  if (input.format === 'facebook_video') {
    const body = new FormData()
    if (text) body.set('description', text)
    body.set('source', file)
    const result = await graph<{ id: string }>(`/${input.pageId}/videos`, input.token, {
      method: 'POST',
      body,
      host: 'https://graph-video.facebook.com',
    })
    return { externalId: result.id }
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
    return { externalId: start.video_id }
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
      await graph('/me?fields=user_id,username', token, { host: instagramHost })
      return { tokenStatus: 'valid', scopes: [], tokenExpiresAt: null, dataAccessExpiresAt: null }
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
}
