import { HttpError } from '../domain.js'
import { env } from '../env.js'

type CaptionKind = 'reel' | 'story' | 'image' | 'video'

const instructions: Record<CaptionKind, string> = {
  reel: 'This file is a Reel, not a feed post. Write a short Reel caption: the first line is a hook, then at most two short lines. It should sound like a person talking, not an advertisement and not a long feed essay. Suggest 5 to 8 hashtags that match what is actually visible. Do not use generic Reel tags such as #reels, #reelsinstagram, #explorepage, or #viral unless the picture is literally about that.',
  image: 'This file is a feed photo post, not a Reel and not a Story. Write a feed caption of 2 to 5 sentences that someone can read while stopped on the post. Describe what is in the photo and why it matters. Suggest 6 to 12 hashtags that belong on a feed post. Do not use Reel tags such as #reels or #explorepage.',
  video: 'This file is a feed video, not a Reel. Write a feed caption of 2 to 4 complete sentences for the main feed, not a Reel hook. Suggest 5 to 10 hashtags for a feed video. Do not use Reel tags such as #reels or #reelsinstagram.',
  story: 'This file is a Story. Write one short line that could sit on the story. Suggest at most 3 hashtags, or none if they would not fit a Story.',
}

function cleanHashtag(value: string) {
  const word = value.trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')
  return word ? `#${word}` : ''
}

export async function suggestCaption(kind: CaptionKind, images: string[]) {
  if (!env.OPENAI_API_KEY) throw new HttpError(503, 'Add OPENAI_API_KEY on the server before using AI captions.')
  const frames = images.map((image) => {
    if (!image.startsWith('data:image/jpeg;base64,') && !image.startsWith('data:image/png;base64,')) {
      throw new HttpError(400, 'The preview sent to AI must be a JPEG or PNG frame.')
    }
    return image
  })
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You write social captions from the pictures you are shown. Reply with JSON only: {"caption":"","hashtags":["#Tag"]}. Put no hashtags inside caption. If readable text is visible, write the caption in that language. If there is no readable text, write in English.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: instructions[kind] },
            ...frames.map((url) => ({ type: 'image_url', image_url: { url, detail: 'low' } })),
          ],
        },
      ],
    }),
  })
  const payload = await response.json() as {
    error?: { message?: string }
    choices?: Array<{ message?: { content?: string } }>
  }
  if (!response.ok) {
    const message = payload.error?.message || 'OpenAI could not write a caption.'
    throw new HttpError(response.status === 401 ? 503 : 502, message.includes('API key') ? 'The OpenAI key was rejected. Check OPENAI_API_KEY.' : 'OpenAI could not write a caption right now.')
  }
  const raw = payload.choices?.[0]?.message?.content
  if (!raw) throw new HttpError(502, 'OpenAI did not return a caption.')
  let parsed: { caption?: unknown; hashtags?: unknown }
  try {
    parsed = JSON.parse(raw) as { caption?: unknown; hashtags?: unknown }
  } catch {
    throw new HttpError(502, 'OpenAI returned a caption that could not be read.')
  }
  const caption = String(parsed.caption ?? '')
    .replace(/#[\p{L}\p{N}_]+/gu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2200)
  if (!caption) throw new HttpError(502, 'OpenAI did not return a caption.')
  const hashtags = [...new Set(
    (Array.isArray(parsed.hashtags) ? parsed.hashtags : [])
      .map((tag) => cleanHashtag(String(tag)))
      .filter(Boolean),
  )].slice(0, kind === 'reel' ? 8 : kind === 'story' ? 3 : 12)
  return { caption, hashtags }
}
