'use client'

// THE BOUNTY LEADERBOARD — /bounty.
//
// One table: who has money waiting on their name, how much of it is actually
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

// From docs/design/copy-bank.md — the bounty page is the one surface where
// "demand more" is literally what the product does.
const DEMAND_LINE = 'Record a MegaChat, put money on it, and tell your favorite streamer to come claim it.'

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

function money(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
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

function Row({ pool, rank, currency }: { pool: ProgramPool; rank: number; currency: string }) {
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

  const pip = claimed ? 'Claimed' : seeded ? 'Seeded' : quiet ? 'Open' : 'Unclaimed'
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
    <div className={`lb-row${claimed ? ' is-claimed' : ''}`}>
      <span
        className="lb-rank text-[17px] font-[800] tabular-nums"
        style={{ color: rank <= 3 && !claimed ? 'var(--mcc-accent)' : 'var(--mcc-ghost)' }}
      >
        {String(rank).padStart(2, '0')}
      </span>

      <div className="lb-who flex min-w-0 items-center gap-3.5">
        <Avatar handle={handle} platform={pool.platform} avatarUrl={pool.avatarUrl} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[17px] font-[700] tracking-[-0.01em]">{handle}</span>
          <span className="truncate text-[12.5px] text-[var(--mcc-faint)]">
            {pool.contributionCount > 0
              ? `${pool.contributionCount} backer${pool.contributionCount === 1 ? '' : 's'}`
              : 'No backers yet'}{' '}
            {pool.clipsWaiting > 0
              ? `· ${pool.clipsWaiting} clip${pool.clipsWaiting === 1 ? '' : 's'} waiting `
              : ''}
            · {platformLabel(pool.platform)}
          </span>
        </span>
      </div>

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
              <span className="text-[15px] font-[700] tabular-nums text-[var(--mcc-ghost)]">0 {currency}</span>
              <span className="text-[12px] text-[var(--mcc-faint)]">be the first to put money on this name</span>
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
          href={ROOM_HANDLE.test(handle) ? `/${encodeURIComponent(handle)}` : poolHref(pool)}
          className="lb-cta rowcta-ghost"
        >
          {ROOM_HANDLE.test(handle) ? 'Watch the room' : 'See the pool'}
        </a>
      ) : (
        <a href={poolHref(pool)} className="lb-cta rowcta">
          Put money on it
        </a>
      )}
    </div>
  )
}

export function BountyProgram() {
  const [config, setConfig] = useState<BountyClientConfig | null | 'loading'>('loading')
  const [pools, setPools] = useState<ProgramPool[]>([])
  const [totals, setTotals] = useState<{ realValue: number; displayedTotal: number } | null>(null)
  const [currency, setCurrency] = useState('USDC')
  const [platform, setPlatform] = useState('twitch')
  const [handle, setHandle] = useState('')

  useEffect(() => {
    void getBountyConfig().then(async (cfg) => {
      setConfig(cfg)
      if (cfg?.enabled) {
        try {
          const p = await getProgram()
          setPools(p.pools)
          setTotals(p.totals)
          setCurrency(p.currency)
        } catch {
          /* renders empty-state */
        }
      }
    })
  }, [])

  // Mirrors handleKey in bounty-store.js. Without this a space or a '#' builds
  // a URL that 400s on getPoolView, and the pool page swallows that error and
  // renders blank — the button looked like it worked and silently did nothing.
  const wanted = handle.trim().replace(/^@/, '').toLowerCase()
  const wantedOk = /^[a-z0-9_.-]{1,40}$/.test(wanted)
  const startHref = wantedOk
    ? `/bounty/s/${encodeURIComponent(platform)}/${encodeURIComponent(wanted)}`
    : null

  return (
    <div className="mc-bounty dark min-h-screen">
      {/* the only chrome: one thin bar, same as the room board */}
      <header className="border-b border-[#1a1a1f]">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-3 px-5 py-3">
          <span className="flex flex-wrap items-baseline gap-3.5">
            <a href="/app" className="bc text-[18px] font-bold tracking-[0.1em] text-[var(--mcc-fg)]">
              MEGACHAT
            </a>
            <span className="text-[13px] font-semibold text-[var(--mcc-dim)]">Bounties</span>
          </span>
          <AccountChip accent="var(--mcc-accent)" />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-7 px-5 pt-9 pb-14">
        {config === 'loading' ? (
          <div className="h-40 animate-pulse bg-white/5" aria-hidden="true" />
        ) : !config || !config.enabled ? (
          <div className="border border-[var(--mcc-rule)] bg-[var(--mcc-sunk)] px-6 py-12 text-center">
            <h1 className="text-[26px] font-[800] tracking-[-0.02em]">
              Your favorite streamer doesn&rsquo;t even know you.
            </h1>
            <p className="mx-auto mt-2 max-w-[440px] text-[14px] leading-[1.5] text-[var(--mcc-muted)]">
              Not open yet. Soon, recorded MegaChats will stack up against streamers who
              aren&rsquo;t here, and pay out when they claim their handle and play them on stream.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-8">
              <div className="flex max-w-[620px] flex-col gap-2.5">
                <h1 className="text-[32px] leading-[1.05] font-[800] tracking-[-0.02em] md:text-[40px]">
                  Your favorite streamer doesn&rsquo;t even know you.
                </h1>
                <p className="text-[17px] font-[600] leading-[1.4] text-[var(--mcc-muted)]">
                  Be more than a username.
                </p>
              </div>

              {/* Two numbers, two labels, never added together: one escrow per
                  pledge vs. what every pool page adds up to. */}
              {totals ? (
                <div className="flex flex-wrap gap-10">
                  <div className="flex flex-col gap-1">
                    <span className="colhead">In escrow</span>
                    <span className="text-[26px] font-[800] tabular-nums">
                      {money(totals.realValue)}{' '}
                      <span className="text-[13px] font-[600] text-[var(--mcc-dim)]">{currency}</span>
                    </span>
                    <span className="text-[12px] text-[var(--mcc-faint)]">real, counted once</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="colhead">Across pools</span>
                    <span className="text-[26px] font-[800] tabular-nums text-[var(--mcc-warn)]">
                      {money(totals.displayedTotal)}{' '}
                      <span className="text-[13px] font-[600] text-[var(--mcc-dim)]">{currency}</span>
                    </span>
                    <span className="text-[12px] text-[var(--mcc-faint)]">contested money counted per name</span>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex flex-col">
              <div className="lb-head">
                <span className="colhead">#</span>
                <span className="colhead">Streamer</span>
                <span className="colhead">Pledged</span>
                <span className="colhead">Status</span>
                <span />
              </div>

              {pools.length === 0 ? (
                <p className="border-b border-[var(--mcc-hairline)] py-6 text-[14px] text-[var(--mcc-muted)]">
                  Nobody has money on their name yet. Any handle can be the first.
                </p>
              ) : (
                pools.map((p, i) => (
                  <Row key={p.handleKey} pool={p} rank={i + 1} currency={currency} />
                ))
              )}
            </div>

            {/* The abbreviated version of the anatomy sheet: what the two
                halves of the bar mean, one line each. */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 pt-1">
              <span className="flex items-center gap-2 text-[12.5px] text-[var(--mcc-muted)]">
                <span aria-hidden="true" className="track-locked h-2 w-[22px] shrink-0" />
                Locked to this name only
              </span>
              <span className="flex items-center gap-2 text-[12.5px] text-[var(--mcc-muted)]">
                <span aria-hidden="true" className="hatch h-2 w-[22px] shrink-0" />
                Also pledged to rivals — whoever airs first takes it
              </span>
            </div>

            {/* Restored deliberately. These three are the reasons pledging is
                safe, and they were the only place on the site that said so —
                /how-it-works covers paid sessions, not bounties. A page that
                takes money states its refund terms on the page. */}
            <div className="flex flex-wrap gap-x-8 gap-y-2.5 border-t border-[var(--mcc-rule)] pt-4 text-[12.5px] text-[var(--mcc-muted)]">
              <span>Nothing airs without the streamer approving it.</span>
              <span>A declined clip refunds you in full.</span>
              <span>Nobody claims it before your expiry, you get it all back.</span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-5 border border-[var(--mcc-rule)] bg-[var(--mcc-sunk)] px-6 py-[22px]">
              <div className="flex max-w-[640px] flex-col gap-1.5">
                <span className="text-[19px] font-[700] tracking-[-0.01em]">Don&rsquo;t see them? Demand them.</span>
                <span className="text-[14px] leading-[1.5] text-[var(--mcc-muted)]">{DEMAND_LINE}</span>
              </div>
              <form
                className="flex flex-wrap items-center gap-2"
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
                  className="field w-[180px]"
                  placeholder="their handle"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="submit" className="btn" disabled={!startHref}>
                  Start a pool
                </button>
              </form>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
