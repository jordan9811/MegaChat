/**
 * The site tour's chapters after the demo: Rooms, Bounties, Campaigns and
 * Account. Each step names one control on its page by a stable class or id;
 * a control that is not there (an empty board, no pools yet) skips its step.
 * The demo's own chapter lives in lib/demo-coach.ts; the runner in
 * lib/site-tour.ts; the hand-off state in lib/site-tour-state.ts.
 *
 * Copy rule: the tour explains, it never promises. Real money here is real
 * (bounties, campaigns); only the demo's is demo money.
 */

import { runTour, shown, type TourStep, type TourView } from './site-tour'
import { resumeStep, type ChapterId } from './site-tour-state'

type Spot = {
  id: string
  part?: string
  find: () => HTMLElement | null
  view: (el: HTMLElement) => Omit<TourView, 'target'>
  advancesOnClick?: boolean
  // How long to wait for the control to turn up before skipping the step.
  waitMs?: number
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null

// The first match that is actually on screen (a hidden one is no target).
function firstShown(...sels: string[]): HTMLElement | null {
  for (const sel of sels) {
    for (const el of document.querySelectorAll(sel)) if (shown(el)) return el
  }
  return null
}

function spot(s: Spot, first: boolean): TourStep {
  return {
    id: s.id,
    part: s.part,
    advancesOnClick: s.advancesOnClick,
    ready: () => shown(s.find()),
    resolve: (since) => {
      // A chapter opens once the page has settled, so its count is right
      // from the first bubble.
      if (first && (document.readyState !== 'complete' || since < 400)) return 'wait'
      const el = s.find()
      if (!shown(el)) return since < (s.waitMs ?? 5000) ? 'wait' : 'next'
      return { target: el, ...s.view(el) }
    },
  }
}

const ROOMS: Spot[] = [
  {
    id: 'key',
    find: () => firstShown('.mcr-key'),
    view: () => ({
      feature: 'callin',
      label: 'The key',
      text: 'Each room shows what it offers as coloured squares: pink for Holler, blue for Call in, green for Rewards, paid just for watching.',
    }),
  },
  {
    id: 'tile',
    find: () => firstShown('.mcr-grid .mcr-card', '.mcr-feat-body', '.mcr-feat'),
    view: () => ({
      feature: 'callin',
      label: 'A room',
      text: 'Every tile is a room on a live stream. Open one to watch, send a Holler or call in.',
    }),
  },
  // Recently aired and Claimed pledges are two sections (Claimed pledges
  // after the rooms) but one idea, so they count as one number.
  {
    id: 'recent',
    part: 'replays',
    find: () => firstShown('section.mcr-recent-rail > .mcr-sec-h'),
    view: () => ({
      feature: 'holler',
      label: 'Recently aired',
      text: 'Broadcasts that just ended, with the Hollers that played on them. Open one to watch it back.',
    }),
  },
  {
    id: 'claimed',
    part: 'replays',
    find: () => firstShown('section.mcr-claimed > .mcr-sec-h', 'section.mcr-claimed'),
    view: () => ({
      feature: 'bounty',
      label: 'Claimed pledges',
      text: 'Broadcasts where a streamer went live and played the clips fans pledged to them.',
    }),
  },
  {
    id: 'create',
    find: () => firstShown('.mcr-create', '.mcr-open', '.mcr-more-create'),
    view: () => ({
      feature: 'callin',
      label: 'Streaming?',
      text: 'Create room opens one for your own stream: you pick what viewers can do and what it costs.',
    }),
  },
]

const BOUNTY: Spot[] = [
  {
    id: 'idea',
    find: () => firstShown('.mcb-hero h1'),
    view: () => ({
      feature: 'bounty',
      label: 'Pledge',
      text: 'Pledge your favorite streamer: back them before they even have a room. They claim it by going live and playing your Holler.',
    }),
  },
  {
    id: 'add',
    find: () => firstShown('.mcb-create-bounty'),
    view: () => ({
      feature: 'bounty',
      label: 'Add a streamer',
      text: 'Paste their channel link or handle, or search the streamers who already have a pool.',
    }),
  },
  {
    id: 'pool',
    find: () => firstShown('.lb-row .lb-bar'),
    view: () => ({
      feature: 'bounty',
      label: 'A pool',
      text: 'One streamer\'s pool. The solid part is locked to them alone; the hatched part is contested, shared with other names, and the first verified broadcast takes it.',
    }),
  },
]

const CAMPAIGNS: Spot[] = [
  {
    id: 'what',
    find: () => firstShown('.mcp-title h1'),
    view: () => ({
      feature: 'rewards',
      label: 'Campaigns',
      text: 'A campaign pays viewers for engaging: everyone who meets your rules gets a reward for a Holler or a Call in on your stream.',
    }),
  },
  {
    id: 'budget',
    find: () => {
      const input = document.getElementById('mcp-f-budget')
      const field = input?.closest('.mcp-field') as HTMLElement | null
      return shown(field) ? field : null
    },
    view: () => ({
      feature: 'bounty',
      label: 'Budget',
      text: 'Reward × places = budget. Set what each person gets and the budget; the budget decides how many places there are.',
    }),
  },
  {
    id: 'save',
    find: () => firstShown('.mcp-submit'),
    view: (el) => {
      const guest = [...el.querySelectorAll('button')].some((b) => /sign in to save/i.test(b.textContent || ''))
      return {
        feature: 'callin',
        label: guest ? 'No sign-in yet' : 'Save',
        text: guest
          ? 'All of this works signed out: draft it, check the rules, read the preview. Sign-in only comes in when you save.'
          : 'Save keeps it private. Funding and opening it to claims come after, from the campaign page.',
      }
    },
  },
]

const navButton = (section: string) => () => firstShown(`.mcc-section-nav button[data-section="${section}"]`)

const ACCOUNT: Spot[] = [
  {
    id: 'signed-out',
    find: () => firstShown('.mcc-signed-out .btn'),
    view: (el) => ({
      feature: 'callin',
      label: 'Signed out',
      text: 'Your account keeps what you earned in each room, your guest list and your sign-ins. Sign in to see it.',
      action: { label: 'Sign in', run: () => el.click() },
    }),
    waitMs: 1500,
  },
  {
    id: 'rewards',
    find: navButton('rewards'),
    advancesOnClick: true,
    view: () => ({
      feature: 'rewards',
      label: 'Rewards',
      text: 'Rewards: what you earned watching, room by room, and what is still yours to spend.',
    }),
  },
  {
    id: 'guests',
    find: navButton('guests'),
    advancesOnClick: true,
    view: () => ({
      feature: 'callin',
      label: 'Guest list',
      text: 'Guest list: the regulars who take a camera seat in any of your rooms free.',
    }),
  },
  {
    id: 'connections',
    find: navButton('connections'),
    view: () => ({
      feature: 'callin',
      label: 'Connections',
      text: 'Connections: every sign-in that opens this same account. That\'s the tour.',
    }),
  },
]

const CHAPTER_SPOTS: Record<Exclude<ChapterId, 'demo'>, Spot[]> = {
  rooms: ROOMS,
  bounty: BOUNTY,
  campaigns: CAMPAIGNS,
  account: ACCOUNT,
}

/** This page's chapter, if the tour handed off to it. Returns cleanup. */
export function startChapter(chapter: Exclude<ChapterId, 'demo'>): () => void {
  const at = resumeStep(chapter)
  if (at == null) return () => {}
  const spots = CHAPTER_SPOTS[chapter]
  const steps = spots.map((s, i) => spot(s, i === Math.min(at, spots.length - 1)))
  return runTour({ chapter, steps, startAt: at, scroll: 'fit' })
}
