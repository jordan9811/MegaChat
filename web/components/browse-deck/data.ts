// Browse-deck data adapters — the ONLY readers of ./seeds/*.json.
// Rooms are real (same /api/rooms/public the classic grid polls); everything
// else is seeded demo data until a backend exists for it. If real lobby chat
// ever ships, make its wire format match LobbyMessage here and swap the
// adapter — no module should ever import a seed file directly.

import { listPublicRooms, type PublicRoomCard } from '@/lib/api'
import featuredSeed from './seeds/featured.json'
import campaignSeed from './seeds/campaign.json'
import chatSeed from './seeds/chat.json'
import bannerSeed from './seeds/banner.json'

/** The five neon tokens defined in globals.css. */
export type DeckAccent = 'magenta' | 'cyan' | 'lime' | 'violet' | 'amber'

export type FeaturedEntry = {
  id: string
  /** Seeded demo entry — renders the "demo" corner tag. */
  demo: boolean
  /** Real room id (config override) — points the CTA at the live join page. */
  roomId: string | null
  name: string
  handle: string
  title: string
  category: string
  tags: string[]
  viewers: number
  blurb: string
  accent: DeckAccent
}

export type CampaignPlatform = 'twitch' | 'youtube' | 'x'
export type CampaignStatus = 'recorded' | 'sent' | 'claimable' | 'claimed' | 'live'

export type CampaignTarget = {
  id: string
  name: string
  platform: CampaignPlatform
  followers: string
  status: CampaignStatus
  /** Placeholder figure — testnet framing everywhere it renders. */
  bounty: string
}

export type LobbyMessage = {
  id: string
  user: string
  kind: 'chat' | 'join' | 'bot'
  badges: string[]
  text: string
  /** Username this message replies to (rendered as a thread line). */
  replyTo?: string
}

export type BannerCampaign = {
  kicker: string
  headline: string
  sub: string
  ctaLabel: string
  ctaHref: string
}

export function getFeaturedRooms(): FeaturedEntry[] {
  return (featuredSeed.entries as FeaturedEntry[]).map((e) => ({ ...e }))
}

export function getCampaignTargets(): CampaignTarget[] {
  return (campaignSeed.targets as CampaignTarget[]).map((t) => ({ ...t }))
}

export function getLobbyMessages(): { pinned: LobbyMessage; pool: LobbyMessage[] } {
  return {
    pinned: { ...(chatSeed.pinned as LobbyMessage) },
    pool: (chatSeed.pool as LobbyMessage[]).map((m) => ({ ...m })),
  }
}

/** Real rooms — the same endpoint/shape the shipped grid uses. */
export function getRooms(): Promise<{ rooms: PublicRoomCard[] }> {
  return listPublicRooms()
}

export function getBannerCampaign(): BannerCampaign {
  return { ...(bannerSeed as BannerCampaign) }
}

/** Context handed to every mounted module by the shell. */
export type DeckCtx = { initialRooms: PublicRoomCard[] }
export type DeckModuleProps = { ctx: DeckCtx }

export type { PublicRoomCard }
