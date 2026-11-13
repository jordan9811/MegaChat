'use client'

// Create and edit, one form in the create-room idiom: a stack of cards on
// the left, a live preview on the right. What → Reward → Budget and limits →
// Action → Who qualifies → the X notice → Save as draft / Save and fund.
// Opening happens on the detail page once the budget is in (the engine's
// ladder: draft → funded → live).
//
// Signed out, the whole form still renders (no login wall, the same as
// /dashboard): the two save buttons become one "Sign in to save", and the
// draft is kept in this tab's sessionStorage until it is saved, so it
// survives a sign-in that leaves the page.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { InfoTip } from '@/components/info-tip'
import { listMyRooms, type MyRoomCard } from '@/lib/api'
import {
  createCampaign,
  fundCampaign,
  getCampaignConfig,
  getChainInfo,
  listMyReferenceSets,
  lookupToken,
  updateCampaign,
  followerCheckState,
  FUNDING_OFF_COPY,
  REQUIRE_OPTIONS,
  type ActionKind,
  type ActionRequire,
  type Campaign,
  type CampaignConfig,
  type CampaignInput,
  type PayoutMode,
  type ReferenceSet,
  type RuleKey,
  type Rules,
  type TokenInfo,
  type VerifiedType,
} from '@/lib/campaigns-api'
import { useAccount } from '@/lib/use-account'
import { FeatureTag } from '@/components/feature-tag'
import { ApproveStep, connectedWallet, type ApprovalAsk, type FundProof } from './approve-step'
import { ReferenceSetPicker } from './reference-set-builder'
import { amountProblem, amountToSend, countProblems, parseCap, parseCostCaps, placesPaid } from './form-rules'
import { MAX_PRIZE_PLACES, ordinal, percentOf, placesProblems, sumAmounts } from './prize-places'
import {
  ACTION_LABEL,
  COMPLIANCE_NOTICE,
  RULE_GROUPS,
  RULE_MENU,
  VERIFIED_TYPE_LABEL,
  VERIFIED_TYPE_SHORT,
  type RuleMeta,
  requireLabel,
  rewardLabel,
  ruleCount,
  rulesSentence,
  shareText,
} from './rules'

/** The server's cap on how far out a deadline may sit. */
const MAX_DEADLINE_DAYS = 90
const DAY_MS = 86_400_000

/** A new campaign's draft while it is not saved yet (signed out, or on its
 *  way through sign-in). This tab only; cleared once the draft is saved. */
const PENDING_KEY = 'holler:campaign-draft'

/** The example copy follows the action, so a Holler campaign is never
 *  modelled as a Call in (ca-placeholder-callin). */
const PLACEHOLDER: Record<ActionKind, { title: string; blurb: string }> = {
  holler: { title: 'Holler your worst take at me', blurb: 'Record 10 seconds. If it plays on stream, you get paid.' },
  callin: { title: 'Call in and tell me your worst take', blurb: 'Five minutes on camera, I pay you for showing up.' },
}

/** One thing standing between the creator and Save: the sentence, a short
 *  name for the bar, and the field it is about (an element id). */
type Problem = { text: string; label: string; field: string; missing?: boolean }

const FIELD = {
  title: 'mcp-f-title',
  reward: 'mcp-f-reward',
  token: 'mcp-f-token',
  budget: 'mcp-f-budget',
  cap: 'mcp-f-cap',
  deadline: 'mcp-f-deadline',
  room: 'mcp-f-room',
  seconds: 'mcp-f-seconds',
  xcap: 'mcp-f-xcap',
  places: 'mcp-f-places',
}

/** Scrolls a field into the middle of the screen and puts the cursor in it. */
function goToField(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.focus({ preventScroll: true })
}

type Draft = {
  title: string
  blurb: string
  /** each: every qualifying action is paid the reward. prize: the reward is
   *  one prize (and the budget); the creator picks the winner. */
  payout: PayoutMode
  /** A prize: one winner, or places by amount or by percent. */
  placesMode: 'one' | 'amount' | 'percent'
  /** The places as typed, 1st first (amounts, or percents). */
  places: string[]
  rewardAmount: string
  tokenMode: 'usdc' | 'token'
  tokenAddress: string
  budgetAmount: string
  /** The optional cap, as typed: blank = the budget decides how many places. */
  maxClaims: string
  /** datetime-local string. */
  deadline: string
  actionKind: ActionKind
  roomHandle: string
  require: ActionRequire
  minSeconds: string
  rules: Rules
  /** The "followed by" rule's two X-API cost caps, as typed. Text, not
   *  numbers: they are parsed only in toInput (form-rules.ts parseCostCaps),
   *  so a decimal point survives the keystroke that types it. */
  capText: string
  capTotalText: string
}

/** The "followed by" rule as the menu switches it on. */
const FOLLOWED_BY_ON = RULE_MENU.find((m) => m.key === 'followedByFromSet')!.on as NonNullable<Rules['followedByFromSet']>

function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function blankDraft(): Draft {
  const d = new Date()
  d.setDate(d.getDate() + 14)
  d.setSeconds(0, 0)
  return {
    title: '',
    blurb: '',
    payout: 'each',
    placesMode: 'one',
    places: [],
    rewardAmount: '5',
    tokenMode: 'usdc',
    tokenAddress: '',
    budgetAmount: '100',
    maxClaims: '',
    deadline: toLocalInput(d),
    actionKind: 'holler',
    roomHandle: '',
    require: 'aired',
    minSeconds: '30',
    rules: { minFollowers: 1000 },
    capText: String(FOLLOWED_BY_ON.perClaimCostCapUsd),
    capTotalText: '',
  }
}

function fromCampaign(c: Campaign): Draft {
  const fb = c.rules?.followedByFromSet
  return {
    title: c.title,
    blurb: c.blurb,
    payout: c.payout === 'prize' ? 'prize' : 'each',
    placesMode: c.prizePlaces?.places?.length ? c.prizePlaces.by : 'one',
    places: c.prizePlaces?.places?.length ? c.prizePlaces.places.map((p) => (c.prizePlaces!.by === 'amount' ? p.amount || '' : String(p.percent ?? ''))) : [],
    rewardAmount: c.reward.amount,
    tokenMode: c.reward.type === 'token' ? 'token' : 'usdc',
    tokenAddress: c.reward.address || c.token?.address || '',
    budgetAmount: c.budget.amount,
    // The cap as the creator set it; a server that predates claimCap sends
    // only the places, which read back as a cap.
    maxClaims: c.claimCap === undefined ? String(c.maxClaims) : c.claimCap == null ? '' : String(c.claimCap),
    deadline: c.deadline ? toLocalInput(new Date(c.deadline)) : blankDraft().deadline,
    actionKind: c.action.kind,
    roomHandle: c.action.roomHandle,
    require: c.action.require,
    minSeconds: String(c.action.minSeconds ?? 30),
    rules: c.rules || {},
    capText: String(fb?.perClaimCostCapUsd ?? FOLLOWED_BY_ON.perClaimCostCapUsd),
    capTotalText: fb?.maxTotalUsd != null ? String(fb.maxTotalUsd) : '',
  }
}

const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a)
const num = (s: string) => { const n = Number(s); return Number.isFinite(n) ? n : NaN }

export function CampaignForm({ campaign }: { campaign?: Campaign }) {
  const router = useRouter()
  const { identity, loaded, signedIn, openSignIn, authError, wallet } = useAccount()
  const editing = !!campaign
  // Signed out: the form is open to read and fill; saving asks for sign-in.
  const guest = loaded && !signedIn
  // Re-read what belongs to the account once someone signs in.
  const who = identity?.handle || (signedIn ? 'wallet' : '')
  const [draft, setDraft] = useState<Draft>(() => (campaign ? fromCampaign(campaign) : blankDraft()))
  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p })), [])

  // A new campaign's draft survives sign-in (which may leave the page):
  // restored once on mount, kept while it is unsaved, cleared on save.
  const restored = useRef(false)
  useEffect(() => {
    if (campaign || restored.current) return
    restored.current = true
    try {
      const raw = window.sessionStorage.getItem(PENDING_KEY)
      if (raw) setDraft((d) => ({ ...d, ...(JSON.parse(raw) as Partial<Draft>) }))
    } catch { /* storage blocked: the form starts blank */ }
  }, [campaign])
  const [keepPending, setKeepPending] = useState(false)
  useEffect(() => {
    if (campaign || !(guest || keepPending)) return
    try { window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(draft)) } catch { /* storage blocked */ }
  }, [campaign, guest, keepPending, draft])
  const clearPending = useCallback(() => {
    try { window.sessionStorage.removeItem(PENDING_KEY) } catch { /* storage blocked */ }
  }, [])
  const signInToSave = useCallback(() => {
    setKeepPending(true)
    try { window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(draft)) } catch { /* storage blocked */ }
    openSignIn()
  }, [draft, openSignIn])

  // Rooms the action can point at. A room without a claimed link has no
  // handle to name, so it is listed but cannot be chosen.
  const [rooms, setRooms] = useState<MyRoomCard[] | null>(null)
  useEffect(() => {
    if (!loaded) return
    if (!who) { setRooms([]); return }
    listMyRooms().then((d) => setRooms(d.rooms)).catch(() => setRooms([]))
  }, [loaded, who])
  // The default room is the streamer's own (ca-room-default): the room whose
  // handle is the account's handle, else the room live now, else an active
  // one, else the newest. It used to be whichever room the API listed first,
  // the newest, so it moved every time a room was created.
  useEffect(() => {
    if (draft.roomHandle || !rooms || !loaded) return
    const mine = identity?.handle || null
    const named = rooms.filter((r) => r.handle)
    const pick = named.find((r) => r.handle === mine) || named.find((r) => r.live > 0) || named.find((r) => r.active) || named[0]
    const h = pick?.handle || mine || ''
    if (h) patch({ roomHandle: h })
  }, [rooms, identity, loaded, draft.roomHandle, patch])

  // Frozen lists, for the two rules that point at one.
  const [sets, setSets] = useState<ReferenceSet[]>([])
  const [setsError, setSetsError] = useState<string | null>(null)
  useEffect(() => {
    if (!who) return
    listMyReferenceSets().then((d) => { setSets(d.sets); setSetsError(null) }).catch((e) => setSetsError(e instanceof Error ? e.message : 'unavailable'))
  }, [who])

  // What this server has switched on. Unknown until read. Funding off keeps
  // Save and loses Fund (never a Fund that errors). No X app token: the
  // "followed by" rule can only be checked through list members who signed
  // in with X, so the rule gets the server's warning and Save and fund waits
  // while it is on. Payouts off: the reward copy says "queued", not "paid".
  const [config, setConfig] = useState<CampaignConfig | null>(null)
  useEffect(() => {
    if (!who) return
    getCampaignConfig().then(setConfig).catch(() => setConfig(null))
  }, [who])
  const fundingEnabled = config ? config.fundingEnabled : null

  // Custom token: resolve symbol and decimals once the address is a real one.
  const [token, setToken] = useState<TokenInfo | null>(campaign?.reward.type === 'token' && campaign.token?.address
    ? { address: campaign.token.address, symbol: campaign.token.symbol, decimals: campaign.token.decimals }
    : null)
  const [tokenState, setTokenState] = useState<'idle' | 'busy' | 'error'>('idle')
  const [tokenError, setTokenError] = useState<string | null>(null)
  const lookupSeq = useRef(0)
  useEffect(() => {
    if (draft.tokenMode !== 'token') { setTokenState('idle'); setTokenError(null); return }
    const addr = draft.tokenAddress.trim()
    if (token && token.address.toLowerCase() === addr.toLowerCase()) return
    setToken(null)
    if (!isAddress(addr)) { setTokenState('idle'); setTokenError(null); return }
    const seq = ++lookupSeq.current
    setTokenState('busy')
    setTokenError(null)
    const t = setTimeout(() => {
      lookupToken(addr)
        .then((info) => { if (seq === lookupSeq.current) { setToken(info); setTokenState('idle') } })
        .catch((e) => { if (seq === lookupSeq.current) { setTokenState('error'); setTokenError(e instanceof Error ? e.message : 'Could not read that token') } })
    }, 350)
    return () => clearTimeout(t)
  }, [draft.tokenMode, draft.tokenAddress, token])

  const symbol = draft.tokenMode === 'usdc' ? 'USDC' : token?.symbol || 'TOKEN'
  const prize = draft.payout === 'prize'
  const reward = num(draft.rewardAmount)
  // The optional cap: null when blank, NaN when it is not a whole number.
  const maxClaims = parseCap(draft.maxClaims)
  const budget = num(draft.budgetAmount)
  const minSeconds = Math.floor(num(draft.minSeconds))
  const fb = draft.rules.followedByFromSet
  // The server's own words when a loaded campaign carries them (xCheck,
  // warnings); the config's, or this client's, otherwise.
  const follower = followerCheckState({ rules: draft.rules, xAppToken: campaign?.xAppToken, xCheck: campaign?.xCheck, warnings: campaign?.warnings }, config)
  const followerChecksOff = follower.blocked
  const followerWarning = follower.warning || ''
  // Whether owed rewards are sent here or queued (ca-payout-hedge): one
  // state chip beside the reward, nothing while the server has not said.
  const payouts = config?.payoutsEnabled ?? null

  // The token's own decimals bound what can be typed (USDC has 6). Unknown
  // until a custom token resolves; the token problem covers that case.
  const decimals = draft.tokenMode === 'usdc' ? 6 : token?.decimals ?? null
  const caps = useMemo(() => parseCostCaps(draft.capText, draft.capTotalText), [draft.capText, draft.capTotalText])
  // PLACES FOLLOW THE MONEY (ca-budget-places): the budget pays
  // floor(budget ÷ reward) people, counted as the server counts them, and
  // max claims is only an optional lower cap. The public page offers the
  // smaller of the two.
  const paysPeople = placesPaid(draft.rewardAmount, draft.budgetAmount, decimals)
  const capSet = maxClaims != null && Number.isFinite(maxClaims) && maxClaims >= 1 ? maxClaims : null

  const problems = useMemo(() => {
    const out: Problem[] = []
    const add = (text: string, label: string, field: string, missing = false) => { out.push({ text, label, field, missing }) }
    if (!draft.title.trim()) add('Give the campaign a title.', 'Title', FIELD.title, true)
    const rewardBad = decimals != null ? amountProblem(draft.rewardAmount, decimals, symbol, 'reward') : null
    if (rewardBad) add(rewardBad, 'Reward', FIELD.reward)
    else if (!(reward > 0)) add('The reward must be more than zero.', 'Reward', FIELD.reward, !draft.rewardAmount.trim())
    if (draft.tokenMode === 'token' && !token) add(tokenState === 'error' ? 'The custom token could not be read.' : 'Enter a Tempo token address and wait for it to resolve.', 'Token address', FIELD.token, tokenState !== 'error')
    if (draft.tokenMode === 'token' && token && token.campaignAllowed === false) add('This server does not take that token for campaigns yet: custom tokens need an on-chain test first.', 'Token', FIELD.token)
    // A prize is its own budget: there is no budget field to check.
    const budgetBad = prize ? null : decimals != null ? amountProblem(draft.budgetAmount, decimals, symbol, 'budget') : null
    if (prize) { /* the prize is the budget */ }
    else if (budgetBad) add(budgetBad, 'Budget', FIELD.budget)
    else if (!(budget > 0)) add('Set a budget.', 'Budget', FIELD.budget, true)
    else if (reward > 0 && budget < reward) add('The budget is smaller than one reward.', 'Budget below one reward', FIELD.budget)
    if (prize && draft.placesMode !== 'one' && decimals != null) {
      for (const p of placesProblems(draft.placesMode, draft.places, decimals, capSet)) add(p, 'Prize places', FIELD.places)
    }
    for (const p of countProblems(maxClaims, minSeconds, draft.actionKind === 'callin')) {
      if (/^Max claims/.test(p)) add(prize ? p.replace(/^Max claims/, 'Max entries') : p, prize ? 'Max entries' : 'Max claims', FIELD.cap)
      else add(p, 'Time on camera', FIELD.seconds)
    }
    const dl = new Date(draft.deadline)
    if (!draft.deadline || Number.isNaN(dl.getTime())) add('Pick a deadline.', 'Deadline', FIELD.deadline, true)
    else if (dl.getTime() < Date.now()) add('The deadline is in the past.', 'Deadline in the past', FIELD.deadline)
    else if (dl.getTime() > Date.now() + MAX_DEADLINE_DAYS * DAY_MS) add(`The deadline can be at most ${MAX_DEADLINE_DAYS} days out.`, 'Deadline too far out', FIELD.deadline)
    if (!draft.roomHandle.trim()) add('Choose the room the action happens in.', 'Room', FIELD.room, true)
    if ('referenceSetId' in draft.rules && !draft.rules.referenceSetId) add('"On a list of mine" has no list chosen yet.', 'List for “On a list of mine”', 'mcp-rule-referenceSetId', true)
    if (fb && !fb.referenceSetId) add('"Followed by people on a list" has no list chosen yet.', 'List for “Followed by”', 'mcp-rule-followedByFromSet', true)
    if (fb) for (const p of caps.problems) add(p, 'X-API cost cap', FIELD.xcap)
    if (draft.rules.verifiedTypes && draft.rules.verifiedTypes.length === 0) add('Pick at least one checkmark type, or switch that rule off.', 'Checkmark type', 'mcp-rule-verified')
    return out
  }, [draft, reward, budget, maxClaims, minSeconds, token, tokenState, fb, decimals, symbol, caps, prize, capSet])

  // Money goes out exactly as typed (form-rules.ts amountToSend), never as
  // String(Number(typed)), and the caps are parsed from their text here.
  const toInput = useCallback((): CampaignInput => ({
    title: draft.title.trim(),
    blurb: draft.blurb.trim(),
    reward: draft.tokenMode === 'usdc'
      ? { type: 'usdc', amount: amountToSend(draft.rewardAmount) }
      : { type: 'token', address: token!.address, amount: amountToSend(draft.rewardAmount) },
    // A prize is its own budget (the server ignores any other).
    budget: { amount: amountToSend(prize ? draft.rewardAmount : draft.budgetAmount) },
    payout: draft.payout,
    // A prize's places, 1st first; null = one winner takes the prize. By
    // amount the server makes the prize their sum (the reward above already is).
    ...(prize ? { prizes: draft.placesMode === 'one' || draft.places.length < 2 ? null : { by: draft.placesMode, places: draft.places.map((p) => p.trim()) } } : {}),
    // Blank sends null: the budget decides how many places (the server's
    // placesFor); for a prize, blank means no limit on entries.
    maxClaims: capSet,
    deadline: new Date(draft.deadline).toISOString(),
    action: {
      kind: draft.actionKind,
      roomHandle: draft.roomHandle.trim().replace(/^@/, ''),
      require: draft.require,
      ...(draft.actionKind === 'callin' ? { minSeconds } : {}),
    },
    // A rule that is present is enforced (campaign-eligibility.js
    // normaliseRules); `enabled: true` is sent for clarity, never required.
    rules: draft.rules.followedByFromSet
      ? {
          ...draft.rules,
          followedByFromSet: {
            referenceSetId: draft.rules.followedByFromSet.referenceSetId,
            min: draft.rules.followedByFromSet.min,
            perClaimCostCapUsd: caps.perClaim ?? 0,
            enabled: true,
            // Blank: the server's default of 20% of the budget.
            ...(caps.total != null ? { maxTotalUsd: caps.total } : {}),
          },
        }
      : draft.rules,
  }), [draft, capSet, minSeconds, token, caps])

  // ── Save / fund ──────────────────────────────────────────────────────────
  const [busy, setBusy] = useState<'save' | 'fund' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [approval, setApproval] = useState<{ id: string; ask: ApprovalAsk } | null>(null)
  // The draft this form has already created: a second Save (or a Save and
  // fund retried after a refused fund) PATCHes it, never POSTs a twin.
  const [savedId, setSavedId] = useState<string | null>(campaign?.id || null)
  const [chain, setChain] = useState<{ explorerUrl: string; usdcAddress: string | null }>({ explorerUrl: 'https://explore.tempo.xyz', usdcAddress: null })
  useEffect(() => { getChainInfo().then(setChain).catch(() => {}) }, [])

  // Saves, then reads the server's echo back. The server stores every
  // "followed by" rule it keeps with `enabled: true` (present = enforced), so
  // this can only fire against an older server that kept the rule switched
  // off; there it is an error, not a quiet save. (Recorded for removal.)
  const persist = useCallback(async () => {
    const input = toInput()
    const saved = await (savedId ? updateCampaign(savedId, input) : createCampaign(input))
    setSavedId(saved.id)
    clearPending()
    setKeepPending(false)
    if (input.rules.followedByFromSet) {
      const echo = saved.rules?.followedByFromSet
      if (!echo || echo.enabled !== true) {
        throw new Error(
          `Saved as a draft, but the server did not keep “Followed by people on a list” switched on, so it would not be enforced. Do not fund it until that is fixed — the draft is at /dashboard/campaigns/${saved.id}.`,
        )
      }
    }
    return saved
  }, [savedId, toInput, clearPending])

  const saveDraft = useCallback(async () => {
    setBusy('save')
    setError(null)
    try {
      const saved = await persist()
      router.push(`/dashboard/campaigns/${encodeURIComponent(saved.id)}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
      setBusy(null)
    }
  }, [persist, router])

  // Fund names the wallet the budget comes from; the server reads that
  // wallet's allowance and answers needsApproval when it is short. Throws
  // on a refusal: from the approve step, that keeps the step mounted with
  // its mined approve, so the retry is "Sign to fund", not a second approve
  // (the same path the campaign page takes).
  const tryFund = useCallback(async (id: string, proof: FundProof | null = null) => {
    const wallet = await connectedWallet()
    const r = await fundCampaign(id, { wallet, ...(proof || {}) })
    if ('needsApproval' in r && r.needsApproval) {
      setApproval({ id, ask: r.needsApproval })
      setBusy(null)
      return
    }
    router.push(`/dashboard/campaigns/${encodeURIComponent(id)}`)
  }, [router])

  const saveAndFund = useCallback(async () => {
    setBusy('fund')
    setError(null)
    try {
      const saved = await persist()
      await tryFund(saved.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not fund')
      setBusy(null)
    }
  }, [persist, tryFund])

  // ── Rules (an object keyed by rule name; a missing key is "off") ─────────
  // "Verified on X" carries the checkmark type as its sub-choice, so the rule
  // is on when either key is (an older campaign may hold only the type).
  const hasRule = (k: RuleKey) => draft.rules[k] !== undefined || (k === 'verified' && !!draft.rules.verifiedTypes)
  const setRules = (next: Rules) => patch({ rules: next })
  const toggleRule = (k: RuleKey) => {
    const next: Rules = { ...draft.rules }
    if (hasRule(k)) {
      delete next[k]
      if (k === 'verified') delete next.verifiedTypes
    } else {
      const meta = RULE_MENU.find((m) => m.key === k)!
      ;(next as Record<string, unknown>)[k] = typeof meta.on === 'object' && meta.on !== null ? JSON.parse(JSON.stringify(meta.on)) : meta.on
    }
    // Switching "followed by" on starts its caps from the menu's default,
    // the same as the rest of the rule.
    if (k === 'followedByFromSet' && !hasRule(k)) patch({ rules: next, capText: String(FOLLOWED_BY_ON.perClaimCostCapUsd), capTotalText: '' })
    else setRules(next)
  }
  const setNumber = (k: RuleKey, raw: string) => setRules({ ...draft.rules, [k]: Math.max(0, Math.floor(Number(raw) || 0)) })

  const sentence = rulesSentence(draft.rules, sets)
  // The typed text, so a custom token's 18 decimals read back as typed.
  const rewardText = Number.isFinite(reward) && reward > 0 ? rewardLabel(amountToSend(draft.rewardAmount), symbol) : `— ${symbol}`
  // "1st $30 · 2nd $15 · 3rd $5" for the preview, when the prize has places.
  const previewPlaces = prize && draft.placesMode !== 'one' && draft.places.length > 1 && decimals != null
    ? draft.places.map((p, i) => `${ordinal(i + 1)} ${rewardLabel(draft.placesMode === 'amount' ? p || '0' : percentOf(draft.rewardAmount, Number(p), decimals) || '0', symbol)}`).join(' · ')
    : ''
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const publicUrl = campaign ? `${origin}/c/${campaign.slug}` : `${origin}/c/…`
  const share = shareText({ reward: rewardText, action: draft.actionKind, sentence, rules: ruleCount(draft.rules), url: publicUrl })
  const deadlineMin = toLocalInput(new Date())
  const deadlineMax = toLocalInput(new Date(Date.now() + MAX_DEADLINE_DAYS * DAY_MS))
  const roomOptions = rooms || []
  const roomKnown = roomOptions.some((r) => r.handle === draft.roomHandle) || draft.roomHandle === identity?.handle
  const requireOptions = REQUIRE_OPTIONS[draft.actionKind]
  const example = PLACEHOLDER[draft.actionKind]
  const allMissing = problems.every((p) => p.missing)
  const firstReason = problems.find((p) => !p.missing)

  return (
    <div className="mcp-layout">
      <div className="mcp-stack">
        {/* What */}
        <section className="mcp-card">
          <header><h2>The offer in one line</h2><p>The title and blurb are what people see on the public page and on the X card. The link name is minted when you save.</p></header>
          <div className="mcp-fields">
            <label className="mcp-field"><span>Title</span><input id={FIELD.title} value={draft.title} maxLength={90} placeholder={example.title} onChange={(e) => patch({ title: e.target.value })} /></label>
            <label className="mcp-field"><span>One-line blurb</span><input value={draft.blurb} maxLength={160} placeholder={example.blurb} onChange={(e) => patch({ blurb: e.target.value })} /><small>{draft.blurb.length}/160</small></label>
          </div>
          {/* The room is chosen for the streamer (their own); said up here,
              where the offer is named, with the way to change it. */}
          {draft.roomHandle ? (
            <p className="mcp-for">For <strong>@{draft.roomHandle.replace(/^@/, '')}</strong> · <button type="button" className="mcp-inline-link" onClick={() => goToField(FIELD.room)}>Change</button></p>
          ) : null}
        </section>

        {/* Reward */}
        <section className="mcp-card" data-kind="money">
          <header><h2>{prize ? 'The prize' : 'What each person gets'}</h2></header>
          {/* How it pays. A prize is one amount the creator awards to the
              best entry after the end (campaign-engine.js award), split
              evenly between every entry if they do not pick in time. Only a
              draft can switch (the server refuses it after funding). */}
          <div className="mcp-choice-grid" role="radiogroup" aria-label="How it pays">
            {([
              ['each', 'Pay everyone who qualifies', 'A fixed reward for every Holler or Call in that counts.'],
              ['prize', 'One prize, you pick the winner', 'Every Holler or Call in that counts is an entry. Pick the best within 48 hours of the end, or it is split between every entry.'],
            ] as [PayoutMode, string, string][]).map(([k, title, copy]) => (
              <button key={k} type="button" role="radio" aria-checked={draft.payout === k} className="mcp-choice" disabled={!!campaign && campaign.status !== 'draft'}
                onClick={() => patch({ payout: k })}>
                <strong>{title}</strong>
                <small>{copy}</small>
              </button>
            ))}
          </div>
          {prize ? placesEditor() : null}
          <div className="mcp-fields two">
            <div className="mcp-field">
              <span className="mcp-label-row">
                <label htmlFor={FIELD.reward}>{prize ? 'Prize' : 'Reward per claim'}</label>
                {payouts === true ? (
                  <span className="mcp-state-chip" data-tone="ok">Pays out automatically</span>
                ) : payouts === false ? (
                  <span className="mcp-state-chip-wrap">
                    <span className="mcp-state-chip" data-tone="warn">Payouts queued</span>
                    <InfoTip label="About queued payouts" text="When the action counts, the reward is recorded as owed. It goes out once Holler switches payouts on; nothing is lost while it waits." />
                  </span>
                ) : null}
              </span>
              <span className="mcp-money-input"><span>{symbol === 'USDC' ? '$' : ''}</span><input id={FIELD.reward} inputMode="decimal" aria-label="Reward amount" value={draft.rewardAmount} readOnly={prize && draft.placesMode === 'amount'} onChange={(e) => patch({ rewardAmount: e.target.value })} /><b>{symbol}</b></span>
              {prize && draft.placesMode === 'amount' ? <small>The places added up.</small> : null}
            </div>
            <label className="mcp-field">
              <span>Token</span>
              <select value={draft.tokenMode} onChange={(e) => patch({ tokenMode: e.target.value as Draft['tokenMode'] })}>
                <option value="usdc">USDC</option>
                <option value="token">Custom token</option>
              </select>
            </label>
            {draft.tokenMode === 'token' ? (
              <label className="mcp-field wide">
                <span>Token address on Tempo</span>
                <input id={FIELD.token} value={draft.tokenAddress} placeholder="0x…" spellCheck={false} onChange={(e) => patch({ tokenAddress: e.target.value.trim() })} />
                {token ? (
                  token.campaignAllowed === false ? (
                    <small className="mcp-error"><strong>{token.symbol}</strong> is a real token, but this server does not take it for campaigns yet. Custom tokens need an on-chain test first: the network fee for every payout is paid in the token itself, so an untested token could be collected and never paid out. Use USDC for now.</small>
                  ) : (
                    <small className="mcp-ok">{token.name ? `${token.name} · ` : ''}<strong>{token.symbol}</strong> · {token.decimals} decimals</small>
                  )
                ) : tokenState === 'busy' ? (
                  <small>Reading the token…</small>
                ) : tokenState === 'error' ? (
                  <small className="mcp-error">Could not read that token{tokenError ? ` (${tokenError})` : ''}. Check it is an ERC-20 on Tempo.</small>
                ) : (
                  <small>Paste the contract address. Symbol and decimals are read from the chain. Custom tokens need an on-chain test first; only tokens this server has tested are accepted.</small>
                )}
              </label>
            ) : null}
          </div>
        </section>

        {/* Budget and limits */}
        <section className="mcp-card" data-kind="money">
          <header>{prize
            ? <><h2>How many, until when</h2><p>The prize leaves your wallet when you fund the campaign. Pick the winner within 48 hours of the deadline; if you do not, it is split evenly between every entry. With no entries, it comes back to you.</p></>
            : <><h2>How much, how many, until when</h2><p>The budget leaves your wallet when you fund the campaign. Whatever is not paid out comes back when it closes.</p></>}</header>
          {prize ? (
            <div className="mcp-fields two">
              <label className="mcp-field">
                <span>Max entries <em className="mcp-optional">optional</em></span>
                <input id={FIELD.cap} inputMode="numeric" value={draft.maxClaims} placeholder="No limit" onChange={(e) => patch({ maxClaims: e.target.value })} />
                <small>{capSet == null ? 'Blank: anyone who qualifies can enter.' : `Stops taking entries after ${capSet.toLocaleString('en-US')}.`}</small>
              </label>
              <label className="mcp-field"><span>Deadline</span><input id={FIELD.deadline} type="datetime-local" required min={deadlineMin} max={deadlineMax} value={draft.deadline} onChange={(e) => patch({ deadline: e.target.value })} /><small>Required. Entries stop here; set it to the end of the show.</small></label>
            </div>
          ) : (
          <div className="mcp-fields three">
            <label className="mcp-field">
              <span>Budget</span>
              <span className="mcp-money-input"><span>{symbol === 'USDC' ? '$' : ''}</span><input id={FIELD.budget} inputMode="decimal" aria-label="Budget amount" value={draft.budgetAmount} onChange={(e) => patch({ budgetAmount: e.target.value })} /><b>{symbol}</b></span>
              {/* The places, computed from the money: what the public page offers. */}
              <small className="mcp-pays" aria-live="polite">
                {paysPeople != null && paysPeople > 0 ? (
                  <>Pays <strong>{paysPeople.toLocaleString('en-US')} {paysPeople === 1 ? 'person' : 'people'}</strong> at {rewardText}{fb ? ', before X-API checks' : ''}</>
                ) : 'Budget ÷ reward is how many people it pays'}
              </small>
            </label>
            <label className="mcp-field">
              <span>Max claims <em className="mcp-optional">optional</em></span>
              <input id={FIELD.cap} inputMode="numeric" value={draft.maxClaims} placeholder={paysPeople != null && paysPeople > 0 ? String(paysPeople) : ''} onChange={(e) => patch({ maxClaims: e.target.value })} />
              <small>
                {capSet == null || paysPeople == null
                  ? 'Blank: the budget decides. Set a lower number to cap it.'
                  : capSet < paysPeople
                    ? `Caps it at ${capSet.toLocaleString('en-US')}. The budget it cannot pay out comes back when it closes.`
                    : capSet > paysPeople
                      ? `The budget pays ${paysPeople.toLocaleString('en-US')}, so ${paysPeople.toLocaleString('en-US')} places show.`
                      : 'Closes on its own after this many are paid'}
              </small>
            </label>
            <label className="mcp-field"><span>Deadline</span><input id={FIELD.deadline} type="datetime-local" required min={deadlineMin} max={deadlineMax} value={draft.deadline} onChange={(e) => patch({ deadline: e.target.value })} /><small>Required. Claims stop here, whatever is left; up to {MAX_DEADLINE_DAYS} days out.</small></label>
          </div>
          )}
        </section>

        {/* Action */}
        <section className="mcp-card" data-kind={draft.actionKind}>
          <header><h2>What they do to get paid</h2><p>The only paid action is on your stream.</p></header>
          <div className="mcp-choice-grid" role="radiogroup" aria-label="Action">
            {(['holler', 'callin'] as ActionKind[]).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={draft.actionKind === k} className="mcp-choice" data-kind={k}
                onClick={() => patch({ actionKind: k, require: 'aired' })}>
                <FeatureTag kind={k} />
                <strong>{k === 'holler' ? 'Holler on my room' : 'Call in on my room'}</strong>
              </button>
            ))}
          </div>
          <div className={`mcp-fields ${draft.actionKind === 'callin' ? 'three' : 'two'}`}>
            <label className="mcp-field">
              <span>Room</span>
              {roomOptions.length > 0 || !rooms ? (
                <select id={FIELD.room} value={roomKnown ? draft.roomHandle : ''} onChange={(e) => patch({ roomHandle: e.target.value })}>
                  {!roomKnown ? <option value="">{rooms ? 'Choose a room…' : 'Loading your rooms…'}</option> : null}
                  {identity?.handle && !roomOptions.some((r) => r.handle === identity.handle) ? <option value={identity.handle}>@{identity.handle} · your room link</option> : null}
                  {roomOptions.map((r) => (
                    <option key={r.id} value={r.handle || ''} disabled={!r.handle}>{r.name}{r.handle ? ` · @${r.handle}` : ' · no room link yet'}</option>
                  ))}
                </select>
              ) : (
                <input id={FIELD.room} value={draft.roomHandle} placeholder={identity?.handle || 'your-handle'} onChange={(e) => patch({ roomHandle: e.target.value })} />
              )}
              <small>{guest ? 'Your own room, once you sign in.' : rooms && roomOptions.length === 0 ? <>No rooms yet — <a className="mcp-link" href="/dashboard">open one</a>, or use your room link.</> : 'A room you own. The public page sends people here.'}</small>
            </label>
            <label className="mcp-field">
              <span>When it counts</span>
              <select value={requireOptions.includes(draft.require) ? draft.require : requireOptions[0]} onChange={(e) => patch({ require: e.target.value as ActionRequire })}>
                {requireOptions.map((r) => <option key={r} value={r}>{requireLabel(draft.actionKind, r).title}</option>)}
              </select>
              <small>{requireLabel(draft.actionKind, requireOptions.includes(draft.require) ? draft.require : requireOptions[0]).copy}</small>
            </label>
            {draft.actionKind === 'callin' ? (
              <label className="mcp-field">
                <span>Minimum time on camera</span>
                <span className="mcp-unit-input"><input id={FIELD.seconds} inputMode="numeric" aria-label="Minimum seconds on camera" value={draft.minSeconds} onChange={(e) => patch({ minSeconds: e.target.value })} /><b>seconds</b></span>
                <small>A seat shorter than this does not count</small>
              </label>
            ) : null}
          </div>
        </section>

        {/* Who qualifies: three groups, the creator's own community first. */}
        <section className="mcp-card">
          <header><h2>Rules, from the menu</h2><p>Every rule reads the claimant&rsquo;s X profile. None asks them to do anything there.</p></header>
          <p className="mcp-sentence" aria-live="polite"><span className="mcp-coordinate">Reads as</span>{sentence}</p>
          {RULE_GROUPS.map((g) => (
            <div key={g.title} className="mcp-rule-group">
              <h3 className="mcp-rule-group-title">{g.title}</h3>
              <div className="mcp-rules">
                {g.keys.map((k) => RULE_MENU.find((m) => m.key === k)).filter((m): m is RuleMeta => !!m).map((meta) => renderRuleRow(meta))}
              </div>
            </div>
          ))}
        </section>

        {/* Notice */}
        <section className="mcp-notice" role="note">
          <span className="mcp-coordinate">Required notice</span>
          <p>{COMPLIANCE_NOTICE}</p>
          <small>Shown on the public page and included in the share post.</small>
        </section>

        {/* Submit: pinned to the bottom of the screen while the form scrolls
            (ca-save-far), with what is missing as links to the fields. On
            one column it comes after the preview (ca-mobile-preview-below-save). */}
        <footer className="mcp-submit" data-sticky={approval ? undefined : 'true'}>
          {problems.length > 0 ? (
            <div className="mcp-missing" role="status">
              <p>
                <span>{problems.length} {problems.length === 1 ? 'thing' : 'things'} {allMissing ? 'missing' : 'to fix'}:</span>{' '}
                {problems.map((p, i) => (
                  <Fragment key={p.text}>
                    {i > 0 ? ' · ' : ''}
                    <button type="button" className="mcp-inline-link" title={p.text} onClick={() => goToField(p.field)}>{p.label}</button>
                  </Fragment>
                ))}
              </p>
              {firstReason ? <small>{firstReason.text}</small> : null}
            </div>
          ) : guest ? (
            <p className="mcp-hint">Sign in to save it. Your draft stays here while you do.</p>
          ) : fundingEnabled === false ? (
            <p className="mcp-hint">Save keeps it private. {FUNDING_OFF_COPY} You can draft and check rules; funding and opening wait until they are.</p>
          ) : followerChecksOff ? (
            <p className="mcp-hint">Save keeps it private. {followerWarning} Switch the rule off to fund, or fund once this server can read X.</p>
          ) : (
            <p className="mcp-hint">Save keeps it private. Fund pulls <strong className="mcp-money">{rewardLabel(amountToSend(prize ? draft.rewardAmount : draft.budgetAmount), symbol)}</strong> from your wallet; you open it to claims from the campaign page.</p>
          )}
          {/* Keyed on the ask: when fund answers needsApproval again (a short
              allowance), that is a new step, not the old one left on a
              disabled "Approved" button with a stale mined approve. */}
          {approval ? (
            <ApproveStep
              key={`${approval.id}:${approval.ask.amountAtomic}:${approval.ask.allowance ?? ''}:${approval.ask.approveRequired ? 1 : 0}`}
              ask={approval.ask}
              explorerUrl={chain.explorerUrl}
              onApproved={(proof) => tryFund(approval.id, proof)}
              onCancel={() => router.push(`/dashboard/campaigns/${encodeURIComponent(approval.id)}`)}
            />
          ) : guest ? (
            <div className="mcp-actions">
              <button type="button" className="mcp-btn" disabled={wallet.modalOpen} title={wallet.configured ? 'Twitch, X, Google, email or passkey' : undefined} onClick={signInToSave}>{wallet.modalOpen ? 'Opening…' : 'Sign in to save'}</button>
              <a className="mcp-link" href="/dashboard/campaigns">Cancel</a>
            </div>
          ) : (
            <div className="mcp-actions">
              <button type="button" className="mcp-btn-ghost" disabled={busy !== null || problems.length > 0} onClick={() => void saveDraft()}>{busy === 'save' ? 'Saving…' : editing || savedId ? 'Save changes' : 'Save as draft'}</button>
              {!campaign || campaign.status === 'draft' ? (
                <button type="button" className="mcp-btn" disabled={busy !== null || problems.length > 0 || fundingEnabled === false || followerChecksOff} title={fundingEnabled === false ? FUNDING_OFF_COPY : followerChecksOff ? followerWarning : undefined} onClick={() => void saveAndFund()}>{busy === 'fund' ? 'Funding…' : 'Save and fund'}</button>
              ) : null}
              <a className="mcp-link" href={savedId ? `/dashboard/campaigns/${encodeURIComponent(savedId)}` : '/dashboard/campaigns'}>Cancel</a>
            </div>
          )}
          {guest && authError ? <p role="alert" className="mcp-error">{authError}</p> : null}
          {error ? <p role="alert" className="mcp-error">{error}</p> : null}
        </footer>
      </div>

      {/* Preview */}
      <aside className="mcp-preview" aria-label="Preview">
        <section className="mcp-preview-card" data-kind={draft.actionKind}>
          <span className="mcp-coordinate">Public page · preview</span>
          <FeatureTag kind={draft.actionKind} />
          <h3>{draft.title.trim() || 'Your campaign title'}</h3>
          <p>{draft.blurb.trim() || 'Your one-line blurb goes here.'}</p>
          {prize ? (
            <div className="mcp-preview-reward"><strong className="mcp-money">{rewardText}</strong><span>to the best {draft.actionKind === 'holler' ? 'Holler' : 'Call in'}{previewPlaces ? 's' : ''} on @{draft.roomHandle || 'your-room'}{previewPlaces ? `: ${previewPlaces}` : ''}. Not picked within 48 hours? Split between every entry.</span></div>
          ) : (
            <div className="mcp-preview-reward"><strong className="mcp-money">{rewardText}</strong><span>to {ACTION_LABEL[draft.actionKind]} on @{draft.roomHandle || 'your-room'}</span></div>
          )}
          <p className="mcp-preview-rule">{sentence}.</p>
          <p className="mcp-preview-notice">No follow, reply or repost needed.</p>
        </section>
        <section className="mcp-preview-card">
          <span className="mcp-coordinate">Share post · generated</span>
          <p className="mcp-share">{share}</p>
          <small>{share.length - publicUrl.length + 23} / 280 · the link counts as 23</small>
        </section>
      </aside>
    </div>
  )

  /** A prize's winners: one, or up to ten places by amount or by percent of
   *  the prize. Only a draft can change them (the server refuses it after). */
  function placesEditor() {
    const locked = !!campaign && campaign.status !== 'draft'
    const dec = decimals ?? 6
    const setPlaces = (mode: Draft['placesMode'], places: string[]) => {
      // By amount, the prize is the places added up.
      const sum = mode === 'amount' ? sumAmounts(places, dec) : null
      patch(sum != null ? { placesMode: mode, places, rewardAmount: sum } : { placesMode: mode, places })
    }
    const switchTo = (mode: Draft['placesMode']) => {
      if (mode === draft.placesMode) return
      if (mode === 'one') return setPlaces('one', [])
      if (mode === 'percent') return setPlaces('percent', draft.placesMode === 'one' ? ['50', '30', '20'] : draft.places.map((_, i, a) => String(a.length === 3 ? [50, 30, 20][i] : Math.floor(100 / a.length) + (i === 0 ? 100 % a.length : 0))))
      // Amount: start from what the percents (or 50/30/20) pay of the prize now.
      const pct = draft.placesMode === 'percent' ? draft.places.map(Number) : [50, 30, 20]
      setPlaces('amount', pct.map((p) => percentOf(draft.rewardAmount, p, dec) || '0'))
    }
    return (
      <div className="mcp-places" id={FIELD.places}>
        <div className="mcp-places-head">
          <span>Winners</span>
          <div className="mcp-seg" role="radiogroup" aria-label="Winners">
            {([['one', 'One winner'], ['amount', 'Places, set amounts'], ['percent', 'Places, % of the prize']] as [Draft['placesMode'], string][]).map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={draft.placesMode === k} disabled={locked} onClick={() => switchTo(k)}>{label}</button>
            ))}
          </div>
        </div>
        {draft.placesMode !== 'one' ? (
          <ol className="mcp-place-list">
            {draft.places.map((p, i) => (
              <li key={i}>
                <span className="mcp-place-n">{ordinal(i + 1)}</span>
                <span className="mcp-money-input">
                  {draft.placesMode === 'amount' ? <span>{symbol === 'USDC' ? '$' : ''}</span> : null}
                  <input inputMode="decimal" aria-label={`${ordinal(i + 1)} place`} value={p} disabled={locked}
                    onChange={(e) => setPlaces(draft.placesMode, draft.places.map((x, j) => (j === i ? e.target.value : x)))} />
                  <b>{draft.placesMode === 'amount' ? symbol : '%'}</b>
                </span>
                {draft.placesMode === 'percent' ? <small className="mcp-place-eq">{rewardLabel(percentOf(draft.rewardAmount, Number(p), dec) || '0', symbol)}</small> : null}
                {draft.places.length > 2 && !locked ? (
                  <button type="button" className="mcp-btn-ghost mcp-btn-sm" aria-label={`Remove ${ordinal(i + 1)} place`} onClick={() => setPlaces(draft.placesMode, draft.places.filter((_, j) => j !== i))}>Remove</button>
                ) : null}
              </li>
            ))}
            {draft.places.length < MAX_PRIZE_PLACES && !locked ? (
              <li><button type="button" className="mcp-btn-ghost mcp-btn-sm" onClick={() => setPlaces(draft.placesMode, [...draft.places, draft.placesMode === 'amount' ? (draft.places[draft.places.length - 1] || '1') : '0'])}>Add a place</button></li>
            ) : null}
          </ol>
        ) : null}
        <small className="mcp-hint">{draft.placesMode === 'one'
          ? 'You pick one entry; it gets the whole prize.'
          : 'You pick one entry per place, best first. With fewer entries than places, every entry is placed and the unfilled places come back to you.'}</small>
      </div>
    )
  }

  /** One rule row. Where a rule has an (i), it sits right after the title,
   *  not at the far end of the row. */
  function renderRuleRow(meta: RuleMeta) {
    const on = hasRule(meta.key)
    const head = (
      <button type="button" className="mcp-rule-head" aria-pressed={on} onClick={() => toggleRule(meta.key)}>
        <span className="mcp-toggle" aria-hidden="true"><i /></span>
        <span><strong>{meta.title}{meta.note ? <em>{meta.note}</em> : null}</strong>{meta.copy && !meta.tip ? <small>{meta.copy}</small> : null}</span>
      </button>
    )
    return (
      <div key={meta.key} className="mcp-rule" data-on={on}>
        {meta.tip ? (
          <div className="mcp-rule-headrow" data-tip="true">
            {head}
            <InfoTip label={`About ${meta.title}`} text={meta.tip} />
            {meta.copy ? <small className="mcp-rule-copy">{meta.copy}</small> : null}
          </div>
        ) : (
          <div className="mcp-rule-headrow">{head}</div>
        )}
        {on ? <div className="mcp-rule-body" id={`mcp-rule-${meta.key}`} tabIndex={-1}>{renderRuleInputs(meta.key)}</div> : null}
      </div>
    )
  }

  function renderRuleInputs(key: RuleKey) {
    switch (key) {
      case 'minFollowers':
      case 'minAccountAgeDays':
      case 'minTweetCount':
      case 'minListedCount':
      case 'minVerifiedFollowers': {
        const unit = key === 'minAccountAgeDays' ? 'days' : key === 'minTweetCount' ? 'posts' : key === 'minListedCount' ? 'lists' : 'followers'
        return (
          <label className="mcp-field narrow">
            <span>At least</span>
            <span className="mcp-unit-input"><input inputMode="numeric" value={draft.rules[key] ?? 0} onChange={(e) => setNumber(key, e.target.value)} /><b>{unit}</b></span>
          </label>
        )
      }
      case 'verified': {
        // The checkmark type is this rule's sub-choice: Any, or one kind.
        const chosen = draft.rules.verifiedTypes || []
        const { verifiedTypes: _drop, ...rest } = draft.rules
        void _drop
        return (
          <div className="mcp-seg" role="radiogroup" aria-label="Which checkmark counts">
            <button type="button" role="radio" aria-checked={chosen.length === 0} onClick={() => setRules({ ...rest, verified: true })}>Any</button>
            {(Object.keys(VERIFIED_TYPE_SHORT) as VerifiedType[]).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={chosen.includes(t)} title={VERIFIED_TYPE_LABEL[t]} onClick={() => setRules({ ...rest, verified: true, verifiedTypes: [t] })}>{VERIFIED_TYPE_SHORT[t]}</button>
            ))}
          </div>
        )
      }
      case 'referenceSetId':
        return <ReferenceSetPicker sets={sets} loadError={setsError} campaignId={campaign?.id} campaignStatus={campaign?.status} value={draft.rules.referenceSetId || ''} onChange={(id) => setRules({ ...draft.rules, referenceSetId: id })} onCreated={(s) => setSets((xs) => [s, ...xs])} />
      case 'followedByFromSet': {
        const f = fb || { referenceSetId: '', min: 1, perClaimCostCapUsd: 0.5, enabled: true }
        const set = (p: Partial<typeof f>) => setRules({ ...draft.rules, followedByFromSet: { ...f, ...p } })
        return (
          <>
            {followerChecksOff ? <p className="mcp-error" role="alert">{followerWarning}</p> : null}
            <ReferenceSetPicker sets={sets} loadError={setsError} campaignId={campaign?.id} campaignStatus={campaign?.status} value={f.referenceSetId} onChange={(id) => set({ referenceSetId: id })} onCreated={(s) => setSets((xs) => [s, ...xs])} />
            <div className="mcp-fields two">
              <label className="mcp-field"><span>Followed by at least</span><span className="mcp-unit-input"><input inputMode="numeric" value={f.min} onChange={(e) => set({ min: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} /><b>members</b></span></label>
              <label className="mcp-field"><span>X-API cost cap per claim</span><span className="mcp-money-input"><span>$</span><input id={FIELD.xcap} inputMode="decimal" aria-label="X-API cost cap per claim" value={draft.capText} onChange={(e) => patch({ capText: e.target.value })} /><b>USD</b></span><small className="mcp-money-note">Comes out of the campaign budget, per claim checked.</small></label>
              <label className="mcp-field"><span>X-API cost cap in total</span><span className="mcp-money-input"><span>$</span><input inputMode="decimal" aria-label="X-API cost cap in total" placeholder="20% of budget" value={draft.capTotalText} onChange={(e) => patch({ capTotalText: e.target.value })} /><b>USD</b></span><small className="mcp-money-note">Every applicant is checked, qualifying or not. Past this, checks stop and applicants are told why. Blank: 20% of the budget.</small></label>
            </div>
          </>
        )
      }
      default:
        return null
    }
  }
}
