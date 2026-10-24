'use client'

// A frozen set of X accounts a rule can point at: pick one you already
// froze, or build one — source, estimated X-API cost, confirm. The server
// stores ids and a Merkle root; this UI only ever shows name, count,
// snapshot date and root. No list of people is shown or held here.
//
// Two sources read X and cost lookups, which the server charges to a FUNDED
// USDC campaign of the creator's (not a live one: lists are built before a
// campaign opens). A draft has nothing to charge, so on the form those two
// are locked and pasted ids (free) are the default. The detail page of a
// funded USDC campaign mounts the same builder with the X sources open
// (ReferenceSetBuilder).

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createReferenceSet,
  estimateReferenceSet,
  refusedEstimate,
  type ReferenceSet,
  type ReferenceSetEstimate,
  type ReferenceSetSource,
} from '@/lib/campaigns-api'
import { fmtDate, fmtInt, shortRoot } from './rules'

const SOURCE_LABEL: Record<ReferenceSetSource, { title: string; copy: string; refLabel?: string; refPlaceholder?: string }> = {
  manual: { title: 'Paste account ids', copy: 'Numeric X ids, one per line or comma-separated. Free.', refLabel: 'Account ids', refPlaceholder: '783214\n12\n…' },
  'x-following': { title: 'Accounts I follow on X', copy: 'Snapshot of your own following list. Costs X-API calls.' },
  'x-list': { title: 'An X List', copy: 'Members of a List by its id. Costs X-API calls.', refLabel: 'List id', refPlaceholder: '1234567890123456789' },
}

/** What a pasted list contains: the numeric ids the server takes, and every
 *  @handle or profile URL it cannot take yet (there is no handle-to-id
 *  route on the server), so nothing is dropped without being named. */
export function parsePastedIds(text: string): { ids: string[]; handles: string[]; junk: string[] } {
  const ids: string[] = []
  const handles: string[] = []
  const junk: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/[\s,;]+/)) {
    const t = raw.trim()
    if (!t) continue
    if (/^\d{1,20}$/.test(t)) { if (!seen.has(t)) { seen.add(t); ids.push(t) } continue }
    const url = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#].*)?$/i.exec(t)
    const at = /^@([A-Za-z0-9_]{1,15})$/.exec(t)
    const h = url?.[1] || at?.[1]
    if (h) { const key = `@${h.toLowerCase()}`; if (!seen.has(key)) { seen.add(key); handles.push(`@${h}`) } continue }
    junk.push(t)
  }
  return { ids, handles, junk }
}

export function FrozenSet({ set }: { set: ReferenceSet }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(set.root)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* the root is on screen either way */ }
  }, [set.root])
  return (
    <div className="mcp-frozen">
      <strong>{set.name}</strong>
      <span>{fmtInt(set.count)} accounts</span>
      <span>frozen {fmtDate(set.snapshotAt)}</span>
      <span className="mcp-root">
        <code title={set.root}>{shortRoot(set.root)}</code>
        {/* Visible Copy / Copied, completed for a screen reader by the
            hidden words; an aria-label would hide the change. */}
        <button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}<span className="sr-only"> the set root</span></button>
      </span>
    </div>
  )
}

/** The builder alone: source, estimate, freeze. `chargeTo` is the FUNDED
 *  campaign an X read is billed to; without it the two X sources are locked
 *  and only pasted ids can be frozen. */
export function ReferenceSetBuilder({
  chargeTo,
  onCreated,
  onCancel,
  defaultSource = 'manual',
}: {
  chargeTo?: string
  onCreated: (set: ReferenceSet) => void
  onCancel?: () => void
  defaultSource?: ReferenceSetSource
}) {
  const [source, setSource] = useState<ReferenceSetSource>(chargeTo ? defaultSource : 'manual')
  const [sourceRef, setSourceRef] = useState('')
  const [name, setName] = useState('')
  const [estimate, setEstimate] = useState<ReferenceSetEstimate | null>(null)
  const [busy, setBusy] = useState<'estimate' | 'freeze' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Any change to what is being frozen invalidates the price the creator saw.
  useEffect(() => { setEstimate(null) }, [source, sourceRef])

  const needsRef = source !== 'x-following'
  const xSourced = source !== 'manual'
  const pasted = useMemo(() => (source === 'manual' ? parsePastedIds(sourceRef) : null), [source, sourceRef])
  // The server takes numeric ids only; handles are named as not added, never dropped quietly.
  const refToSend = source === 'manual' ? (pasted?.ids.join('\n') || '') : sourceRef.trim()
  const canEstimate = source === 'manual' ? (pasted?.ids.length || 0) > 0 : !needsRef || !!sourceRef.trim()

  const runEstimate = useCallback(async () => {
    setBusy('estimate')
    setError(null)
    try {
      setEstimate(await estimateReferenceSet({ source, sourceRef: needsRef ? refToSend : undefined, campaignId: chargeTo }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not estimate')
    } finally {
      setBusy(null)
    }
  }, [source, refToSend, needsRef, chargeTo])

  const freeze = useCallback(async () => {
    if (!estimate) return
    setBusy('freeze')
    setError(null)
    try {
      const set = await createReferenceSet({ name: name.trim() || undefined, source, sourceRef: needsRef ? refToSend : undefined, campaignId: chargeTo, confirmCostUsd: estimate.estimatedUsd })
      onCreated(set)
      setEstimate(null)
      setSourceRef('')
      setName('')
    } catch (e) {
      const fresh = refusedEstimate(e)
      if (fresh) {
        setEstimate(fresh)
        setError(`The list changed: it now costs about $${fresh.estimatedUsd.toFixed(2)}. Freeze again to confirm.`)
      } else {
        setError(e instanceof Error ? e.message : 'Could not freeze the set')
      }
    } finally {
      setBusy(null)
    }
  }, [estimate, name, source, refToSend, needsRef, chargeTo, onCreated])

  return (
    <div className="mcp-setbuilder">
      <span className="mcp-coordinate">New frozen list</span>
      <div className="mcp-source-grid" role="radiogroup" aria-label="Source">
        {(Object.keys(SOURCE_LABEL) as ReferenceSetSource[]).map((s) => {
          const locked = s !== 'manual' && !chargeTo
          return (
            <button key={s} type="button" role="radio" aria-checked={source === s} aria-disabled={locked || undefined} className="mcp-source" data-locked={locked || undefined} onClick={() => { if (!locked) setSource(s) }}>
              <strong>{SOURCE_LABEL[s].title}</strong>
              <small>{locked ? 'Needs a funded campaign to charge the X read to.' : SOURCE_LABEL[s].copy}</small>
            </button>
          )
        })}
      </div>
      {!chargeTo ? (
        <p className="mcp-hint">Reading X costs API calls, charged to a funded campaign. Pasted ids are free; fund this campaign first, then freeze a list from your X following or an X List from its page.</p>
      ) : null}
      <label className="mcp-field">
        <span>Name <small>(optional)</small></span>
        <input value={name} maxLength={80} placeholder={source === 'x-following' ? 'Following · today' : source === 'x-list' ? 'My List' : 'Pasted ids'} onChange={(e) => setName(e.target.value)} />
      </label>
      {needsRef ? (
        <label className="mcp-field">
          <span>{SOURCE_LABEL[source].refLabel}</span>
          {source === 'manual'
            ? <textarea rows={4} value={sourceRef} placeholder={SOURCE_LABEL[source].refPlaceholder} onChange={(e) => setSourceRef(e.target.value)} />
            : <input value={sourceRef} placeholder={SOURCE_LABEL[source].refPlaceholder} inputMode="numeric" onChange={(e) => setSourceRef(e.target.value)} />}
          {pasted && sourceRef.trim() ? (
            <small className={pasted.handles.length || pasted.junk.length ? 'mcp-error' : 'mcp-ok'}>
              {pasted.ids.length} {pasted.ids.length === 1 ? 'id' : 'ids'} added.
              {pasted.handles.length ? ` Not added: ${pasted.handles.join(', ')} — handles need numeric X ids for now.` : ''}
              {pasted.junk.length ? ` Not recognised: ${pasted.junk.slice(0, 5).join(', ')}${pasted.junk.length > 5 ? '…' : ''}.` : ''}
            </small>
          ) : null}
          {source === 'manual' ? (
            <small>To find an account’s numeric id: on X, Settings → Your account → Account information shows your own; for anyone else, paste their @handle into any “X user id lookup” tool, or read it from the X API (<code>GET /2/users/by/username/…</code>).</small>
          ) : null}
        </label>
      ) : null}
      <div className="mcp-estimate">
        {estimate ? (
          <p>
            Freezing this costs about <strong className="mcp-money">${estimate.estimatedUsd.toFixed(2)}</strong> in X-API calls
            {estimate.count != null ? <> for <strong>{fmtInt(estimate.count)}</strong> accounts</> : null}. The list is a snapshot: it never updates on its own.
          </p>
        ) : xSourced ? (
          <p className="mcp-hint">Reading the list costs X-API calls, charged to this campaign’s budget. Estimate first; nothing is spent until you confirm.</p>
        ) : (
          <p className="mcp-hint">Pasted ids are free to freeze. Estimate checks them, then Freeze snapshots the list.</p>
        )}
        <div className="mcp-actions">
          {!estimate ? (
            <button type="button" className="mcp-btn-ghost mcp-btn-sm" disabled={busy !== null || !canEstimate} onClick={() => void runEstimate()}>
              {busy === 'estimate' ? 'Estimating…' : 'Estimate cost'}
            </button>
          ) : (
            <button type="button" className="mcp-btn mcp-btn-sm" disabled={busy !== null} onClick={() => void freeze()}>
              {busy === 'freeze' ? 'Freezing…' : `Freeze for $${estimate.estimatedUsd.toFixed(2)}`}
            </button>
          )}
          {onCancel ? <button type="button" className="mcp-btn-ghost mcp-btn-sm" disabled={busy !== null} onClick={onCancel}>Cancel</button> : null}
        </div>
        {error ? <p role="alert" className="mcp-error">{error}</p> : null}
      </div>
    </div>
  )
}

export function ReferenceSetPicker({
  sets,
  value,
  onChange,
  onCreated,
  loadError,
  campaignId,
  campaignStatus,
}: {
  sets: ReferenceSet[]
  value: string
  onChange: (setId: string) => void
  onCreated: (set: ReferenceSet) => void
  loadError: string | null
  /** Reading an X list costs a lookup that is charged to a FUNDED campaign
   *  of the creator's; the server refuses an X-sourced estimate without one,
   *  and refuses a live one. (The form only edits drafts today.) */
  campaignId?: string
  campaignStatus?: string
}) {
  const [building, setBuilding] = useState(sets.length === 0)
  const chosen = sets.find((s) => s.id === value) || null
  const chargeTo = campaignStatus === 'funded' ? campaignId : undefined

  return (
    <div className="mcp-setpicker">
      {sets.length > 0 ? (
        <label className="mcp-field">
          <span>Which list</span>
          <select value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose a frozen list…</option>
            {sets.map((s) => <option key={s.id} value={s.id}>{s.name} · {fmtInt(s.count)}</option>)}
          </select>
        </label>
      ) : null}
      {chosen ? <FrozenSet set={chosen} /> : null}
      {loadError ? <p className="mcp-hint">Your frozen lists could not be loaded ({loadError}). You can still build one.</p> : null}

      {!building ? (
        <button type="button" className="mcp-btn-ghost mcp-btn-sm" onClick={() => setBuilding(true)}>Freeze a new list</button>
      ) : (
        <ReferenceSetBuilder
          chargeTo={chargeTo}
          onCreated={(set) => { onCreated(set); onChange(set.id); setBuilding(false) }}
          onCancel={sets.length > 0 ? () => setBuilding(false) : undefined}
        />
      )}
    </div>
  )
}
