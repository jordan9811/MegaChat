'use client'

// /dashboard/campaigns/[id] — the status header (draft → funded → live →
// closed, with the budget funded / released / refunded), the two steps that
// move it along (Fund, then Open), the public link and the share post, the
// claims table, and the one destructive action, Close.

import { useCallback, useEffect, useState } from 'react'
import {
  closeCampaign,
  fundCampaign,
  getCampaign,
  getCampaignConfig,
  getChainInfo,
  listClaims,
  listMyReferenceSets,
  openCampaign,
  overlayState,
  explorerTxUrl,
  followerCheckState,
  FUNDING_OFF_COPY,
  type Campaign,
  type CampaignConfig,
  type Claim,
  type ClaimStatus,
  type ReferenceSet,
  CampaignsApiError,
} from '@/lib/campaigns-api'
import { FeatureTag } from '@/components/feature-tag'
import { ApproveStep, connectedWallet, type ApprovalAsk, type FundProof } from './approve-step'
import { PageTitle, Pip } from './campaigns-shell'
import { FrozenSet, ReferenceSetBuilder } from './reference-set-builder'
import { ACTION_LABEL, COMPLIANCE_NOTICE, allUnread, budgetFigures, checkLabel, fmtAgo, fmtClock, fmtDate, placesTaken, polishRule, requireLabel, rewardLabel, ruleCount, rulesSentence, shareText, xIntentUrl } from './rules'

type Tone = 'draft' | 'funded' | 'live' | 'closed' | 'owed' | 'paid' | 'bad' | 'ok'

const STATUS: Record<Campaign['status'], { label: string; copy: string }> = {
  draft: { label: 'Draft', copy: 'Private. Nothing has left your wallet.' },
  funding_pending: { label: 'Confirming', copy: 'The budget transfer was sent; waiting for the chain to confirm it. Nothing can change until it does.' },
  funded: { label: 'Funded', copy: 'The budget is in. Open it to start taking claims.' },
  live: { label: 'Live', copy: 'Open for claims. Payouts go out on their own.' },
  closed: { label: 'Closed', copy: 'No new claims. Owed payouts settle; the rest refunded.' },
}

// The same sentences on a server that records payouts but cannot send them
// yet (the campaign view, or any claim, says `payoutsEnabled: false`): "go
// out on their own" would be a lie there.
const STATUS_PAYOUTS_OFF: Partial<Record<Campaign['status'], string>> = {
  live: 'Open for claims. Payouts are queued on this server until they are switched on.',
  closed: 'No new claims. Owed payouts are queued until they are switched on; the rest refunds.',
}

/** What the refund waits for after a close (campaign-engine.js maybeRefund):
 *  the claims still in flight, submitted before it and honoured for the
 *  grace window, plus every owed claim, which must be intended first. A
 *  releasing claim's intent is already recorded, so it does not hold the
 *  refund back. */
const IN_FLIGHT: ClaimStatus[] = ['recorded', 'approved', 'aired', 'joined', 'owed']

/** The settlement door's word for a payout intent, in the creator's. */
function doorWord(door: string | null | undefined) {
  const d = String(door || '').toUpperCase()
  if (d === 'PENDING') return 'queued'
  if (d === 'DONE' || d === 'SENT') return 'sent'
  return door ? `intent ${door.toLowerCase()}` : 'intent recorded'
}

const CLAIM_PIP: Record<ClaimStatus, { label: string; tone: Tone }> = {
  ineligible: { label: 'Ineligible', tone: 'bad' },
  eligible: { label: 'Eligible', tone: 'ok' },
  recorded: { label: 'Recorded', tone: 'ok' },
  approved: { label: 'Approved', tone: 'ok' },
  aired: { label: 'Aired', tone: 'ok' },
  joined: { label: 'Joined', tone: 'ok' },
  owed: { label: 'Owed', tone: 'owed' },
  releasing: { label: 'Releasing', tone: 'owed' },
  paid: { label: 'Paid', tone: 'paid' },
  failed: { label: 'Failed', tone: 'bad' },
  rejected: { label: 'Rejected', tone: 'bad' },
  expired: { label: 'Expired', tone: 'bad' },
}

/** `what` completes the button's name for a screen reader ("Copy the
 *  public link", then "Copied the public link"). An aria-label would hide
 *  the visible Copy / Copied change from it. */
function CopyButton({ value, what }: { value: string; what: string }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* on screen anyway */ }
  }, [value])
  return <button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}<span className="sr-only"> {what}</span></button>
}

export function CampaignDetail({ id }: { id: string }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [claims, setClaims] = useState<Claim[] | null>(null)
  const [claimsError, setClaimsError] = useState<string | null>(null)
  const [sets, setSets] = useState<ReferenceSet[]>([])
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const [chain, setChain] = useState({ explorerUrl: 'https://explore.tempo.xyz' })
  const [busy, setBusy] = useState<'fund' | 'open' | 'close' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [approval, setApproval] = useState<ApprovalAsk | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [origin, setOrigin] = useState('')
  // null until read: Fund stays enabled on a server that cannot say, and is
  // switched off (with the reason) on one that says funding is off.
  const [config, setConfig] = useState<CampaignConfig | null>(null)
  const [buildingSet, setBuildingSet] = useState(false)

  useEffect(() => setOrigin(window.location.origin), [])
  useEffect(() => {
    getCampaignConfig().then(setConfig).catch(() => setConfig(null))
  }, [])

  const load = useCallback(async () => {
    try {
      const d = await getCampaign(id)
      setCampaign(d.campaign)
      setError(null)
    } catch (e) {
      setError({ status: e instanceof CampaignsApiError ? e.status : 0, message: e instanceof Error ? e.message : 'Could not load' })
    }
    // A failed load keeps whatever claims are on screen (none, the first
    // time): "No claims yet" beside "could not be loaded" said two things.
    listClaims(id)
      .then((d) => { setClaims(d.claims); setClaimsError(null) })
      .catch((e) => setClaimsError(e instanceof Error ? e.message : 'unavailable'))
  }, [id])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    listMyReferenceSets().then((d) => setSets(d.sets)).catch(() => {})
    getChainInfo().then((c) => setChain({ explorerUrl: c.explorerUrl })).catch(() => {})
  }, [])

  // Throws on a refusal. From the approve step that matters: the step keeps
  // its mined approve and shows the error with "Sign to fund", so a retry
  // asks for the signature only, never a second approve. The header button
  // catches and shows the same message under the status card.
  const fundOrThrow = useCallback(async (proof: FundProof | null = null) => {
    setBusy('fund')
    setActionError(null)
    try {
      const wallet = await connectedWallet()
      const r = await fundCampaign(id, { wallet, ...(proof || {}) })
      if ('needsApproval' in r && r.needsApproval) { setApproval(r.needsApproval); return }
      setApproval(null)
      await load()
    } finally {
      setBusy(null)
    }
  }, [id, load])
  const fund = useCallback(async () => {
    try { await fundOrThrow(null) } catch (e) { setActionError(e instanceof Error ? e.message : 'Could not fund') }
  }, [fundOrThrow])

  const open = useCallback(async () => {
    setBusy('open')
    setActionError(null)
    try {
      await openCampaign(id)
      await load()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not open')
    } finally {
      setBusy(null)
    }
  }, [id, load])

  const close = useCallback(async () => {
    setBusy('close')
    setActionError(null)
    try {
      await closeCampaign(id)
      setConfirmClose(false)
      await load()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not close')
    } finally {
      setBusy(null)
    }
  }, [id, load])

  if (error) {
    return (
      <>
        <PageTitle coordinate="Campaign" title="Not here" actions={<a href="/dashboard/campaigns" className="mcp-btn-ghost">All campaigns</a>} />
        <section className="mcp-card mcp-empty" role="alert">
          <span className="mcp-coordinate">{error.status === 404 ? 'Not found' : 'Could not load'}</span>
          <h2>{error.status === 404 ? 'No campaign at this address' : 'This campaign did not load'}</h2>
          <p>{error.status === 404 ? 'Either it was never saved, or the campaign API is not mounted on this server.' : error.message}</p>
        </section>
      </>
    )
  }
  if (!campaign) return <p className="mcp-hint">Loading…</p>

  const c = campaign
  const sym = c.token?.symbol || 'USDC'
  const b = budgetFigures(c)
  const publicUrl = `${origin}/c/${c.slug}`
  const sentence = rulesSentence(c.rules || {}, sets)
  const share = shareText({ reward: rewardLabel(c.reward.amount, sym), action: c.action.kind, sentence, rules: ruleCount(c.rules || {}), url: publicUrl })
  // A status this client does not know still renders, as its own word,
  // rather than taking the page down.
  const st = STATUS[c.status] || { label: String(c.status), copy: '' }
  // The campaign view says whether this server can send payouts; failing
  // that, any claim that says so speaks for the whole server. No claim is
  // needed for the status line to stop promising payouts "on their own".
  const payoutsOff = c.payoutsEnabled === false || (claims || []).some((k) => k.payoutsEnabled === false)
  const stCopy = (payoutsOff && STATUS_PAYOUTS_OFF[c.status]) || st.copy
  const places = placesTaken(c)
  const fundOff = config?.fundingEnabled === false
  // The followed-by rule on a server that cannot run it: the same gate the
  // form holds, so Fund here is not a way around it. The server's own words
  // when it sends them (the view's xCheck, then its warnings).
  const follower = followerCheckState(c, config)
  const fundBlocked = fundOff || follower.blocked
  const fundTitle = fundOff ? FUNDING_OFF_COPY : follower.blocked ? follower.warning || undefined : undefined
  // N14: the Holler room's overlay over the last 10 minutes, on a live
  // campaign. Three words from the server (overlayState reads the older
  // boolean when that is all it sends). 'unkeyed' is the one that loses
  // money: everything plays, nothing can be counted. 'none' is OBS closed:
  // nothing plays, so nothing is lost yet. 'keyed' needs no alarm.
  const overlay = c.status === 'live' ? overlayState(c) : null
  const overlayOld = overlay === 'unkeyed'
  const overlayNone = overlay === 'none'
  const overlayOk = overlay === 'keyed'
  const keyedSeen = fmtAgo(c.overlayLink?.keyedSeenAt)
  // Released splits into what has actually gone out (a transaction hash)
  // and what is still queued at the door.
  const paidOut = (claims || []).filter((k) => k.payout && (k.payout.txHash || String(k.payout.door || '').toUpperCase() === 'DONE'))
  const queued = (claims || []).filter((k) => k.payout && !k.payout.txHash && String(k.payout.door || '').toUpperCase() !== 'DONE' && k.status !== 'failed')
  const sentSum = paidOut.reduce((n, k) => n + (Number(k.payout?.amount) || 0), 0)
  const inFlight = IN_FLIGHT.reduce((n, s) => n + (c.claims?.counts?.[s] || 0), 0)
  // Waiting = no refund intent recorded yet. A zero refund is recorded too
  // (RETAINED, no amount), so `refunded === 0` could not tell the two apart.
  const refundWaiting = c.status === 'closed' && c.refundDoor == null && inFlight > 0
  // An X read is billed to a FUNDED USDC campaign: the server refuses a live
  // one (build lists before opening it) and any custom-token one (X is
  // billed in dollars), so only that campaign is offered the builder.
  const canChargeX = c.status === 'funded' && c.reward.type === 'usdc'
  const usedSetIds = [c.rules?.referenceSetId, c.rules?.followedByFromSet?.referenceSetId].filter(Boolean) as string[]
  const usedSets = sets.filter((s) => usedSetIds.includes(s.id))

  return (
    <>
      <PageTitle
        coordinate={`Campaign · ${st.label} · /c/${c.slug}`}
        title={c.title}
        lead={c.blurb || undefined}
        actions={<>
          <a href="/dashboard/campaigns" className="mcp-link">All campaigns</a>
          {c.status === 'draft' ? <a href={`/dashboard/campaigns/${encodeURIComponent(c.id)}/edit`} className="mcp-btn-ghost">Edit</a> : null}
          {c.status === 'draft' ? <button type="button" className="mcp-btn" disabled={busy !== null || fundBlocked} title={fundTitle} onClick={() => void fund()}>{busy === 'fund' ? 'Funding…' : `Fund ${rewardLabel(c.budget.amount, sym)}`}</button> : null}
          {c.status === 'funded' ? <button type="button" className="mcp-btn" disabled={busy !== null} onClick={() => void open()}>{busy === 'open' ? 'Opening…' : 'Open to claims'}</button> : null}
        </>}
      />

      <section className="mcp-status" data-status={c.status}>
        {overlayOld ? (
          <p className="mcp-overlay-warning" role="alert">
            <span><strong>Your OBS overlay is on the old link.</strong> Campaign Hollers won’t count until you paste the new overlay URL (<a href="/dashboard">Dashboard → OBS setup</a>).{keyedSeen ? ` The keyed overlay was last seen ${keyedSeen}.` : ''}</span>
          </p>
        ) : overlayNone ? (
          // Calmer than the old-link alert: nothing is playing uncounted,
          // the scene is just not open. The form's bounty-yellow notice box.
          <section className="mcp-notice mcp-overlay-notice" role="status" style={{ marginBottom: 16 }}>
            <span className="mcp-coordinate">Overlay</span>
            <p>No overlay connected — open your OBS scene with the overlay source so campaign Hollers can play and count.{keyedSeen ? ` It was last seen ${keyedSeen}.` : ''}</p>
          </section>
        ) : overlayOk ? (
          <p className="mcp-hint mcp-overlay-ok" role="status" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '0 0 12px' }}>
            <Pip tone="paid">Overlay connected</Pip>
            {keyedSeen ? <span>seen {keyedSeen}</span> : null}
          </p>
        ) : null}
        <div className="mcp-status-state">
          <Pip tone={c.status === 'funding_pending' ? 'draft' : c.status}>{st.label}</Pip>
          <span>
            <strong>{rewardLabel(c.reward.amount, sym)} to {ACTION_LABEL[c.action.kind]} on @{c.action.roomHandle}</strong>
            <small>{stCopy} Counts when {requireLabel(c.action.kind, c.action.require).title.toLowerCase()}{c.action.kind === 'callin' && c.action.minSeconds ? ` for ${c.action.minSeconds}s+` : ''}. Deadline {fmtDate(c.deadline, true)}.</small>
          </span>
          <FeatureTag kind={c.action.kind} />
        </div>
        <ol className="mcp-ladder" aria-label="Status ladder">
          {(['draft', 'funded', 'live', 'closed'] as const).map((s, i) => {
            const idx = ['draft', 'funded', 'live', 'closed'].indexOf(c.status === 'funding_pending' ? 'draft' : c.status)
            return <li key={s} data-state={i < idx ? 'done' : i === idx ? 'now' : 'next'}><i aria-hidden="true" />{STATUS[s].label}</li>
          })}
        </ol>
        <dl className="mcp-ledger">
          <div><dt>Budget</dt><dd className="mcp-money">{rewardLabel(String(b.planned), sym)}</dd></div>
          <div><dt>Funded</dt><dd className="mcp-money">{rewardLabel(String(b.funded), sym)}</dd></div>
          <div>
            <dt>Owed / sent</dt>
            <dd className="mcp-money">{rewardLabel(String(b.released), sym)} / {rewardLabel(String(sentSum), sym)}</dd>
            {claims && b.released > 0 ? <small className="mcp-td-note">{queued.length} queued · {paidOut.length} sent</small> : null}
          </div>
          <div>
            <dt>Refunded</dt>
            <dd>{rewardLabel(String(b.refunded), sym)}</dd>
            {refundWaiting ? <small className="mcp-td-note">waiting for {inFlight} {inFlight === 1 ? 'claim' : 'claims'} in flight</small> : null}
          </div>
          <div><dt>Places</dt><dd>{places} of {c.maxClaims} taken · {c.claims?.paid ?? 0} paid</dd></div>
        </dl>
        <span className="mcp-bar mcp-bar-lg" aria-label={`${b.usedPct}% of the budget owed or paid`}><i style={{ width: `${b.usedPct}%` }} /></span>
        {c.status === 'draft' && fundOff ? <p className="mcp-hint mcp-notice-inline">{FUNDING_OFF_COPY} You can keep editing the draft and checking rules; Fund and Open wait until they are.</p> : null}
        {c.status === 'draft' && !fundOff && follower.blocked ? <p className="mcp-error mcp-notice-inline" role="alert">{follower.warning} Switch the rule off (Edit) to fund, or fund once this server can read X.</p> : null}
      </section>

      {approval ? (
        <ApproveStep key={`${approval.amountAtomic}:${approval.allowance ?? ''}:${approval.approveRequired ? 1 : 0}`} ask={approval} explorerUrl={chain.explorerUrl} onApproved={(proof) => fundOrThrow(proof)} onCancel={() => setApproval(null)} />
      ) : null}
      {actionError ? <p role="alert" className="mcp-error">{actionError}</p> : null}

      <div className="mcp-detail-grid">
        <section className="mcp-card">
          <header><span className="mcp-coordinate">Public link</span><h2>Where people claim</h2><p>{c.status === 'live' ? 'Open now.' : c.status === 'closed' ? 'Shows the campaign as closed.' : 'Opens once the campaign is funded and open.'}</p></header>
          <div className="mcp-linkrow">
            <span>{publicUrl}</span>
            <CopyButton value={publicUrl} what="the public link" />
            <a href={`/c/${c.slug}`} target="_blank" rel="noopener">Open</a>
          </div>
          <header><span className="mcp-coordinate">Share on X</span></header>
          <p className="mcp-share">{share}</p>
          {c.status === 'live' ? (
            <div className="mcp-actions">
              <a className="mcp-btn mcp-btn-sm" href={xIntentUrl(share)} target="_blank" rel="noopener">Share on X</a>
              <span className="mcp-copybtn"><CopyButton value={share} what="the share post" /></span>
            </div>
          ) : (
            <p className="mcp-hint">{c.status === 'closed' ? 'The campaign is closed, so the post is kept for the record only.' : 'The share button appears once the campaign is open to claims — the link 404s until then.'}</p>
          )}
          <p className="mcp-hint mcp-notice-inline">{COMPLIANCE_NOTICE}</p>
        </section>

        <section className="mcp-card">
          <header><span className="mcp-coordinate">Who qualifies</span><h2>{sentence}</h2><p>Every rule reads the claimant’s X profile; none asks them to do anything there.</p></header>
          {usedSets.map((s) => <FrozenSet key={s.id} set={s} />)}
          {canChargeX ? (
            <>
              {/* Edit is draft-only, so a funded campaign's rules are as set as a live one's. */}
              <header><span className="mcp-coordinate">Frozen lists from X</span><p>This campaign is funded and not yet open, so a read of X can be charged to its budget until you open it. Its rules are set, so frozen lists are for your next campaign.</p></header>
              {buildingSet ? (
                <ReferenceSetBuilder chargeTo={c.id} defaultSource="x-following" onCreated={(s) => { setSets((xs) => [s, ...xs]); setBuildingSet(false) }} onCancel={() => setBuildingSet(false)} />
              ) : (
                <div className="mcp-actions"><button type="button" className="mcp-btn-ghost mcp-btn-sm" onClick={() => setBuildingSet(true)}>Freeze a list from X</button></div>
              )}
            </>
          ) : null}
        </section>
      </div>

      <section className="mcp-card mcp-claims">
        <header><span className="mcp-coordinate">Claims</span><h2>{claims == null ? (claimsError ? 'Not loaded' : 'Loading…') : claims.length === 0 ? 'No claims yet' : `${claims.length} ${claims.length === 1 ? 'claim' : 'claims'}`}</h2>{claimsError ? <p className="mcp-hint">Claims could not be loaded ({claimsError}).</p> : null}</header>
        {claims && claims.length > 0 ? (
          <div className="mcp-table" role="table" aria-label="Claims">
            <div className="mcp-tr mcp-th mcp-claim-row" role="row">
              <span role="columnheader">Handle</span>
              <span role="columnheader">On X</span>
              <span role="columnheader">Checks</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Payout</span>
              <span role="columnheader">When</span>
            </div>
            {claims.map((cl) => {
              const passed = cl.checks.filter((x) => x.pass).length
              const failed = cl.checks.filter((x) => !x.pass)
              // Unread X data is not a failed rule: nothing was judged.
              const unread = allUnread(cl.checks)
              const pip = CLAIM_PIP[cl.status] || { label: cl.status, tone: 'draft' as const }
              // N14: played on air through the old overlay link, so it was
              // not counted; the claim is still waiting, not paid.
              const unkeyed = cl.playedUnauthed === true && (cl.status === 'recorded' || cl.status === 'approved')
              const unkeyedAt = unkeyed ? fmtClock(cl.playedUnauthedAt) : null
              return (
                <div key={cl.id} className="mcp-tr mcp-claim-row" role="row">
                  <span role="cell" data-label="Handle"><strong>{cl.handle ? `@${cl.handle}` : '—'}</strong>{cl.needsWallet ? <small className="mcp-td-note">no payout wallet yet</small> : null}</span>
                  <span role="cell" data-label="On X">{cl.xHandle ? <a className="mcp-link" href={`https://x.com/${cl.xHandle.replace(/^@/, '')}`} target="_blank" rel="noopener">@{cl.xHandle.replace(/^@/, '')}</a> : '—'}</span>
                  <span role="cell" data-label="Checks" className="mcp-td-checks" title={cl.checks.map((x) => `${x.pass ? '✓' : '✗'} ${checkLabel(x.rule)}: ${polishRule(x.detail)}`).join('\n')}>
                    {unread ? (
                      <><strong>couldn’t read X</strong><small>needs a reconnect, not a verdict</small></>
                    ) : (
                      <><strong>{passed}/{cl.checks.length}</strong>{failed.length > 0 ? <small>not met: {failed.map((x) => checkLabel(x.rule)).join(', ')}</small> : <small>all passed</small>}</>
                    )}
                  </span>
                  <span role="cell" data-label="Status"><Pip tone={pip.tone}>{pip.label}</Pip>{unkeyed ? <small className="mcp-td-note mcp-td-note-bad">played{unkeyedAt ? ` at ${unkeyedAt}` : ''} through the old overlay link — not counted</small> : null}{cl.offAir ? <small className="mcp-td-note">off air: not counting</small> : null}</span>
                  <span role="cell" data-label="Payout" className="mcp-td-payout">
                    {cl.payout ? (<>
                      <strong className="mcp-money">{rewardLabel(cl.payout.amount, cl.payout.symbol)}</strong>
                      {cl.payout.txHash ? <a className="mcp-link" href={explorerTxUrl(chain.explorerUrl, cl.payout.txHash)} target="_blank" rel="noopener">tx</a> : null}
                      {cl.status === 'failed' ? <small className="mcp-error">{cl.payout.error || (cl.payout.door ? `settlement: ${cl.payout.door}` : 'payout failed')}</small> : !cl.payout.txHash && cl.payout.intentRef ? <small title={cl.payout.intentRef}>{doorWord(cl.payout.door)}{cl.payoutsEnabled === false ? ' until payouts are switched on' : ''}</small> : null}
                    </>) : <small>—</small>}
                  </span>
                  <span role="cell" data-label="When" className="mcp-td-date">{fmtDate(cl.createdAt)}</span>
                </div>
              )
            })}
          </div>
        ) : null}
      </section>

      {c.status !== 'closed' ? (
        <footer className="mcp-danger-row">
          {confirmClose ? (
            <span className="mcp-end-confirm">
              <small>{c.status === 'draft' ? 'Close this draft?' : 'Stop new claims? Claims already submitted still count for 48 hours; the refund of whatever is unspent follows.'}</small>
              <button type="button" className="mcp-btn-danger" disabled={busy !== null} onClick={() => void close()}>{busy === 'close' ? 'Closing…' : 'Yes, close it'}</button>
              <button type="button" className="mcp-btn-ghost" disabled={busy !== null} onClick={() => setConfirmClose(false)}>Keep it</button>
            </span>
          ) : (
            <button type="button" className="mcp-btn-ghost" onClick={() => setConfirmClose(true)}>Close campaign</button>
          )}
        </footer>
      ) : null}
    </>
  )
}
