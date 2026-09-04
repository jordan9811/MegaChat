'use client'

// THE BOUNTY LEADERBOARD — /bounty.
//
// One table: each nominated streamer, how much of the pool is actually
// theirs, and what a fan does next. The stacked bar is the whole argument.
// A pool's headline number is never blended: solid green is money locked to
// that one name, the yellow hatch is money pledged to rivals as well and may
// go somewhere else entirely. A streamer who claims and then watches "their"
// pool shrink learns about restaking from the worst possible teacher, so the
// board teaches it on the way in.
//
// Same rule at the top of the page: escrow (each pledge counted once) and the
// across-pools figure (a contested pledge counted per name it was offered to)
// are shown as two numbers with two labels, never added together.

import { useEffect, useState } from 'react'
import { AccountChip } from '@/components/account-chip'
import { getBountyConfig, getProgram, type BountyClientConfig, type ProgramPool } from '@/lib/bounty-api'
import { exampleTotals } from '@/lib/bounty-examples'
import { formatDollars } from '@/lib/display-format'

// From docs/design/copy-bank.md — the bounty page is the one surface where
// "demand more" is literally what the product does.
const START_LINE = 'Choose a streamer and platform. Add the amount and terms on the next screen.'

// Mirrors sanitizeHandle in rooms-store.js — the only shape /<handle> serves.
const ROOM_HANDLE = /^[a-z0-9_]{3,20}$/

// Values are the STORE's keys, not display labels. 'pump.fun' here would
// build a pool key distinct from the existing 'pumpfun' one — two escrow
// balances for one streamer. platformLabel() handles the display side.
const PLATFORMS = ['twitch', 'kick', 'x', 'rumble', 'youtube', 'pumpfun']

/** Same hash the room tiles use, so a handle always draws the same mesh. */
function meshIndex(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 6
}

function platformLabel(p: string | null): string {
  const k = (p || '').toLowerCase()
  if (!k) return 'Unlisted'
  if (k === 'x' || k === 'twitter') return 'X'
  if (k === 'pump.fun' || k === 'pumpfun') return 'pump.fun'
  if (k === 'youtube') return 'YouTube'
  if (k === 'tiktok') return 'TikTok'
  return k.charAt(0).toUpperCase() + k.slice(1)
}

const money = formatDollars

function poolHref(p: { platform: string | null; handle: string | null }): string {
  return p.platform && p.handle
    ? `/bounty/s/${encodeURIComponent(p.platform)}/${encodeURIComponent(p.handle)}`
    : '/bounty'
}

/** How many OTHER names the most-shared contested pledge also points at. */
function rivalCount(contested: { rivals: number }[]): number {
  let n = 0
  for (const c of contested) if (c.rivals > n) n = c.rivals
  return n
}

function PlatformMark({ platform }: { platform: string | null }) {
  const k = (platform || '').toLowerCase()
  const label = platformLabel(platform)
  if (k === 'twitch') {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="#9146FF" role="img" aria-label={label}>
        <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
      </svg>
    )
  }
  if (k === 'kick') {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="#53FC18" role="img" aria-label={label}>
        <path d="M1.333 0h8v5.333H12V2.667h2.667V0h8v8H20v2.667h-2.667v2.666H20V16h2.667v8h-8v-2.667H12v-2.666H9.333V24h-8Z" />
      </svg>
    )
  }
  if (k === 'x' || k === 'twitter') {
    return (
      <svg viewBox="0 0 24 24" width="13" height="13" fill="#f2f2f4" role="img" aria-label={label}>
        <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
      </svg>
    )
  }
  if (k === 'rumble') {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="#85C742" role="img" aria-label={label}>
        <path d="M14.4528 13.5458c.8064-.6542.9297-1.8381.2756-2.6445a1.8802 1.8802 0 0 0-.2756-.2756 21.2127 21.2127 0 0 0-4.3121-2.776c-1.066-.51-2.256.2-2.4261 1.414a23.5226 23.5226 0 0 0-.14 5.5021c.116 1.23 1.292 1.964 2.372 1.492a19.6285 19.6285 0 0 0 4.5062-2.704v-.008zm6.9322-5.4002c2.0335 2.228 2.0396 5.637.014 7.8723A26.1487 26.1487 0 0 1 8.2946 23.846c-2.6848.6713-5.4168-.914-6.1662-3.5781-1.524-5.2002-1.3-11.0803.17-16.3045.772-2.744 3.3521-4.4661 6.0102-3.832 4.9242 1.174 9.5443 4.196 13.0764 8.0121v.002z" />
      </svg>
    )
  }
  if (k === 'pump.fun' || k === 'pumpfun') {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" role="img" aria-label={label}>
        <g transform="rotate(-45 12 12)">
          <rect x="0.5" y="7.25" width="23" height="9.5" rx="4.75" fill="#43e0a8" />
          <rect x="11.3" y="7.25" width="1.4" height="9.5" fill="#08080a" />
        </g>
      </svg>
    )
  }
  // Anything else still gets a mark rather than an empty square.
  return (
    <span role="img" aria-label={label} className="text-[10px] font-[800] leading-none text-[var(--mcc-off)]">
      {label.charAt(0).toUpperCase()}
    </span>
  )
}

/** One 46px slot, two sources. A missing photo must never read as broken. */
function Avatar({
  handle,
  platform,
  avatarUrl,
}: {
  handle: string
  platform: string | null
  avatarUrl: string | null
}) {
  const [broken, setBroken] = useState(false)
  const mesh = meshIndex(handle.toLowerCase())
  const letter = (handle.trim().charAt(0) || '?').toUpperCase()
  return (
    <span className="relative block size-[46px] shrink-0">
      {avatarUrl && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt=""
          width={46}
          height={46}
          loading="lazy"
          onError={() => setBroken(true)}
          className="size-[46px] object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className={`mc-mesh-${mesh} flex size-[46px] items-center justify-center text-[18px] font-[800] text-[rgba(242,242,244,0.72)]`}
        >
          {letter}
        </span>
      )}
      <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center bg-[var(--mcc-bg)]">
        <PlatformMark platform={platform} />
      </span>
    </span>
  )
}

function Row({
  pool,
  rank,
  currency,
  selected,
  onSelect,
}: {
  pool: ProgramPool
  rank: number
  currency: string
  selected: boolean
  onSelect: () => void
}) {
  const handle = pool.handle || pool.handleKey
  const contested = pool.contested || []
  const contestedTotal = pool.contestedTotal || 0
  const guaranteed = pool.guaranteed || 0
  const total = guaranteed + contestedTotal
  // Zero-total pools exist by design (a seeded name nobody has backed yet),
  // so the split is only computed when there is something to split.
  const lockedPct = total > 0 ? (guaranteed / total) * 100 : 0
  const rivals = rivalCount(contested)
  const claimed = !!pool.claimed
  // Distinct claims: `seeded` means WE opened it, `promotional` means nobody
  // has money on it right now. A fan-opened pool whose pledges all expired is
  // the second, not the first — calling it Seeded misattributes who put it there.
  const seeded = !claimed && !!pool.seeded
  const quiet = !claimed && !seeded && !!pool.promotional

  const pip = claimed ? 'Claimed' : pool.displayOnly ? 'Example' : seeded ? 'Seeded' : quiet ? 'Open' : 'Unclaimed'
  const pipColor = claimed
    ? 'var(--mcc-live)'
    : seeded
      ? 'var(--mcc-warn)'
      : 'var(--mcc-off)'

  const barLabel =
    total <= 0
      ? 'Nothing pledged yet'
      : contestedTotal > 0
        ? `${money(guaranteed)} ${currency} locked to this name, ${money(contestedTotal)} ${currency} also pledged to ${rivals} other ${rivals === 1 ? 'streamer' : 'streamers'}`
        : `${money(guaranteed)} ${currency}, all locked to this name`

  return (
    <div className={`lb-row${claimed ? ' is-claimed' : ''}${selected ? ' is-selected' : ''}`}>
      <span
        className="lb-rank text-[17px] font-[800] tabular-nums"
        style={{ color: rank <= 3 && !claimed ? 'var(--mcc-accent)' : 'var(--mcc-ghost)' }}
      >
        {String(rank).padStart(2, '0')}
      </span>

      <button type="button" className="lb-who flex min-w-0 items-center gap-3.5 text-left" onClick={onSelect} aria-pressed={selected}>
        <Avatar handle={handle} platform={pool.platform} avatarUrl={pool.avatarUrl} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[17px] font-[700] tracking-[-0.01em]">{handle}</span>
          <span className="truncate text-[12.5px] text-[var(--mcc-faint)]">
            {pool.displayOnly ? 'Display example' : pool.contributionCount > 0
              ? `${pool.contributionCount} backer${pool.contributionCount === 1 ? '' : 's'}`
              : 'No backers yet'}{' '}
            {pool.clipsWaiting > 0
              ? `· ${pool.clipsWaiting} clip${pool.clipsWaiting === 1 ? '' : 's'} waiting `
              : ''}
            · {platformLabel(pool.platform)}
          </span>
        </span>
      </button>

      <div className="lb-bar flex flex-col gap-2">
        <div className="track" role="img" aria-label={barLabel}>
          {guaranteed > 0 && total > 0 ? (
            <span className="track-locked" style={{ width: `${lockedPct}%` }} />
          ) : null}
          {contestedTotal > 0 && total > 0 ? (
            <span className="hatch" style={{ width: `${100 - lockedPct}%` }} />
          ) : null}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          {total <= 0 ? (
            <>
              <span className="text-[15px] font-[700] tabular-nums text-[var(--mcc-ghost)]">$0</span>
              <span className="text-[12px] text-[var(--mcc-faint)]">No contributions yet</span>
            </>
          ) : (
            <>
              <span className="text-[15px] font-[700] tabular-nums text-[var(--mcc-live)]">
                {money(guaranteed)} {currency}
              </span>
              {contestedTotal > 0 ? (
                <span className="text-[13px] tabular-nums text-[var(--mcc-warn)]">
                  +{money(contestedTotal)} contested
                </span>
              ) : null}
              {claimed ? (
                <span className="text-[12px] text-[var(--mcc-faint)]">
                  {pool.releasedContributor > 0
                    ? `${money(pool.releasedContributor)} paid out so far`
                    : 'nothing paid out yet'}
                </span>
              ) : contestedTotal > 0 ? (
                rivals > 0 ? (
                  <span className="text-[12px] text-[var(--mcc-faint)]">
                    against {rivals} other{rivals === 1 ? '' : 's'}
                  </span>
                ) : null
              ) : (
                <span className="text-[12px] text-[var(--mcc-faint)]">all of it locked to this name</span>
              )}
            </>
          )}
        </div>
      </div>

      <span className="lb-status pip" style={{ color: pipColor }}>
        {pip}
      </span>

      {claimed ? (
        // /<handle> is an Express route, so this is a plain anchor by
        // necessity — next/link would try to resolve it in the app router.
        // It only resolves for handles the room store can actually hold
        // (rooms-store.js sanitizeHandle); a bounty handle can be a 44-char
        // mint address, and linking that is a guaranteed 404. Fall back to
        // the pool page, which always exists.
        <a
          href={poolHref(pool)}
          className="lb-cta rowcta-ghost"
        >
          View bounty
        </a>
      ) : (
        <a href={poolHref(pool)} className="lb-cta rowcta">
          View bounty
        </a>
      )}
    </div>
  )
}

export function BountyProgram() {
  const [config, setConfig] = useState<BountyClientConfig | null | 'loading'>('loading')
  const [pools, setPools] = useState<ProgramPool[]>([])
  const [totals, setTotals] = useState<{ realValue: number; displayedTotal: number } | null>(null)
  const currency = ''
  const [loadError, setLoadError] = useState('')
  const [platform, setPlatform] = useState('twitch')
  const [handle, setHandle] = useState('')
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    void getBountyConfig().then(async (cfg) => {
      setConfig(cfg)
      if (cfg?.enabled) {
        try {
          const p = await getProgram()
          setPools(p.pools)
          setTotals(p.totals)
        } catch {
          setLoadError('Bounties could not load. Refresh to retry.')
        }
      }
    })
  }, [])

  // Mirrors handleKey in bounty-store.js. Without this a space or a '#' builds
  // a URL that 400s on getPoolView, and the pool page swallows that error and
  // renders blank — the button looked like it worked and silently did nothing.
  const rawHandle = handle.trim().replace(/^@/, '')
  const wanted = platform === 'pumpfun' ? rawHandle : rawHandle.toLowerCase()
  const wantedOk = platform === 'pumpfun' ? /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(wanted) : /^[a-z0-9_.-]{1,40}$/.test(wanted)
  const startHref = wantedOk
    ? `/bounty/s/${encodeURIComponent(platform)}/${encodeURIComponent(wanted)}`
    : null
  const active = pools[selected] || pools[0] || null
  const activeGuaranteed = active?.guaranteed || 0
  const activeContested = active?.contestedTotal || 0
  const activeTotal = activeGuaranteed + activeContested
  const activeRivals = active ? rivalCount(active.contested || []) : 0
  const examples = exampleTotals(pools)
  const openCount = pools.filter((p) => !p.claimed).length

  return (
    <div className="mc-bounty dark min-h-screen">
      <header className="mcb-product-header">
        <div>
          <span className="mcb-product-brand">
            <a href="/?stay=1" className="bc">MEGACHAT</a>
            <i aria-hidden="true" />
            <span>Bounties</span>
          </span>
          <nav aria-label="Product navigation">
            <a href="/app">Rooms</a>
            <a href="/bounty" aria-current="page">Bounties</a>
            <a href="/how-it-works">How it works</a>
          </nav>
          <span className="mcb-product-actions">
            <a href="/dashboard?new=1">Create room</a>
            <AccountChip accent="var(--mcc-accent)" />
          </span>
        </div>
      </header>

      <main className="mcb-shell">
        {config === 'loading' ? (
          <div className="mcb-loading" aria-label="Loading bounties" />
        ) : !config || !config.enabled ? (
          <section className="mcb-disabled">
            <span className="mcb-coordinate">Creator bounties</span>
            <h1>Your favorite streamer doesn&rsquo;t even know you.</h1>
            <p>
              Not open yet. Soon, recorded MegaChats will stack up against streamers who
              aren&rsquo;t here, and pay out when they claim their handle and play them on stream.
            </p>
          </section>
        ) : (
          <>
            <section className="mcb-hero">
              <div>
                <span className="mcb-coordinate">Creator bounties / open</span>
                <h1>Your favorite streamer<br />doesn&rsquo;t even know you.</h1>
                <p>Be more than a username.</p>
              </div>
              {totals ? (
                <div className="mcb-totals">
                  <span><small>{examples.count ? 'Example total' : 'Ledger balance'}</small><strong>{money(examples.count ? examples.unique : totals.realValue)}</strong><em>counted once</em></span>
                  <i aria-hidden="true" />
                  <span><small>Visible across pools</small><strong>{money(examples.count ? examples.visible : totals.displayedTotal)}</strong><em>{examples.count ? 'examples only' : 'contested value repeats'}</em></span>
                </div>
              ) : null}
            </section>

            {examples.count > 0 && <p className="mcb-example-notice">Example amounts, not funded: $100 per name plus one shared $100. Funded pools replace their examples. Current ledger balance: {money(totals?.realValue || 0)}.</p>}
            {loadError && <p role="alert" className="mcb-example-notice">{loadError}</p>}

            <div className="mcb-board-layout">
              <section className="mcb-leaderboard">
                <header>
                  <div><span className="mcb-coordinate">Top targets</span><h2>Top bounties</h2></div>
                  <span className="mcb-open-count"><i /> {openCount} open pool{openCount === 1 ? '' : 's'}</span>
                </header>
                <div className="lb-head">
                  <span className="colhead">#</span>
                  <span className="colhead">Streamer</span>
                  <span className="colhead">Pool</span>
                  <span className="colhead">Status</span>
                  <span />
                </div>

                {pools.length === 0 ? (
                  <p className="mcb-empty">No active bounties. Create one for any streamer.</p>
                ) : pools.map((p, i) => (
                  <Row
                    key={p.handleKey}
                    pool={p}
                    rank={i + 1}
                    currency={currency}
                    selected={active?.handleKey === p.handleKey}
                    onSelect={() => setSelected(i)}
                  />
                ))}
              </section>

              <aside className="mcb-pool-detail">
                {active ? (
                  <>
                    <span className="mcb-coordinate">Selected pool</span>
                    <div className="mcb-detail-person">
                      <Avatar handle={active.handle || active.handleKey} platform={active.platform} avatarUrl={active.avatarUrl} />
                      <span><h2>{active.handle || active.handleKey}</h2><p>{platformLabel(active.platform)} · {active.displayOnly ? 'Display example' : `${active.contributionCount} backer${active.contributionCount === 1 ? '' : 's'}`}</p></span>
                    </div>
                    <div className="mcb-detail-total"><strong>{money(activeTotal)}</strong><span>{active.displayOnly ? 'Example, not funded' : 'potential bounty'}</span></div>
                    <div className="mcb-detail-split">
                      <span><i className="is-locked" /><b>{money(activeGuaranteed)} {currency} locked</b><small>Reserved for this streamer.</small></span>
                      <span><i className="is-contested" /><b>{money(activeContested)} {currency} contested</b><small>{activeRivals > 0 ? `${activeRivals + 1} streamers can claim this portion.` : 'No competing names.'}</small></span>
                    </div>
                    <a href={poolHref(active)} className="mcb-detail-action">Open bounty</a>
                    {!active.claimed && <a href={`${poolHref(active)}?claim=1`} className="mcb-claim-action">{active.displayOnly ? 'Preview claim setup' : 'Claim this bounty'}</a>}
                  </>
                ) : (
                  <><span className="mcb-coordinate">Selected pool</span><p className="mcb-empty">Select a bounty to see its terms.</p></>
                )}
              </aside>
            </div>

            <section className="mcb-anatomy">
              <div><span aria-hidden="true" className="track-locked" /><p><strong>Locked</strong><small>Reserved for one streamer. Released after their verified broadcast.</small></p></div>
              <div><span aria-hidden="true" className="hatch" /><p><strong>Contested</strong><small>Shared across named streamers. The first verified broadcast takes it.</small></p></div>
              <div><p><strong>Refund rules</strong><small>Declined clips refund in full. Unclaimed bounties return at expiry.</small></p></div>
            </section>

            <section className="mcb-create-bounty">
              <div>
                <span className="mcb-coordinate">Create a bounty</span>
                <h2>Add a streamer.</h2>
                <p>{START_LINE}</p>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (startHref) window.location.href = startHref
                }}
              >
                <select
                  aria-label="Platform"
                  className="field"
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value)}
                >
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {platformLabel(p)}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Streamer handle"
                  className="field"
                  placeholder="their handle"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="submit" className="btn" disabled={!startHref}>
                  Continue
                </button>
              </form>
            </section>
          </>
        )}
      </main>
    </div>
  )
}
