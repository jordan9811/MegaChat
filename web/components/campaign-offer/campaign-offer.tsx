'use client'

// The public offer for one targeted reward campaign (/c/<slug>).
//
// X DEVELOPER POLICY. A campaign pays for the Holler or the Call in and for
// nothing done on X. Every word on this page describes who qualifies (facts
// read from someone's X profile) and what Holler pays for; none of it asks
// anyone to act on X. Keep it that way when editing the copy.
//
// Colour: the reward is money, so it is bounty yellow (--f-bounty-ink); the
// one primary action is the strap azure; the feature pill carries the
// action's own colour (holler magenta / call-in azure).
//
// Money reads as "$5" for USDC; only a custom token shows its symbol
// (rewardLabel). Dates are human ("Oct 28, 2026"), never ISO.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, X as Cross } from 'lucide-react'
import { HollerMark } from '@/components/holler-mark'
import { FeatureTag } from '@/components/feature-tag'
import { explorerTxUrl, getChainInfo } from '@/lib/campaigns-api'
import { allUnread, fmtClock, isUnreadCheck, joinAnd, polishRule, rewardLabel, UNREAD_CHECK } from '@/components/campaigns/rules'
import type { CampaignCheck, CampaignClaim, MyClaim, PublicCampaign, SetFingerprint } from './types'

type Kind = 'holler' | 'callin'

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

type StatusContext = {
  kind: Kind
  /** The campaign is closed (by its creator or by its deadline). */
  closed: boolean
  /** Every failed check is unread X data: nothing has been judged yet. */
  unread: boolean
  claim: CampaignClaim
  /** The room's moderation, when the campaign view carries it. */
  moderation: string | null | undefined
}

/** What the claimant's status line says, per action and per state. The
 *  Holler is sent; a Call in is a live seat, so "send" is wrong for it.
 *  Every sentence here is a claim about what the server will do, so each
 *  one is gated on what the server has actually said. */
function statusCopy({ kind, closed, unread, claim, moderation }: StatusContext): string {
  const act = kind === 'callin' ? 'Call in to claim your place.' : 'Send your Holler to claim your place.'
  const thing = kind === 'callin' ? 'your seat' : 'your Holler'
  const honour = closed && claim.honourUntil ? fmtDateTime(claim.honourUntil) : null
  // N14: it played, through the streamer's OLD overlay link, so the server
  // could not confirm it aired. Not a verdict on the claimant; the fix is on
  // the streamer's side. Said before anything else while it is still waiting,
  // with the time it played when the server recorded one.
  if (claim.playedUnauthed && (claim.status === 'recorded' || claim.status === 'approved')) {
    const at = fmtClock(claim.playedUnauthedAt)
    return `This played${at ? ` at ${at}` : ''}, but through an overlay link that can’t confirm it aired. The streamer needs to update their OBS overlay link before it can count.${honour ? ` It still counts if it airs before ${honour}.` : ''}`
  }
  switch (claim.status) {
    case 'ineligible': return unread ? 'We couldn’t read your X account yet.' : 'You do not qualify for this one.'
    case 'eligible': return `You qualify. ${act}`
    case 'recorded':
      if (honour) return `This campaign has closed, but ${thing} still counts if it ${kind === 'callin' ? 'goes on air' : 'airs'} before ${honour}.`
      return kind === 'callin' ? 'Your seat is reserved. Waiting for it to count.' : 'Sent. Waiting for it to count.'
    case 'approved': {
      // An auto-moderated room "approves" with nobody looking, so "Cleared"
      // is the honest word; "Approved by the stream" only when a person did.
      const auto = claim.autoModerated === true || moderation === 'auto'
      const manual = claim.autoModerated === false || moderation === 'approve'
      const cleared = auto ? 'Cleared for the stream.' : manual ? 'Approved by the stream.' : 'Cleared.'
      if (honour) return `${cleared} This campaign has closed, but ${thing} still counts if it airs before ${honour}.`
      return `${cleared} It counts once it airs.`
    }
    case 'aired': return 'It aired. Your reward is being lined up.'
    case 'joined':
      if (honour) return `You are on camera. This campaign has closed, but your seat still counts if it reaches the minimum before ${honour}.`
      return 'You are on camera. Stay on to count.'
    case 'owed': return 'You earned it. Your reward is owed to you.'
    case 'releasing':
      if (claim.payoutsEnabled === false) return 'Reward recorded. Payouts are queued on this server and will be sent when they’re switched on.'
      if (claim.payoutsEnabled === true) return 'Reward recorded. It’s being sent from the Holler wallet; you’ll see the transaction here.'
      return 'Reward recorded. You’ll see the transaction here once it’s sent.'
    case 'paid': return 'Paid.'
    case 'failed': return 'The payment did not go through. The creator has been told.'
    case 'rejected': return 'The stream turned this one down.'
    case 'expired': return 'The campaign closed before this counted.'
    default: return claim.status
  }
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  const d = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`)
  return d
}

const shortHex = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`

const primaryCta = 'inline-flex items-center justify-center rounded-lg bg-hl-strap px-5 py-3 text-[15px] font-bold text-hl-on-strap transition-colors hover:bg-hl-strap-hover disabled:opacity-50'
const secondaryCta = 'inline-flex items-center justify-center rounded-lg border border-hl-strap-hi px-4 py-2.5 text-[14px] font-bold text-hl-strap-hi transition-colors hover:bg-hl-strap hover:text-hl-on-strap disabled:opacity-50'

/** The frozen list: name, size and date in the open; the fingerprint behind
 *  one question, with one plain sentence on what it proves. */
function Fingerprint({ set, label }: { set: SetFingerprint; label: string }) {
  return (
    <section className="rounded-2xl border border-hl-line bg-hl-panel p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-hl-dim">{label}</p>
      <h3 className="mt-1 text-[17px] font-bold text-hl-fg">{set.name}</h3>
      <p className="mt-1 text-[13px] text-hl-muted">{set.count.toLocaleString('en-US')} accounts, frozen {fmtDate(set.snapshotAt)}.</p>
      <details className="mt-3 text-[13px]">
        <summary className="cursor-pointer font-semibold text-hl-strap-hi">How do I know the list can’t change?</summary>
        <p className="mt-2 text-hl-muted">
          The list was frozen on {fmtDate(set.snapshotAt)} and given a fingerprint (a Merkle root of its {set.count.toLocaleString('en-US')} ids); any change to who is on it changes the fingerprint, so the creator cannot swap names in after the fact.
        </p>
        <p className="mt-2 text-[12px] text-hl-dim">Fingerprint, version {set.version}</p>
        <code className="mt-1 block break-all font-[family-name:var(--font-code)] text-[12px] text-hl-muted">{set.root}</code>
      </details>
    </section>
  )
}

/** The checks, with every "could not read your … from X" collapsed into one
 *  banner carrying one Reconnect X button, and the rest listed as they are.
 *  The same field can fail several rules (profile photo and bio both read
 *  "profile"), so the list is de-duplicated before it is read out. */
function Checks({ checks, reconnectHref }: { checks: CampaignCheck[]; reconnectHref: string | null }) {
  const unread = checks.filter(isUnreadCheck)
  const rest = checks.filter((c) => !unread.includes(c))
  const fields = [...new Set(unread.map((c) => UNREAD_CHECK.exec(c.detail)?.[1] || '').filter(Boolean))]
  return (
    <div className="mt-4 space-y-3">
      {unread.length > 0 ? (
        <div className="rounded-xl border border-hl-danger/40 bg-hl-danger/10 p-4" role="status">
          <p className="text-[14px] font-semibold text-hl-fg">We couldn’t read your {fields.length > 0 ? joinAnd(fields) : 'X profile'} from X.</p>
          <p className="mt-1 text-[13px] text-hl-muted">Your X details need refreshing and we could not do it from here. Reconnect X once, then check again; it reads your public profile and never posts.</p>
          {reconnectHref ? <a href={reconnectHref} className={`${secondaryCta} mt-3`}>Reconnect X</a> : null}
        </div>
      ) : null}
      {rest.length > 0 ? (
        <ul className="space-y-2">
          {rest.map((c, i) => (
            <li key={`${c.rule}-${i}`} className="flex items-start gap-2 text-[14px]">
              {c.pass
                ? <Check aria-label="Passed" className="mt-0.5 size-4 shrink-0 text-f-rewards-ink" />
                : <Cross aria-label="Not met" className="mt-0.5 size-4 shrink-0 text-hl-danger" />}
              <span className={c.pass ? 'text-hl-fg' : 'text-hl-muted'}>{polishRule(c.detail)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function CampaignOffer({ slug, initial }: { slug: string; initial: PublicCampaign | null }) {
  const [c, setC] = useState<PublicCampaign | null>(initial)
  const [missing, setMissing] = useState(!initial)
  const [me, setMe] = useState<MyClaim | null>(null)
  const [checks, setChecks] = useState<CampaignCheck[] | null>(null)
  const [eligible, setEligible] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [wallet, setWallet] = useState('')
  const [explorerUrl, setExplorerUrl] = useState('https://explore.tempo.xyz')
  const autoRan = useRef(false)

  const base = `/api/campaigns/${encodeURIComponent(slug)}`
  const back = `/c/${encodeURIComponent(slug)}?check=1`
  const xSignInUrl = `/auth/x?returnTo=${encodeURIComponent(back)}`

  const loadMe = useCallback(async () => {
    try {
      const d = await jsonOrThrow<MyClaim>(await fetch(`${base}/my-claim`, { credentials: 'same-origin' }))
      setMe(d)
      if (d.claim) { setChecks(d.claim.checks); setEligible(d.claim.status !== 'ineligible' && d.claim.status !== 'rejected') }
      return d
    } catch { return null }
  }, [base])

  const runCheck = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      const d = await jsonOrThrow<{ eligible: boolean; checks: CampaignCheck[]; claim: CampaignClaim | null }>(
        await fetch(`${base}/check`, { method: 'POST', credentials: 'same-origin' }),
      )
      setChecks(d.checks); setEligible(d.eligible)
      await loadMe()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The check failed')
    } finally {
      setBusy(false)
    }
  }, [base, loadMe])

  useEffect(() => {
    if (!initial) {
      fetch(base).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.campaign) { setC(d.campaign); setMissing(false) } }).catch(() => {})
    }
    getChainInfo().then((i) => setExplorerUrl(i.explorerUrl)).catch(() => {})
    void loadMe().then((d) => {
      // Back from X sign-in: run the check once, then drop the marker.
      const q = new URLSearchParams(window.location.search)
      if (!autoRan.current && d?.xLinked && (q.get('check') === '1' || q.get('linked') === 'x') && (!d.claim || d.claim.status === 'ineligible' || d.claim.status === 'eligible')) {
        autoRan.current = true
        window.history.replaceState(null, '', `/c/${encodeURIComponent(slug)}`)
        void runCheck()
      }
    })
  }, [base, initial, loadMe, runCheck, slug])

  const onCheck = () => {
    if (!me?.xLinked) { window.location.href = xSignInUrl; return }
    void runCheck()
  }

  const saveWallet = async (address: string) => {
    setBusy(true); setErr(null)
    try {
      await jsonOrThrow(await fetch('/api/account/payout-wallet', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }),
      }))
      await loadMe()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the wallet')
    } finally {
      setBusy(false)
    }
  }

  const connectWallet = async () => {
    const MW = typeof window !== 'undefined' ? window.MegaWallet : undefined
    if (!MW?.configured) { setErr('Wallet sign-in is not set up here. Paste an address instead.'); return }
    try { const addr = await MW.connect(); if (addr) await saveWallet(addr) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Wallet connect was cancelled') }
  }

  if (missing || !c) {
    return (
      <div className="rounded-2xl border border-hl-line bg-hl-panel p-8 text-center">
        <h1 className="text-[24px] font-bold">This campaign is not here</h1>
        <p className="mt-2 text-hl-muted">It may have ended, or the link is wrong.</p>
        <a href="/app" className="mt-5 inline-block font-semibold text-hl-strap-hi">Browse live rooms</a>
      </div>
    )
  }

  const kind: Kind = c.action.kind === 'callin' ? 'callin' : 'holler'
  const actionName = kind === 'callin' ? 'Call in' : 'Holler'
  const counts = kind === 'callin'
    ? (c.action.require === 'joined' ? 'once your camera is live on the stream' : `once you have been on camera for ${c.action.minSeconds ?? 60} seconds`)
    : (c.action.require === 'approved' ? 'once the stream approves it' : 'once it plays on the stream')
  const claim = me?.claim || null
  // The server's public view already maps a passed deadline to 'closed', so
  // "live" is the one open/closed switch; the deadline only decides which
  // closed sentence to show.
  const live = c.status === 'live'
  const pastDeadline = !!c.deadline && Number.isFinite(Date.parse(c.deadline)) && Date.parse(c.deadline) <= Date.now()
  const full = c.spotsLeft <= 0 || Number(c.budget.left) < Number(c.reward.amount)
  const closedWhy = !live
    ? (pastDeadline ? `This campaign ended ${fmtDate(c.deadline)}.` : 'This campaign has closed.')
    : full ? 'All places are taken.' : null
  // Someone already holding a place (recorded, owed, paid…) keeps their status
  // even when the campaign is full; only new entrants are turned away.
  const holdsPlace = !!claim && !['ineligible', 'eligible', 'rejected', 'expired'].includes(claim.status)
  const open = closedWhy == null
  const canCheck = open && (!claim || claim.status === 'ineligible' || claim.status === 'eligible')
  const canAct = open && eligible === true && claim?.status === 'eligible'
  // Unread X data is not a verdict: the page says so and leads with Reconnect X.
  const unread = allUnread(checks || [])
  const stale = (checks || []).some((k) => !k.pass && /Reconnect X/.test(k.detail))
  const reconnectHref = me?.xSignIn ? xSignInUrl : null
  const actCta = kind === 'callin' ? 'Call in on the stream' : 'Record your Holler'
  const reward = rewardLabel(c.reward.amount, c.reward.symbol)
  const payoutsOff = claim?.payoutsEnabled === false
    || (claim?.payoutsEnabled == null && !!claim?.payout && !claim.payout.txHash && /no[ _-]?(payout[ _-]?)?(key|signer)|queued/i.test(claim.payout.door || ''))

  // One primary action in the hero, in azure: act once eligible, reconnect
  // X when the check could not read it, else check.
  const heroCta = canAct
    ? <a href={c.joinUrl} className={primaryCta}>{actCta}</a>
    : canCheck && unread && reconnectHref
      ? <a href={reconnectHref} className={primaryCta}>Reconnect X</a>
      : canCheck
        ? <button type="button" onClick={onCheck} disabled={busy || (!me?.xLinked && me?.xSignIn === false)} className={primaryCta}>{busy ? 'Checking…' : checks ? 'Check again' : 'Check if I qualify'}</button>
        : null

  return (
    <article className="space-y-6">
      <header className="rounded-2xl border border-hl-line bg-hl-panel p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-2">
          <HollerMark px={18} />
          <FeatureTag kind={kind}>{actionName} campaign</FeatureTag>
          {closedWhy ? <span className="text-[12px] font-semibold uppercase tracking-wide text-hl-dim">{!live ? 'Closed' : 'Full'}</span> : null}
        </div>
        <h1 className="mt-4 text-[28px] font-extrabold leading-[1.1] sm:text-[36px]">{c.title}</h1>
        {c.blurb ? <p className="mt-3 max-w-2xl whitespace-pre-line text-[15px] text-hl-muted">{c.blurb}</p> : null}
        <p className="mt-4 flex flex-wrap items-baseline gap-x-2 text-[15px]">
          <strong className="text-[24px] font-extrabold tracking-tight text-f-bounty-ink">{reward}</strong>
          <span className="text-hl-muted">for a {actionName} on <a href={`/${c.action.roomHandle}`} className="font-bold text-hl-strap-hi hover:underline">@{c.action.roomHandle}</a></span>
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {heroCta}
          {closedWhy && !holdsPlace ? <p className="text-[15px] font-semibold text-hl-fg">{closedWhy}{full && live ? ' Nobody else can claim.' : ''}</p> : null}
          {!me?.xLinked && me?.xSignIn && canCheck ? <span className="text-[13px] text-hl-dim">Signs you in with X through Holler; reads your public profile, never posts.</span> : null}
        </div>
        {/* A closed campaign advertises no space: only the date it ran to. */}
        <dl className={`mt-6 grid grid-cols-2 gap-4 border-t border-hl-line pt-5 ${live ? 'sm:grid-cols-3' : ''}`}>
          {live ? <div><dt className="text-[12px] text-hl-dim">Places</dt><dd className="text-[16px] font-bold">{c.spotsLeft} of {c.maxClaims} left</dd></div> : null}
          {live ? <div><dt className="text-[12px] text-hl-dim">Budget left</dt><dd className="text-[16px] font-bold text-f-bounty-ink">{rewardLabel(c.budget.left, c.budget.symbol)}</dd></div> : null}
          <div><dt className="text-[12px] text-hl-dim">{live ? 'Deadline' : pastDeadline ? 'Ended' : 'Was open until'}</dt><dd className="text-[16px] font-bold">{fmtDate(c.deadline) || 'None set'}</dd></div>
        </dl>
        <p className="mt-5 text-[13px] text-hl-dim">
          Paid for the {actionName} only, {counts}. Nothing you do on X is part of the deal.
          {c.funded && live ? ' The budget is already funded.' : ''}
        </p>
      </header>

      <section className="rounded-2xl border border-hl-line bg-hl-panel p-6">
        <h2 className="text-[18px] font-bold">Who qualifies</h2>
        <p className="mt-1 text-[13px] text-hl-dim">Read from your X profile when you check. Nothing is posted.</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[14px] text-hl-fg">
          {c.rules.map((r) => <li key={r}>{polishRule(r)}</li>)}
        </ul>
      </section>

      {c.referenceSet ? <Fingerprint set={c.referenceSet} label="The frozen list" /> : null}
      {c.followedBySet && c.followedBySet.id !== c.referenceSet?.id ? <Fingerprint set={c.followedBySet} label="The list that vouches" /> : null}

      <section className="rounded-2xl border border-hl-line bg-hl-panel p-6" aria-live="polite">
        <h2 className="text-[18px] font-bold">Your status</h2>
        {closedWhy && !holdsPlace ? (
          <p className="mt-1 text-[15px] font-semibold">{closedWhy}{claim?.status === 'eligible' ? (live ? ' You qualified, but there is no place left to take.' : ' You qualified, but it ended before you claimed.') : ''}</p>
        ) : claim ? (
          <p className="mt-1 text-[15px] font-semibold">{statusCopy({ kind, closed: !live, unread, claim, moderation: c.action.moderation })}</p>
        ) : null}
        {me?.xLinked ? <p className="mt-1 text-[13px] text-hl-dim">Checking as @{me.xUsername} on X.</p> : null}

        {checks ? <Checks checks={checks} reconnectHref={stale || unread ? reconnectHref : null} /> : null}

        {canCheck || canAct ? (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {canCheck ? (
              <button type="button" onClick={onCheck} disabled={busy || (!me?.xLinked && me?.xSignIn === false)} className={canAct || (unread && reconnectHref) ? secondaryCta : primaryCta}>
                {busy ? 'Checking…' : checks ? 'Check again' : 'Check if I qualify'}
              </button>
            ) : null}
            {canAct ? <a href={c.joinUrl} className={primaryCta}>{actCta}</a> : null}
          </div>
        ) : null}
        {!me?.xLinked && me?.xSignIn === false ? (
          <p className="mt-3 text-[13px] text-hl-dim">X sign-in is not set up on this server yet, so nobody can be checked here.</p>
        ) : null}
        {/* The "reads your profile, never posts" line is said once, beside
            the hero button; this second button gets the short form only. */}
        {!me?.xLinked && me?.xSignIn && canCheck ? (
          <p className="mt-3 text-[13px] text-hl-dim">Signs you in with X through Holler.</p>
        ) : null}

        {claim?.needsWallet ? (
          <div className="mt-6 rounded-xl border border-hl-line-2 p-4">
            <p className="text-[14px] font-semibold">Where should we send {claim.owed ? rewardLabel(claim.owed.amount, claim.owed.symbol) : 'your reward'}?</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => void connectWallet()} disabled={busy} className="rounded-lg bg-hl-strap px-3 py-2 text-[13px] font-bold text-hl-on-strap disabled:opacity-50">Connect wallet</button>
              <input
                value={wallet}
                onChange={(e) => setWallet(e.target.value.trim())}
                placeholder="or paste 0x… address"
                aria-label="Payout wallet address"
                className="min-w-0 flex-1 rounded-lg border border-hl-field bg-transparent px-3 py-2 font-[family-name:var(--font-code)] text-[13px]"
              />
              <button type="button" onClick={() => void saveWallet(wallet)} disabled={busy || !wallet} className="rounded-lg border border-hl-line-2 px-3 py-2 text-[13px] font-semibold disabled:opacity-50">Save</button>
            </div>
          </div>
        ) : null}
        {claim?.payout ? (
          <p className="mt-4 text-[13px] text-hl-dim">
            <span className="font-semibold text-f-bounty-ink">{rewardLabel(claim.payout.amount, claim.payout.symbol)}</span> to <code className="font-[family-name:var(--font-code)]">{shortHex(claim.payout.to)}</code>
            {claim.payout.txHash
              ? <> · <a href={explorerTxUrl(explorerUrl, claim.payout.txHash)} target="_blank" rel="noopener" className="font-semibold text-hl-strap-hi hover:underline">transaction {claim.payout.txHash.slice(0, 10)}…</a></>
              : payoutsOff
                ? ' · queued on this server; it goes out when payouts are switched on.'
                : claim.payoutsEnabled === true
                  ? ' · being sent from the Holler wallet; the transaction link appears here once it is out.'
                  : ' · the transaction link appears here once it is sent.'}
          </p>
        ) : null}
        {err ? <p role="alert" className="mt-3 text-[13px] text-hl-danger">{err}</p> : null}
      </section>

      {c.creator ? <p className="text-center text-[12px] text-hl-dim">Campaign by @{c.creator.handle}</p> : null}
    </article>
  )
}
