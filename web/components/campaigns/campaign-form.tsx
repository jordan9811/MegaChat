'use client'

// Create and edit, one form in the create-room idiom: a stack of cards on
// the left, a live preview on the right. What → Reward → Budget and limits →
// Action → Who qualifies → the X notice → Save as draft / Save and fund.
// Opening happens on the detail page once the budget is in (the engine's
// ladder: draft → funded → live).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { listMyRooms } from '@/lib/api'
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
import { amountProblem, amountToSend, countProblems, parseCostCaps } from './form-rules'
import {
  ACTION_LABEL,
  COMPLIANCE_NOTICE,
  RULE_MENU,
  VERIFIED_TYPE_LABEL,
  requireLabel,
  rewardLabel,
  ruleCount,
  rulesSentence,
  shareText,
} from './rules'

/** The server's cap on how far out a deadline may sit. */
const MAX_DEADLINE_DAYS = 90
const DAY_MS = 86_400_000

type Draft = {
  title: string
  blurb: string
  rewardAmount: string
  tokenMode: 'usdc' | 'token'
  tokenAddress: string
  budgetAmount: string
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
    rewardAmount: '5',
    tokenMode: 'usdc',
    tokenAddress: '',
    budgetAmount: '100',
    maxClaims: '20',
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
    rewardAmount: c.reward.amount,
    tokenMode: c.reward.type === 'token' ? 'token' : 'usdc',
    tokenAddress: c.reward.address || c.token?.address || '',
    budgetAmount: c.budget.amount,
    maxClaims: String(c.maxClaims),
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
  const { identity } = useAccount()
  const editing = !!campaign
  const [draft, setDraft] = useState<Draft>(() => (campaign ? fromCampaign(campaign) : blankDraft()))
  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p })), [])

  // Rooms the action can point at. A room without a claimed link has no
  // handle to name, so it is listed but cannot be chosen.
  const [rooms, setRooms] = useState<{ id: string; name: string; handle: string | null }[] | null>(null)
  useEffect(() => {
    listMyRooms().then((d) => setRooms(d.rooms)).catch(() => setRooms([]))
  }, [])
  useEffect(() => {
    if (draft.roomHandle || !rooms) return
    const first = rooms.find((r) => r.handle)?.handle || identity?.handle || ''
    if (first) patch({ roomHandle: first })
  }, [rooms, identity, draft.roomHandle, patch])

  // Frozen lists, for the two rules that point at one.
  const [sets, setSets] = useState<ReferenceSet[]>([])
  const [setsError, setSetsError] = useState<string | null>(null)
  useEffect(() => {
    listMyReferenceSets().then((d) => setSets(d.sets)).catch((e) => setSetsError(e instanceof Error ? e.message : 'unavailable'))
  }, [])

  // What this server has switched on. Unknown until read. Funding off keeps
  // Save and loses Fund (never a Fund that errors). No X app token: the
  // "followed by" rule can only be checked through list members who signed
  // in with X, so the rule gets the server's warning and Save and fund waits
  // while it is on. Payouts off: the reward copy says "queued", not "paid".
  const [config, setConfig] = useState<CampaignConfig | null>(null)
  useEffect(() => {
    getCampaignConfig().then(setConfig).catch(() => setConfig(null))
  }, [])
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
  const reward = num(draft.rewardAmount)
  const maxClaims = Math.floor(num(draft.maxClaims))
  const budget = num(draft.budgetAmount)
  const minSeconds = Math.floor(num(draft.minSeconds))
  const suggestedBudget = Number.isFinite(reward) && Number.isFinite(maxClaims) && reward > 0 && maxClaims > 0
    ? Number((reward * maxClaims).toFixed(6)) : null
  const claimsAffordable = Number.isFinite(budget) && reward > 0 ? Math.floor(budget / reward) : null
  const fb = draft.rules.followedByFromSet
  // The server's own words when a loaded campaign carries them (xCheck,
  // warnings); the config's, or this client's, otherwise.
  const follower = followerCheckState({ rules: draft.rules, xAppToken: campaign?.xAppToken, xCheck: campaign?.xCheck, warnings: campaign?.warnings }, config)
  const followerChecksOff = follower.blocked
  const followerWarning = follower.warning || ''
  // What each person gets, honestly: paid on its own only where this server
  // can send payouts; queued where it says it cannot; hedged while unknown.
  const paidCopy = config?.payoutsEnabled === true
    ? 'Paid out automatically once the action counts.'
    : config?.payoutsEnabled === false
      ? 'Queued once the action counts: this server’s payouts are off, so rewards wait until they are switched on.'
      : 'Paid out automatically once the action counts — or queued, if this server’s payouts are off.'

  // The token's own decimals bound what can be typed (USDC has 6). Unknown
  // until a custom token resolves; the token problem covers that case.
  const decimals = draft.tokenMode === 'usdc' ? 6 : token?.decimals ?? null
  const caps = useMemo(() => parseCostCaps(draft.capText, draft.capTotalText), [draft.capText, draft.capTotalText])

  const problems = useMemo(() => {
    const out: string[] = []
    if (!draft.title.trim()) out.push('Give the campaign a title.')
    const rewardBad = decimals != null ? amountProblem(draft.rewardAmount, decimals, symbol, 'reward') : null
    if (rewardBad) out.push(rewardBad)
    else if (!(reward > 0)) out.push('The reward must be more than zero.')
    if (draft.tokenMode === 'token' && !token) out.push(tokenState === 'error' ? 'The custom token could not be read.' : 'Enter a Tempo token address and wait for it to resolve.')
    if (draft.tokenMode === 'token' && token && token.campaignAllowed === false) out.push('This server does not take that token for campaigns yet: custom tokens need an on-chain test first.')
    const budgetBad = decimals != null ? amountProblem(draft.budgetAmount, decimals, symbol, 'budget') : null
    if (budgetBad) out.push(budgetBad)
    else if (!(budget > 0)) out.push('Set a budget.')
    else if (reward > 0 && budget < reward) out.push('The budget is smaller than one reward.')
    out.push(...countProblems(maxClaims, minSeconds, draft.actionKind === 'callin'))
    const dl = new Date(draft.deadline)
    if (!draft.deadline || Number.isNaN(dl.getTime())) out.push('Pick a deadline.')
    else if (dl.getTime() < Date.now()) out.push('The deadline is in the past.')
    else if (dl.getTime() > Date.now() + MAX_DEADLINE_DAYS * DAY_MS) out.push(`The deadline can be at most ${MAX_DEADLINE_DAYS} days out.`)
    if (!draft.roomHandle.trim()) out.push('Choose the room the action happens in.')
    if ('referenceSetId' in draft.rules && !draft.rules.referenceSetId) out.push('"On a list of mine" has no list chosen yet.')
    if (fb && !fb.referenceSetId) out.push('"Followed by people on a list" has no list chosen yet.')
    if (fb) out.push(...caps.problems)
    if (draft.rules.verifiedTypes && draft.rules.verifiedTypes.length === 0) out.push('Pick at least one checkmark type, or switch that rule off.')
    return out
  }, [draft, reward, budget, maxClaims, minSeconds, token, tokenState, fb, decimals, symbol, caps])

  // Money goes out exactly as typed (form-rules.ts amountToSend), never as
  // String(Number(typed)), and the caps are parsed from their text here.
  const toInput = useCallback((): CampaignInput => ({
    title: draft.title.trim(),
    blurb: draft.blurb.trim(),
    reward: draft.tokenMode === 'usdc'
      ? { type: 'usdc', amount: amountToSend(draft.rewardAmount) }
      : { type: 'token', address: token!.address, amount: amountToSend(draft.rewardAmount) },
    budget: { amount: amountToSend(draft.budgetAmount) },
    maxClaims,
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
  }), [draft, maxClaims, minSeconds, token, caps])

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
    if (input.rules.followedByFromSet) {
      const echo = saved.rules?.followedByFromSet
      if (!echo || echo.enabled !== true) {
        throw new Error(
          `Saved as a draft, but the server did not keep “Followed by people on a list” switched on, so it would not be enforced. Do not fund it until that is fixed — the draft is at /dashboard/campaigns/${saved.id}.`,
        )
      }
    }
    return saved
  }, [savedId, toInput])

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
  const hasRule = (k: RuleKey) => draft.rules[k] !== undefined
  const setRules = (next: Rules) => patch({ rules: next })
  const toggleRule = (k: RuleKey) => {
    const next: Rules = { ...draft.rules }
    if (hasRule(k)) delete next[k]
    else {
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
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const publicUrl = campaign ? `${origin}/c/${campaign.slug}` : `${origin}/c/…`
  const share = shareText({ reward: rewardText, action: draft.actionKind, sentence, rules: ruleCount(draft.rules), url: publicUrl })
  const deadlineMin = toLocalInput(new Date())
  const deadlineMax = toLocalInput(new Date(Date.now() + MAX_DEADLINE_DAYS * DAY_MS))
  const roomOptions = rooms || []
  const roomKnown = roomOptions.some((r) => r.handle === draft.roomHandle) || draft.roomHandle === identity?.handle
  const requireOptions = REQUIRE_OPTIONS[draft.actionKind]

  return (
    <div className="mcp-layout">
      <div className="mcp-stack">
        {/* What */}
        <section className="mcp-card">
          <header><span className="mcp-coordinate">01 · What</span><h2>The offer in one line</h2><p>The title and blurb are what people see on the public page and on the X card. The link name is minted when you save.</p></header>
          <div className="mcp-fields">
            <label className="mcp-field"><span>Title</span><input value={draft.title} maxLength={90} placeholder="Call in and tell me your worst take" onChange={(e) => patch({ title: e.target.value })} /></label>
            <label className="mcp-field"><span>One-line blurb</span><input value={draft.blurb} maxLength={160} placeholder="Five minutes on camera, I pay you for showing up." onChange={(e) => patch({ blurb: e.target.value })} /><small>{draft.blurb.length}/160</small></label>
          </div>
        </section>

        {/* Reward */}
        <section className="mcp-card" data-kind="money">
          <header><span className="mcp-coordinate">02 · Reward</span><h2>What each person gets</h2><p>{paidCopy} USDC, or a token this server has approved for campaigns.</p></header>
          <div className="mcp-fields two">
            <label className="mcp-field">
              <span>Reward per claim</span>
              <span className="mcp-money-input"><span>{symbol === 'USDC' ? '$' : ''}</span><input inputMode="decimal" aria-label="Reward amount" value={draft.rewardAmount} onChange={(e) => patch({ rewardAmount: e.target.value })} /><b>{symbol}</b></span>
            </label>
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
                <input value={draft.tokenAddress} placeholder="0x…" spellCheck={false} onChange={(e) => patch({ tokenAddress: e.target.value.trim() })} />
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
          <header><span className="mcp-coordinate">03 · Budget and limits</span><h2>How much, how many, until when</h2><p>The budget leaves your wallet when you fund the campaign. Whatever is not paid out comes back when it closes.</p></header>
          <div className="mcp-fields three">
            <label className="mcp-field">
              <span>Budget</span>
              <span className="mcp-money-input"><span>{symbol === 'USDC' ? '$' : ''}</span><input inputMode="decimal" aria-label="Budget amount" value={draft.budgetAmount} onChange={(e) => patch({ budgetAmount: e.target.value })} /><b>{symbol}</b></span>
              <small>
                {suggestedBudget != null && suggestedBudget !== budget ? (
                  <>{rewardText} × {maxClaims} = <button type="button" className="mcp-inline-link" onClick={() => patch({ budgetAmount: String(suggestedBudget) })}>use {rewardLabel(String(suggestedBudget), symbol)}</button></>
                ) : claimsAffordable != null ? (
                  <>Covers {claimsAffordable} {claimsAffordable === 1 ? 'claim' : 'claims'} at {rewardText}{fb ? ' before X-API checks' : ''}</>
                ) : 'Reward × max claims is the usual number'}
              </small>
            </label>
            <label className="mcp-field"><span>Max claims</span><input inputMode="numeric" value={draft.maxClaims} onChange={(e) => patch({ maxClaims: e.target.value })} /><small>Closes on its own after this many are paid</small></label>
            <label className="mcp-field"><span>Deadline</span><input type="datetime-local" required min={deadlineMin} max={deadlineMax} value={draft.deadline} onChange={(e) => patch({ deadline: e.target.value })} /><small>Required. Claims stop here, whatever is left; up to {MAX_DEADLINE_DAYS} days out.</small></label>
          </div>
        </section>

        {/* Action */}
        <section className="mcp-card" data-kind={draft.actionKind}>
          <header><span className="mcp-coordinate">04 · Action</span><h2>What they do to get paid</h2><p>The only paid action is on your stream.</p></header>
          <div className="mcp-choice-grid" role="radiogroup" aria-label="Action">
            {(['holler', 'callin'] as ActionKind[]).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={draft.actionKind === k} className="mcp-choice" data-kind={k}
                onClick={() => patch({ actionKind: k, require: 'aired' })}>
                <FeatureTag kind={k} />
                <strong>{k === 'holler' ? 'Holler on my room' : 'Call in on my room'}</strong>
                <small>{k === 'holler' ? 'They send a recorded clip that plays on your stream.' : 'They take a live camera seat beside you.'}</small>
              </button>
            ))}
          </div>
          <div className={`mcp-fields ${draft.actionKind === 'callin' ? 'three' : 'two'}`}>
            <label className="mcp-field">
              <span>Room</span>
              {roomOptions.length > 0 || !rooms ? (
                <select value={roomKnown ? draft.roomHandle : ''} onChange={(e) => patch({ roomHandle: e.target.value })}>
                  {!roomKnown ? <option value="">{rooms ? 'Choose a room…' : 'Loading your rooms…'}</option> : null}
                  {identity?.handle && !roomOptions.some((r) => r.handle === identity.handle) ? <option value={identity.handle}>@{identity.handle} · your room link</option> : null}
                  {roomOptions.map((r) => (
                    <option key={r.id} value={r.handle || ''} disabled={!r.handle}>{r.name}{r.handle ? ` · @${r.handle}` : ' · no room link yet'}</option>
                  ))}
                </select>
              ) : (
                <input value={draft.roomHandle} placeholder={identity?.handle || 'your-handle'} onChange={(e) => patch({ roomHandle: e.target.value })} />
              )}
              <small>{rooms && roomOptions.length === 0 ? <>No rooms yet — <a className="mcp-link" href="/dashboard">open one</a>, or use your room link.</> : 'A room you own. The public page sends people here.'}</small>
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
                <span className="mcp-unit-input"><input inputMode="numeric" aria-label="Minimum seconds on camera" value={draft.minSeconds} onChange={(e) => patch({ minSeconds: e.target.value })} /><b>seconds</b></span>
                <small>A seat shorter than this does not count</small>
              </label>
            ) : null}
          </div>
        </section>

        {/* Who qualifies */}
        <section className="mcp-card">
          <header><span className="mcp-coordinate">05 · Who qualifies</span><h2>Rules, from the menu</h2><p>Every rule reads the claimant&rsquo;s X profile. None asks them to do anything there.</p></header>
          <p className="mcp-sentence" aria-live="polite"><span className="mcp-coordinate">Reads as</span>{sentence}</p>
          <div className="mcp-rules">
            {RULE_MENU.map((meta) => {
              const on = hasRule(meta.key)
              return (
                <div key={meta.key} className="mcp-rule" data-on={on}>
                  <button type="button" className="mcp-rule-head" aria-pressed={on} onClick={() => toggleRule(meta.key)}>
                    <span className="mcp-toggle" aria-hidden="true"><i /></span>
                    <span><strong>{meta.title}{meta.note ? <em>{meta.note}</em> : null}</strong><small>{meta.copy}</small></span>
                  </button>
                  {on ? <div className="mcp-rule-body">{renderRuleInputs(meta.key)}</div> : null}
                </div>
              )
            })}
          </div>
        </section>

        {/* Notice */}
        <section className="mcp-notice" role="note">
          <span className="mcp-coordinate">Required notice</span>
          <p>{COMPLIANCE_NOTICE}</p>
          <small>Shown on the public page and included in the share post.</small>
        </section>

        {/* Submit */}
        <footer className="mcp-submit">
          {problems.length > 0 ? (
            <ul className="mcp-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          ) : fundingEnabled === false ? (
            <p className="mcp-hint">Save keeps it private. {FUNDING_OFF_COPY} You can draft and check rules; funding and opening wait until they are.</p>
          ) : followerChecksOff ? (
            <p className="mcp-hint">Save keeps it private. {followerWarning} Switch the rule off to fund, or fund once this server can read X.</p>
          ) : (
            <p className="mcp-hint">Save keeps it private. Fund pulls <strong className="mcp-money">{rewardLabel(amountToSend(draft.budgetAmount), symbol)}</strong> from your wallet; you open it to claims from the campaign page.</p>
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
          ) : (
            <div className="mcp-actions">
              <button type="button" className="mcp-btn-ghost" disabled={busy !== null || problems.length > 0} onClick={() => void saveDraft()}>{busy === 'save' ? 'Saving…' : editing || savedId ? 'Save changes' : 'Save as draft'}</button>
              {!campaign || campaign.status === 'draft' ? (
                <button type="button" className="mcp-btn" disabled={busy !== null || problems.length > 0 || fundingEnabled === false || followerChecksOff} title={fundingEnabled === false ? FUNDING_OFF_COPY : followerChecksOff ? followerWarning : undefined} onClick={() => void saveAndFund()}>{busy === 'fund' ? 'Funding…' : 'Save and fund'}</button>
              ) : null}
              <a className="mcp-link" href={savedId ? `/dashboard/campaigns/${encodeURIComponent(savedId)}` : '/dashboard/campaigns'}>Cancel</a>
            </div>
          )}
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
          <div className="mcp-preview-reward"><strong className="mcp-money">{rewardText}</strong><span>to {ACTION_LABEL[draft.actionKind]} on @{draft.roomHandle || 'your-room'}</span></div>
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
      case 'verifiedTypes': {
        const chosen = draft.rules.verifiedTypes || []
        return (
          <div className="mcp-checks" role="group" aria-label="Checkmark types">
            {(Object.keys(VERIFIED_TYPE_LABEL) as VerifiedType[]).map((t) => (
              <label key={t}>
                <input type="checkbox" checked={chosen.includes(t)} onChange={(e) => setRules({ ...draft.rules, verifiedTypes: e.target.checked ? [...chosen, t] : chosen.filter((x) => x !== t) })} />
                <span>{VERIFIED_TYPE_LABEL[t]}</span>
              </label>
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
              <label className="mcp-field"><span>X-API cost cap per claim</span><span className="mcp-money-input"><span>$</span><input inputMode="decimal" aria-label="X-API cost cap per claim" value={draft.capText} onChange={(e) => patch({ capText: e.target.value })} /><b>USD</b></span><small className="mcp-money-note">Comes out of the campaign budget, per claim checked.</small></label>
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
