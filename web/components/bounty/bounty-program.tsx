'use client'

// THE BOUNTY LEADERBOARD — /bounty.
//
// One table: each nominated streamer, how much of the pool is actually
// theirs, and what a fan does next. The stacked bar is the whole argument.
// A pool's headline number is never blended: solid bounty yellow is money
// locked to that one name, the yellow hatch is money pledged to rivals as well
// and may go somewhere else entirely. A streamer who claims and then watches
// "their" pool shrink learns about restaking from the worst possible teacher,
// so the board teaches it on the way in.
//
// The top of the page shows ONE total, money pledged with each pledge
// counted once (UX sweep bo-hero): the across-pools figure, which counts a
// contested pledge per name, read as a second kind of money.

import { useEffect, useState, type KeyboardEvent } from 'react'
import { LockKeyhole } from 'lucide-react'
import { InfoTip } from '@/components/info-tip'
import { AccountChip } from '@/components/account-chip'
import { getBountyConfig, getProgram, type BountyClientConfig, type ProgramPool } from '@/lib/bounty-api'
import { exampleTotals } from '@/lib/bounty-examples'
import { formatDollars } from '@/lib/display-format'
import { BrandText } from '@/components/brand-text'
import { FeatureTag } from '@/components/feature-tag'
import { PlatformPip } from '@/components/platform-pip'
import { ThemeToggle } from '@/components/theme-toggle'

// From docs/design/copy-bank.md — the bounty page is the one surface where
// "demand more" is literally what the product does.

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


/**
 * A pasted channel link → the platform and handle in it (UX sweep bo-create).
 * The box used to want the bare handle and left Continue dead, with no reason,
 * for "twitch.tv/ninja" or "https://kick.com/xqc". Null for anything that is
 * not one of these links; the caller then treats the text as a handle.
 */
const LINK_PATTERNS: [RegExp, string][] = [
  [/^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/([^/?#\s]+)/i, 'twitch'],
  [/^(?:https?:\/\/)?(?:www\.)?kick\.com\/([^/?#\s]+)/i, 'kick'],
  [/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#\s]+)/i, 'x'],
  [/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/@([^/?#\s]+)/i, 'youtube'],
  [/^(?:https?:\/\/)?(?:www\.)?rumble\.com\/c\/([^/?#\s]+)/i, 'rumble'],
  [/^(?:https?:\/\/)?(?:www\.)?pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,64})/i, 'pumpfun'],
]
export function parseStreamerLink(raw: string): { platform: string; handle: string } | null {
  const s = raw.trim()
  for (const [re, platform] of LINK_PATTERNS) {
    const m = re.exec(s)
    if (m) return { platform, handle: decodeURIComponent(m[1]).replace(/^@/, '') }
  }
  return null
}

/** True below the width where the selected-pool panel stacks under the board. */
function useStackedPanel(): boolean {
  const [stacked, setStacked] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1120px)')
    const sync = () => setStacked(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return stacked
}

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

// The platform's own logo and colour (platform-pip.tsx), announced by name.
function PlatformMark({ platform }: { platform: string | null }) {
  return <PlatformPip platform={platform} label />
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
          className={`mc-mesh-${mesh} flex size-[46px] items-center justify-center text-[18px] font-[800]`}
        >
          {letter}
        </span>
      )}
      <span className="mcb-platform absolute -right-1 -bottom-1 flex size-5 items-center justify-center">
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
  asLink,
}: {
  pool: ProgramPool
  rank: number
  currency: string
  selected: boolean
  onSelect: () => void
  /** Where the panel stacks (≤1,120px) the name opens the pool page instead. */
  asLink: boolean
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
  // The Status column said UNCLAIMED ten times out of ten (UX sweep
  // bo-rows): a pill beside the name now, only when it is true.

  const barLabel =
    total <= 0
      ? 'Nothing pledged yet'
      : contestedTotal > 0
        ? `${formatDollars(guaranteed)} ${currency} locked to this name, ${formatDollars(contestedTotal)} ${currency} also pledged to ${rivals} other ${rivals === 1 ? 'streamer' : 'streamers'}`
        : `${formatDollars(guaranteed)} ${currency}, all locked to this name`

  return (
    <div className={`lb-row${claimed ? ' is-claimed' : ''}${selected ? ' is-selected' : ''}`}>
      <span
        className="lb-rank text-[17px] font-[800] tabular-nums"
        style={{ color: rank <= 3 && !claimed ? 'var(--f-bounty-ink)' : 'var(--mcc-ghost)' }}
      >
        {String(rank).padStart(2, '0')}
      </span>

      {(() => {
        const who = (
          <>
            <Avatar handle={handle} platform={pool.platform} avatarUrl={pool.avatarUrl} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[17px] font-[700] tracking-[-0.01em]">{handle}</span>
                {claimed ? <span className="mcb-claimed-pill">Claimed</span> : null}
              </span>
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
          </>
        )
        // Where the panel stacks, a tap on the name opens the pool itself
        // (UX sweep bo-mobile-select): the panel it used to fill sat 2,000px
        // below the tap.
        return asLink ? (
          <a href={poolHref(pool)} className="lb-who flex min-w-0 items-center gap-3.5 text-left">{who}</a>
        ) : (
          <button type="button" className="lb-who flex min-w-0 items-center gap-3.5 text-left" onClick={onSelect} aria-pressed={selected}>{who}</button>
        )
      })()}

      <div className="lb-bar flex flex-col gap-2">
        <div className="track" role="img" aria-label={barLabel}>
          {guaranteed > 0 && total > 0 ? (
            <span className="track-locked" style={{ width: `${lockedPct}%` }}>
              {/* The lock sits on the locked money itself, on every bar that
                  has some (UX sweep bo-lock-marks). */}
              <span className="track-lock" title="Locked: theirs alone once they claim.">
                <LockKeyhole size={12} aria-hidden="true" />
              </span>
            </span>
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
              <span className="text-[15px] font-[700] tabular-nums text-f-bounty-ink">
                {formatDollars(guaranteed)} {currency}
              </span>
              {contestedTotal > 0 ? (
                <span className="text-[13px] tabular-nums text-f-bounty-ink">
                  +{formatDollars(contestedTotal)} contested
                </span>
              ) : null}
              {claimed ? (
                <span className={`text-[12px] ${pool.releasedContributor > 0 ? 'text-f-rewards-ink' : 'text-[var(--mcc-faint)]'}`}>
                  {pool.releasedContributor > 0
                    ? `${formatDollars(pool.releasedContributor)} paid out so far`
                    : 'nothing paid out yet'}
                </span>
              ) : contestedTotal > 0 && rivals > 0 ? (
                <span className="text-[12px] text-[var(--mcc-faint)]">
                  against {rivals} other{rivals === 1 ? '' : 's'}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>

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
  const stacked = useStackedPanel()
  // Search-as-you-type over the pools that already exist (owner note on
  // bo-create: "should be able to search, paste link, etc").
  const [searchOpen, setSearchOpen] = useState(false)
  const [activeMatch, setActiveMatch] = useState(-1)

  const loadProgram = async () => {
    setLoadError('')
    try {
      const p = await getProgram()
      // Ranked by the figure each row leads with (UX sweep bo-rows): locked
      // money, then contested, then backers. The server's order counted a
      // shared pledge only on the name it was anchored to.
      setPools([...p.pools].sort((a, b) =>
        (b.guaranteed || 0) - (a.guaranteed || 0)
        || (b.contestedTotal || 0) - (a.contestedTotal || 0)
        || (b.contributionCount || 0) - (a.contributionCount || 0)))
      setTotals(p.totals)
    } catch {
      setLoadError('Couldn’t load the bounties.')
    }
  }

  useEffect(() => {
    void getBountyConfig().then(async (cfg) => {
      setConfig(cfg)
      if (cfg?.enabled) await loadProgram()
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
  const query = rawHandle.toLowerCase()
  const matches = query
    ? pools.filter((p) => !p.displayOnly && (p.handle || p.handleKey).toLowerCase().includes(query)).slice(0, 6)
    : []
  const showMatches = searchOpen && matches.length > 0

  function onHandleInput(value: string) {
    // A pasted channel link fills the platform and the handle from it.
    const link = parseStreamerLink(value)
    if (link) {
      setPlatform(link.platform)
      setHandle(link.handle)
    } else {
      setHandle(value)
    }
    setSearchOpen(true)
    setActiveMatch(-1)
  }
  function onHandleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (!showMatches) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveMatch((i) => (i + 1) % matches.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveMatch((i) => (i <= 0 ? matches.length - 1 : i - 1)) }
    else if (e.key === 'Escape') { setSearchOpen(false); setActiveMatch(-1) }
    else if (e.key === 'Enter' && activeMatch >= 0 && matches[activeMatch]) {
      e.preventDefault()
      window.location.href = poolHref(matches[activeMatch])
    }
  }
  const active = pools[selected] || pools[0] || null
  const activeGuaranteed = active?.guaranteed || 0
  const activeContested = active?.contestedTotal || 0
  const activeTotal = activeGuaranteed + activeContested
  const activeRivals = active ? rivalCount(active.contested || []) : 0
  const examples = exampleTotals(pools)
  const openCount = pools.filter((p) => !p.claimed).length

  return (
    <div className="mc-bounty min-h-screen">
      <header className="mcb-product-header">
        <div>
          <span className="mcb-product-brand">
            <a href="/?stay=1" className="bc" aria-label="Holler home"><BrandText /></a>
            <i aria-hidden="true" />
            <span><FeatureTag kind="bounty">Bounties</FeatureTag></span>
          </span>
          <nav aria-label="Product navigation">
            <a href="/app">Rooms</a>
            <a href="/bounty" aria-current="page">Bounties</a>
            <a href="/how-it-works">How it works</a>
          </nav>
          <span className="mcb-product-actions">
            <a href="/dashboard">Create room</a>
            <ThemeToggle />
            <AccountChip accent="var(--f-bounty-ui)" />
          </span>
        </div>
      </header>

      <main className="mcb-shell">
        {config === 'loading' ? (
          <div className="mcb-loading" aria-label="Loading bounties" />
        ) : !config || !config.enabled ? (
          <section className="mcb-disabled">
            <h1>Your favorite streamer doesn&rsquo;t even know you.</h1>
            <p>
              Not open yet. Soon, recorded Hollers will stack up against streamers who
              aren&rsquo;t here, and pay out when they claim their handle and play them on stream.
            </p>
          </section>
        ) : (
          <>
            {/* The ask, the action and one total, above the fold (UX sweep
                bo-hero). The Add a streamer form moved up from the foot of
                the page; "Visible across pools" is gone: two figures $200
                apart read as two kinds of money. */}
            <section className="mcb-hero">
              <div>
                <h1>Your favorite streamer<br />doesn&rsquo;t even know you.</h1>
                <p>Be more than a username.</p>
                <p className="mcb-hero-ask">Record a Holler, put money on it, and tell your favorite streamer to come claim it.</p>
                {totals && !loadError ? (
                  <p className="mcb-hero-total">
                    <strong>{formatDollars(examples.count ? examples.unique : totals.realValue)}</strong> pledged{examples.count ? ' (examples)' : ''}
                  </p>
                ) : null}
              </div>

              <div className="mcb-create-bounty">
                <span className="mcb-step-chip">Step 1 of 2</span>
                <h2>Add a streamer.</h2>
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
                  <div className="mcb-search">
                    <input
                      aria-label="Streamer handle or channel link"
                      className="field"
                      placeholder="handle, link or search"
                      value={handle}
                      onChange={(e) => onHandleInput(e.target.value)}
                      onKeyDown={onHandleKey}
                      onFocus={() => setSearchOpen(true)}
                      onBlur={() => setTimeout(() => setSearchOpen(false), 120)}
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded={showMatches}
                      aria-controls="mcb-search-list"
                      aria-activedescendant={showMatches && activeMatch >= 0 ? `mcb-search-${activeMatch}` : undefined}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {showMatches ? (
                      <ul id="mcb-search-list" role="listbox" aria-label="Streamers with a bounty" className="mcb-search-list">
                        {matches.map((m, i) => (
                          <li key={m.handleKey} id={`mcb-search-${i}`} role="option" aria-selected={i === activeMatch}>
                            <a href={poolHref(m)} className={i === activeMatch ? 'is-active' : undefined}
                              onMouseDown={(e) => e.preventDefault()}>
                              <span className="mcb-search-name">{m.handle || m.handleKey}</span>
                              <span className="mcb-search-meta">{platformLabel(m.platform)} · {formatDollars(m.guaranteed || 0)} locked</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <button type="submit" className="btn" disabled={!startHref}>
                    Continue
                  </button>
                </form>
              </div>
            </section>

            {examples.count > 0 && !loadError && <p className="mcb-example-notice">Example amounts, not funded: $100 per name plus one shared $100. Funded pools replace their examples. Current ledger balance: {formatDollars(totals?.realValue || 0)}.</p>}

            <div className="mcb-board-layout">
              <section className="mcb-leaderboard">
                <header>
                  <div><h2>Top bounties</h2></div>
                  {loadError ? null : <span className="mcb-open-count"><i /> {openCount} open pool{openCount === 1 ? '' : 's'}</span>}
                </header>
                {/* A failed load is not an empty board (UX sweep
                    js-pool-fail-silent): no count, no "no bounties", one line
                    and Retry in the table's place. */}
                {loadError ? (
                  <div role="alert" className="mcb-load-error">
                    <p>{loadError}</p>
                    <button type="button" className="btn" onClick={() => void loadProgram()}>Retry</button>
                  </div>
                ) : (
                  <>
                    <div className="lb-head">
                      <span className="colhead">#</span>
                      <span className="colhead">Streamer</span>
                      {/* The key lives on the column it explains (UX sweep
                          bo-lock-marks), not in a legend a screen below. */}
                      <span className="lb-head-pool">
                        <span className="colhead">Pool · by locked</span>
                        <span className="mcb-key">
                          <span><i aria-hidden="true" className="track-locked" />Locked <InfoTip label="About locked money" text="Reserved for one streamer. Released after their verified broadcast." /></span>
                          <span><i aria-hidden="true" className="hatch" />Contested <InfoTip label="About contested money" text="Shared across named streamers. The first verified broadcast takes it." /></span>
                          <span><span className="mcb-refundable">Refundable</span> <InfoTip label="About refunds" text="Declined clips refund in full. Unclaimed bounties return at expiry." /></span>
                        </span>
                      </span>
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
                        selected={!stacked && active?.handleKey === p.handleKey}
                        onSelect={() => setSelected(i)}
                        asLink={stacked}
                      />
                    ))}
                  </>
                )}
              </section>

              <aside className="mcb-pool-detail">
                {active ? (
                  <>
                    <div className="mcb-detail-person">
                      <Avatar handle={active.handle || active.handleKey} platform={active.platform} avatarUrl={active.avatarUrl} />
                      <span><h2>{active.handle || active.handleKey}</h2><p>{platformLabel(active.platform)} · {active.displayOnly ? 'Display example' : `${active.contributionCount} backer${active.contributionCount === 1 ? '' : 's'}`}</p></span>
                    </div>
                    {/* The recorded clips stacked against this name are Hollers. */}
                    {active.clipsWaiting > 0 ? (
                      <div className="mcb-detail-tags">
                        <FeatureTag kind="holler">
                          {active.clipsWaiting} clip{active.clipsWaiting === 1 ? '' : 's'} waiting
                        </FeatureTag>
                      </div>
                    ) : null}
                    <div className="mcb-detail-total"><strong>{formatDollars(activeTotal)}</strong><span>{active.displayOnly ? 'Example, not funded' : 'potential bounty'}</span></div>
                    <div className="mcb-detail-split">
                      <span><i className="is-locked" /><b>{formatDollars(activeGuaranteed)} {currency} locked</b></span>
                      <span><i className="is-contested" /><b>{formatDollars(activeContested)} {currency} contested</b><small>{activeRivals > 0 ? `${activeRivals + 1} streamers can claim this portion.` : 'No competing names.'}</small></span>
                    </div>
                    <a href={poolHref(active)} className="mcb-detail-action">Open bounty</a>
                    {!active.claimed && <a href={`${poolHref(active)}?claim=1`} className="mcb-claim-action">{active.displayOnly ? 'Preview claim setup' : 'Claim this bounty'}</a>}
                  </>
                ) : (
                  <><p className="mcb-empty">Select a bounty to see its terms.</p></>
                )}
              </aside>
            </div>

          </>
        )}
      </main>
    </div>
  )
}
