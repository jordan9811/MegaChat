'use client'

// /account — the account surface as a page of its own.
//
// It used to exist only inside the dashboard (?section=account), and
// dashboard-shell returns the CREATE form whenever mode !== 'managing' — so a
// signed-in person who owns zero rooms could never reach their own handle,
// their linked sign-ins, their balance, or the way out. Nothing here needs a
// room to exist, so nothing here is behind one.
//
// Same state as the header chip (one hook, so the two can never disagree
// about whether you are signed in) and the same endpoints the dashboard
// panel calls — this is a second skin, not a second implementation.

import { useCallback, useEffect, useState } from 'react'
import { AccountChip } from '@/components/account-chip'
import {
  getAccountDefaults,
  listLinkedAccounts,
  saveAccountDefaults,
  type LinkedAccount,
} from '@/lib/api'
import { shortAddr, useAccount } from '@/lib/use-account'

const PROVIDER_LABEL: Record<string, string> = {
  twitch: 'Twitch',
  twitter: 'X (Twitter)',
  x: 'X (Twitter)',
  google: 'Google',
  discord: 'Discord',
  tiktok: 'TikTok',
  email: 'Email',
  passkey: 'Passkey',
  wallet: 'Wallet',
  privy: 'Privy',
}

function providerLabel(type: string) {
  return PROVIDER_LABEL[type] || type
}

// Human summary of a saved defaults blob — only fields worth glancing at.
function defaultsSummary(d: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = []
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null)
  const b = (k: string) => (typeof d[k] === 'boolean' ? (d[k] as boolean) : null)
  const price = s('passkeyTickPrice')
  if (price != null) rows.push(['Price / second', price === '0' ? 'Free room' : `${price} USDC`])
  const secs = s('passkeyTickSeconds')
  if (secs != null && secs !== '1') rows.push(['Charge interval', `${secs}s`])
  const cap = s('maxSession')
  if (cap != null) rows.push(['Session cap', `${cap} USDC`])
  const t = s('transport')
  if (t != null) rows.push(['Transport', t === 'livekit' ? 'LiveKit (default)' : 'vdo.ninja'])
  const mc = b('lettersEnabled')
  if (mc != null) rows.push(['MegaChats', mc ? 'On' : 'Off'])
  const js = b('joinStreamEnabled')
  if (js != null) rows.push(['Join Stream', js ? 'On' : 'Off'])
  const sfx = b('stingerSounds')
  if (sfx != null) rows.push(['Stinger sounds', sfx ? 'On' : 'Off'])
  const tw = s('twitchChannel')
  if (tw) rows.push(['Twitch channel', tw])
  return rows
}

export function AccountPage() {
  const {
    loaded,
    identity,
    wallet,
    balance,
    signedIn,
    openSignIn,
    connectBalance,
    connectingBalance,
    signOut,
  } = useAccount()

  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null)
  const [defaults, setDefaults] = useState<Record<string, unknown> | null>(null)
  const [defaultsLoaded, setDefaultsLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [origin, setOrigin] = useState('')

  useEffect(() => setOrigin(window.location.origin), [])

  // Both endpoints are authorized by the identity cookie, so a wallet-only
  // session has nothing to ask for.
  useEffect(() => {
    if (!identity) return
    listLinkedAccounts()
      .then((d) => setAccounts(d.accounts))
      .catch(() => setAccounts([]))
    getAccountDefaults()
      .then((d) => setDefaults(d.defaults))
      .catch(() => {})
      .finally(() => setDefaultsLoaded(true))
  }, [identity])

  const clearDefaults = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      await saveAccountDefaults(null)
      setDefaults(null)
      setNote('Cleared — new rooms start from the stock settings')
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Failed — try again')
    } finally {
      setBusy(false)
    }
  }, [])

  const roomLink = identity ? `${origin}/${identity.handle}` : ''

  const copyLink = useCallback(async () => {
    if (!roomLink) return
    try {
      await navigator.clipboard.writeText(roomLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the link is on screen either way */
    }
  }, [roomLink])

  const rows = defaults ? defaultsSummary(defaults) : []

  return (
    <div className="mc-account dark min-h-screen">
      {/* the only chrome: one thin bar, same as the room board */}
      <header className="border-b border-[#1a1a1f]">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-3 px-5 py-3">
          <span className="flex flex-wrap items-baseline gap-3.5">
            <a href="/app" className="bc text-[18px] font-bold tracking-[0.1em] text-[var(--mcc-fg)]">
              MEGACHAT
            </a>
            <span className="text-[13px] font-semibold text-[var(--mcc-dim)]">Account</span>
          </span>
          <AccountChip accent="var(--mcc-accent)" />
        </div>
      </header>

      {!loaded ? (
        <div className="mx-auto w-full max-w-[1400px] px-5 py-8">
          <p className="hint">Loading…</p>
        </div>
      ) : !signedIn ? (
        <main className="mx-auto w-full max-w-[1400px] px-5 py-8">
          <div className="flex max-w-[620px] flex-col items-start gap-4 border border-dashed border-[var(--mcc-rule-2)] px-7 py-9">
            <h1 className="text-[26px] font-bold leading-[1.15]">Sign in to see your account</h1>
            <p className="hint">
              Your handle, the sign-ins linked to it, your balance and your saved room defaults
              all live here. You do not need a room to have an account.
            </p>
            <button
              type="button"
              onClick={openSignIn}
              disabled={wallet.modalOpen}
              title={
                wallet.configured
                  ? 'Twitch, X, Google, email or passkey'
                  : 'Sign-in is not configured on this server'
              }
              className="btn"
            >
              {wallet.modalOpen ? 'Opening…' : 'Sign in'}
            </button>
          </div>
        </main>
      ) : (
        <main className="mx-auto grid w-full max-w-[1400px] grid-cols-1 lg:grid-cols-[1.5fr_1fr]">
          {/* ─────────── LEFT: who you are ─────────── */}
          <div className="flex min-w-0 flex-col gap-8 border-b border-[var(--mcc-rule)] p-5 lg:border-b-0 lg:border-r">
            <section className="flex flex-col gap-3">
              {identity ? (
                <>
                  <span className="flex flex-wrap items-baseline gap-3">
                    <h1 className="handle text-[28px] font-bold leading-none">
                      @{identity.handle}
                    </h1>
                    <span className="pip text-[var(--mcc-dim)]">PERMANENT</span>
                  </span>
                  <p className="hint max-w-[560px]">
                    Your handle is your room link. It is claimed once, at sign-in, and never
                    changes.
                  </p>
                  <div className="flex flex-wrap items-center gap-2 border border-[var(--mcc-rule-2)] bg-[var(--mcc-sunk)] px-3 py-2">
                    <span className="lbl">Link</span>
                    <code className="min-w-0 flex-1 truncate text-[13px] text-[var(--mcc-muted)]">
                      {roomLink || `/${identity.handle}`}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyLink()}
                      aria-label="Copy your room link"
                      className="btn-ghost"
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    {/* /<handle> is an Express route, not a Next page */}
                    <a href={`/${identity.handle}`} className="btn-ghost">
                      Open
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <h1 className="text-[26px] font-bold leading-none">Wallet only</h1>
                  <p className="hint max-w-[560px]">
                    This session is a wallet with no handle yet. Sign in with Twitch, X, Google,
                    email or a passkey to claim one — the handle becomes your permanent room link.
                  </p>
                </>
              )}
            </section>

            {identity ? (
              <section className="flex flex-col gap-3">
                <h2 className="sect">Linked sign-ins</h2>
                {accounts == null ? (
                  <p className="hint">Loading…</p>
                ) : accounts.length === 0 ? (
                  <p className="hint">
                    Nothing linked yet — sign-ins you add through the login modal appear here.
                  </p>
                ) : (
                  <ul id="linked-accounts" className="flex flex-col">
                    <li className="flex items-baseline justify-between gap-4 pb-1.5">
                      <span className="colhead">PROVIDER</span>
                      <span className="colhead">ACCOUNT</span>
                    </li>
                    {accounts.map((a, i) => (
                      <li key={`${a.type}-${i}`} className="row">
                        <span className="text-[13.5px] font-semibold">{providerLabel(a.type)}</span>
                        <span className="val min-w-0 truncate text-[var(--mcc-muted)]">
                          {a.name || '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}

            {identity ? (
              <section className="flex flex-col gap-3">
                <h2 className="sect">Default room settings</h2>
                <p className="hint max-w-[560px]">
                  New rooms start from these instead of blank. They are saved from the create
                  form, and they follow your account rather than this browser.
                </p>
                {!defaultsLoaded ? (
                  <p className="hint">Loading…</p>
                ) : rows.length > 0 ? (
                  <ul id="defaults-summary" className="flex flex-col">
                    {rows.map(([k, v]) => (
                      <li key={k} className="row">
                        <span className="lbl">{k}</span>
                        <span className="val">{v}</span>
                      </li>
                    ))}
                  </ul>
                ) : defaults ? (
                  // keeps the id present whenever defaults exist, matching the
                  // legacy panel — anything anchoring on it stays valid
                  <p id="defaults-summary" className="hint">
                    Defaults are saved, but none of them differ from stock.
                  </p>
                ) : (
                  <p className="hint">
                    No defaults saved yet — every new room starts from the stock settings.
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <a href="/dashboard?new=1" className="btn-ghost">
                    Open the create form
                  </a>
                  {defaults ? (
                    <button
                      type="button"
                      id="clear-defaults"
                      disabled={busy}
                      onClick={() => void clearDefaults()}
                      className="btn-ghost"
                    >
                      {busy ? 'Clearing…' : 'Clear defaults'}
                    </button>
                  ) : null}
                </div>
                {note ? <p className="hint">{note}</p> : null}
              </section>
            ) : null}
          </div>

          {/* ─────────── RIGHT: money and the way out ─────────── */}
          <aside className="flex min-w-0 flex-col gap-8 p-5">
            <section className="flex flex-col gap-3">
              <h2 className="sect">Balance</h2>
              {wallet.address ? (
                <>
                  <div className="border border-[var(--mcc-rule-2)] bg-[var(--mcc-sunk)] px-4 py-3">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="lbl">Available</span>
                      <span className="text-[19px] font-bold tabular-nums">
                        {balance == null ? (
                          '…'
                        ) : (
                          <>
                            <span className="adv-only">{balance} USDC</span>
                            <span className="simple-only">${balance}</span>
                          </>
                        )}
                      </span>
                    </span>
                    <span
                      className="mt-1 block text-[11px] text-[var(--mcc-faint)]"
                      title={wallet.address}
                    >
                      {shortAddr(wallet.address)}
                    </span>
                  </div>
                  <p className="hint">
                    Seats bill against this by the second. Whatever you do not use comes back.
                  </p>
                </>
              ) : (
                <>
                  <p className="hint">
                    No wallet connected — connect one to take a seat or send a MegaChat.
                  </p>
                  <button
                    type="button"
                    onClick={() => void connectBalance()}
                    disabled={!wallet.configured || connectingBalance}
                    title={
                      wallet.configured
                        ? 'Connect the wallet that pays for seats'
                        : 'Wallet service not configured on this server'
                    }
                    className="btn-ghost self-start"
                  >
                    {connectingBalance ? 'Connecting…' : 'Connect balance'}
                  </button>
                </>
              )}
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="sect">Elsewhere</h2>
              <ul className="flex flex-col">
                <li className="row">
                  <a href="/dashboard" className="text-[13.5px] font-semibold hover:underline">
                    Your room
                  </a>
                  <span className="val text-[var(--mcc-faint)]">Dashboard</span>
                </li>
                <li className="row">
                  <a href="/dashboard?new=1" className="text-[13.5px] font-semibold hover:underline">
                    Open a new room
                  </a>
                  <span className="val text-[var(--mcc-faint)]">Create</span>
                </li>
                <li className="row">
                  <a href="/app" className="text-[13.5px] font-semibold hover:underline">
                    Room board
                  </a>
                  <span className="val text-[var(--mcc-faint)]">Browse</span>
                </li>
              </ul>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="sect">Session</h2>
              <p className="hint">
                Signs out of both halves — the site cookie and the wallet session.
              </p>
              <button
                type="button"
                onClick={() => void signOut()}
                className="btn-ghost self-start"
              >
                Sign out
              </button>
            </section>
          </aside>
        </main>
      )}
    </div>
  )
}
