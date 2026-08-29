// ═══════════════════════════════════════════════════════════════════════════
// BROWSE DECK CONFIG — the one file to edit.
//
// Every module is self-contained and mounts into a named slot. Swapping what
// renders where is a one-line change here — no component edits needed.
//
//   slots.leftRail:   'campaignDashboard' | 'recommendedRooms' | null
//   slots.rightPanel: 'lobbyChat' | 'activityFeed' | null
//   slots.featured:   'legacyStreamerCarousel' | null
//   slots.promoBanner:'promoBanner' | null
//   slots.belowFold:  ordered list, e.g. ['roomGrid', 'categories']
//
// The deck itself mounts in web/app/page.tsx unless BROWSE_DECK=0 is set in
// the environment — that env flag (or reverting the one <main> line there) is
// the whole revert story back to the classic browse.
// ═══════════════════════════════════════════════════════════════════════════

export type DeckModuleId =
  | 'promoBanner'
  | 'legacyStreamerCarousel'
  | 'campaignDashboard'
  | 'recommendedRooms'
  | 'lobbyChat'
  | 'activityFeed'
  | 'roomGrid'
  | 'categories'

export const deckConfig = {
  /** Label seeded/demo surfaces so fake activity is never mistaken for real. */
  showDemoTag: true,

  slots: {
    promoBanner: 'promoBanner' as DeckModuleId | null,
    leftRail: 'campaignDashboard' as DeckModuleId | null,
    featured: 'legacyStreamerCarousel' as DeckModuleId | null,
    rightPanel: 'lobbyChat' as DeckModuleId | null,
    belowFold: ['roomGrid', 'categories'] as DeckModuleId[],
  },

  featured: {
    heading: 'Featured',
    autoAdvanceMs: 8000,
    /** Simulated player load before an entry's thumb appears. */
    loadMs: 650,
    /** Point a seeded entry's CTA at a REAL room: { slugmoney: 'demo' }. */
    roomOverrides: {} as Record<string, string>,
  },

  campaign: {
    title: 'Creator bounty',
    /** Placeholder pool — testnet framing is rendered next to it. */
    pool: '$25,000',
    poolNote: 'testnet',
    /** Total creators in the campaign (drives "x of N claimed"). */
    targetCount: 20,
    /** Countdown target (absolute so it never drifts). */
    endsAt: '2026-08-15T00:00:00Z',
  },

  chat: {
    title: 'Lobby chat',
    /** Random delay range between seeded messages, ms. */
    cadenceMs: [1400, 3400] as [number, number],
    /** Max messages kept in the DOM. */
    keep: 60,
  },

  grid: {
    heading: 'Top live rooms',
    viewAllHref: '/app',
  },
}

export type DeckConfig = typeof deckConfig
