/**
 * Where the site tour is, kept in localStorage: which chapter, which step,
 * and whether it is still running. Tiny on purpose: every page with a
 * chapter imports it to decide whether to load the tour at all
 * (components/site-tour.tsx). The tour itself: lib/site-tour.ts.
 *
 * Storage is optional. Blocked or broken, every read says "no tour" and every
 * write is dropped, so the tour simply does not resume on the next page.
 */

export type ChapterId = 'demo' | 'rooms' | 'bounty' | 'campaigns' | 'account'

// One tour, in this order. It only ever starts on the demo.
export const CHAPTERS: { id: ChapterId; name: string; href: string }[] = [
  { id: 'demo', name: 'Demo', href: '/demo' },
  { id: 'rooms', name: 'Rooms', href: '/app' },
  { id: 'bounty', name: 'Bounties', href: '/bounty' },
  { id: 'campaigns', name: 'Campaigns', href: '/dashboard/campaigns/new' },
  { id: 'account', name: 'Account', href: '/account' },
]

export type TourState = { status: 'running' | 'done'; chapter: ChapterId; step: number; at: number }

// v2: the site-wide tour. A dismissal of the old demo-only walkthrough (or of
// v1) no longer counts, so everyone gets the new tour once, on its own
// (owner, 2026-11-10: it starts by itself; "Show me around" is the replay).
const STORE_KEY = 'holler.tour.v2'
// A tour left mid-chapter this long ago is not picked up again.
const STALE_MS = 2 * 60 * 60 * 1000

export function readTour(): TourState | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const s = JSON.parse(raw)
      if (!s || (s.status !== 'running' && s.status !== 'done')) return null
      if (!CHAPTERS.some((c) => c.id === s.chapter)) return null
      return { status: s.status, chapter: s.chapter, step: Math.max(0, Number(s.step) || 0), at: Number(s.at) || 0 }
    }
  } catch { /* storage optional */ }
  return null
}

export function writeTour(s: TourState) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)) } catch { /* storage optional */ }
}

/** Skipped or finished: the demo shows "Show me around" instead. */
export function tourDismissed(): boolean {
  return readTour()?.status === 'done'
}

/**
 * The step to pick this page's chapter up at, or null for no tour. Only a
 * tour that the demo started, and that handed off to this very chapter, runs
 * here: a direct visit, a skipped or finished tour, or a tour still on
 * another chapter shows nothing.
 */
export function resumeStep(chapter: ChapterId): number | null {
  if (chapter === 'demo') return null
  const s = readTour()
  if (!s || s.status !== 'running' || s.chapter !== chapter) return null
  if (Date.now() - s.at > STALE_MS) return null
  return s.step
}
