import type { DiscoveredAccount, InstagramAudio, PublishInput } from './graph.js'

export type SocialProvider = {
  apiVersion: string
  configured: boolean
  authorizationUrl: (state: string, purpose: 'instagram' | 'facebook', includeComments: boolean) => string
  exchangeCode: (code: string, purpose: 'instagram' | 'facebook') => Promise<DiscoveredAccount[]>
  inspect: (token: string, instagramLogin?: boolean) => Promise<{
    tokenStatus: string
    scopes: string[]
    tokenExpiresAt: Date | null
    dataAccessExpiresAt: Date | null
  }>
  publish: (input: PublishInput) => Promise<{ externalId: string; warning?: string }>
  searchAudio: (token: string, igUserId: string, audioType: 'music' | 'original_sound', query: string) => Promise<InstagramAudio[]>
}

export { metaProvider as socialProvider } from './graph.js'
