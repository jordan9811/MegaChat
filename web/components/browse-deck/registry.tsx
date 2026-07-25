'use client'

// Module registry — maps every DeckModuleId to its component. The shell reads
// browse-deck.config.ts slots through this table, so remapping a slot is a
// one-line config change and adding a module is one import + one row here.

import type { ComponentType } from 'react'
import type { DeckModuleId } from './browse-deck.config'
import type { DeckModuleProps } from './data'
import { PromoBanner } from './modules/promo-banner'
import { FeaturedCarousel } from './modules/featured-carousel'
import { CampaignDashboard } from './modules/campaign-dashboard'
import { RecommendedRooms } from './modules/recommended-rooms'
import { LobbyChat } from './modules/lobby-chat'
import { ActivityFeed } from './modules/activity-feed'
import { RoomGrid } from './modules/room-grid'
import { CategoriesStub } from './modules/categories-stub'

export const deckRegistry: Record<DeckModuleId, ComponentType<DeckModuleProps>> = {
  promoBanner: PromoBanner,
  legacyStreamerCarousel: FeaturedCarousel,
  campaignDashboard: CampaignDashboard,
  recommendedRooms: RecommendedRooms,
  lobbyChat: LobbyChat,
  activityFeed: ActivityFeed,
  roomGrid: RoomGrid,
  categories: CategoriesStub,
}

/** Short labels for the mobile drawer/toggle buttons. */
export const MODULE_LABEL: Record<DeckModuleId, string> = {
  promoBanner: 'Campaign',
  legacyStreamerCarousel: 'Featured',
  campaignDashboard: 'Bounty board',
  recommendedRooms: 'Rooms',
  lobbyChat: 'Lobby chat',
  activityFeed: 'Activity',
  roomGrid: 'Rooms',
  categories: 'Categories',
}
