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
import { formatDollars } from '@/lib/display-format'
import { BrandText } from '@/components/brand-text'

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
  if (price != null) rows.push(['Price / second', price === '0' ? 'Free room' : formatDollars(Number(price) / (Number(s('passkeyTickSeconds')) || 1))])
  const secs = s('passkeyTickSeconds')
  if (secs != null && secs !== '1') rows.push(['Charge interval', `${secs}s`])
  const cap = s('maxSession')
  if (cap != null) rows.push(['Session cap', formatDollars(cap)])
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
    authError,
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
  const [section, setSection] = useState<'overview' | 'defaults' | 'connections'>('overview')

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
      <header className="mcc-product-header">
        <div>
          <span className="mcc-product-brand">
            <a href="/?stay=1" className="bc"><BrandText /></a>
            <i aria-hidden="true" />
            <span>Account</span>
          </span>
          <nav aria-label="Product navigation">
            <a href="/app">Rooms</a>
            <a href="/bounty">Bounties</a>
            <a href="/how-it-works">How it works</a>
          </nav>
          <span className="mcc-product-actions">
            <a href="/dashboard?new=1">Create room</a>
            <AccountChip accent="var(--mcc-accent)" />
          </span>
        </div>
      </header>

      {!loaded ? (
        <div className="mx-auto w-full max-w-[1400px] px-5 py-8">
          <p className="hint">Loading…</p>
        </div>
      ) : !signedIn ? (
        <main className="mcc-signed-out mx-auto w-full max-w-[1400px] px-5 py-12">
          <div>
            <span className="mcc-coordinate">Identity / private</span>
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
            {authError && <p role="alert" className="hint">{authError}</p>}
          </div>
        </main>
      ) : (
        <main className="mcc-account-shell">
          <section className="mcc-identity-hero">
            <div>
              <span className="mcc-coordinate">Identity / permanent</span>
              <h1>{identity ? `@${identity.handle}` : 'Wallet only'}</h1>
              <p>{identity
                ? 'Your handle is your room link everywhere MegaChat appears.'
                : 'Add a sign-in to claim a permanent handle and room link.'}</p>
            </div>
            {identity ? (
              <div className="mcc-room-link">
                <span>{roomLink || `/${identity.handle}`}</span>
                <button type="button" onClick={() => void copyLink()} aria-label="Copy your room link">
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <a href={`/${identity.handle}`}>Open</a>
              </div>
            ) : (
              <button type="button" className="btn" onClick={openSignIn}>Add a sign-in</button>
            )}
          </section>

          <div className="mcc-account-layout">
            <nav className="mcc-section-nav" aria-label="Account sections">
              <div>
                <span>Account</span>
                <button type="button" aria-current={section === 'overview' ? 'page' : undefined} onClick={() => setSection('overview')}>Overview</button>
                <button type="button" aria-current={section === 'defaults' ? 'page' : undefined} onClick={() => setSection('defaults')}>Room defaults</button>
                <button type="button" aria-current={section === 'connections' ? 'page' : undefined} onClick={() => setSection('connections')}>Connections</button>
              </div>
              <div className="mcc-nav-links">
                <span>Go to</span>
                <a href="/dashboard">Your room</a>
                <a href="/dashboard?new=1">Open a new room</a>
                <a href="/app">Room board</a>
              </div>
              <button type="button" className="mcc-signout" onClick={() => void signOut()}>Sign out</button>
            </nav>

            <section className="mcc-account-work">
              {section === 'overview' ? (
                <div className="mcc-overview-grid">
                  <section className="mcc-balance-zone">
                    <span className="mcc-coordinate">Available balance</span>
                    <strong>
                      {balance == null ? '…' : <><b>$</b>{balance}</>}
                    </strong>
                    <p>{wallet.address ? shortAddr(wallet.address) : 'No balance connected'}</p>
                    {!wallet.address ? (
                      <button
                        type="button"
                        onClick={() => void connectBalance()}
                        disabled={!wallet.configured || connectingBalance}
                      >
                        {connectingBalance ? 'Connecting…' : 'Connect balance'}
                      </button>
                    ) : <a href="/app">Use balance in a room</a>}
                  </section>

                  <section className="mcc-room-zone">
                    <span className="mcc-coordinate">Your room address</span>
                    <strong>{identity ? `/${identity.handle}` : 'Unclaimed'}</strong>
                    <p>{identity ? 'Permanent, shareable, and ready whenever you go live.' : 'Link a sign-in to claim it.'}</p>
                    <a href={identity ? '/dashboard' : '#connections'} onClick={identity ? undefined : () => setSection('connections')}>
                      {identity ? 'Open dashboard' : 'View connections'}
                    </a>
                  </section>

                  <section className="mcc-overview-status">
                    <header><span>Account status</span><small>Live data</small></header>
                    <button type="button" onClick={() => setSection('connections')}>
                      <span><b>Linked sign-ins</b><small>{accounts == null ? 'Loading…' : `${accounts.length} connected`}</small></span>
                      <strong>View</strong>
                    </button>
                    <button type="button" onClick={() => setSection('defaults')}>
                      <span><b>Room defaults</b><small>{!defaultsLoaded ? 'Loading…' : defaults ? `${rows.length} saved values` : 'Stock settings'}</small></span>
                      <strong>View</strong>
                    </button>
                  </section>
                </div>
              ) : null}

              {section === 'defaults' ? (
                <section className="mcc-settings-zone">
                  <header>
                    <div><span className="mcc-coordinate">Room defaults</span><h2>Start every room ready.</h2><p>These values load into Create Room and can still be changed per stream.</p></div>
                    <a href="/dashboard?new=1" className="btn-ghost">Open full setup</a>
                  </header>
                  {!identity ? (
                    <p className="hint">Add a sign-in before saving account-level room defaults.</p>
                  ) : !defaultsLoaded ? (
                    <p className="hint">Loading…</p>
                  ) : rows.length > 0 ? (
                    <ul id="defaults-summary" className="mcc-setting-rows">
                      {rows.map(([k, v]) => <li key={k}><span>{k}</span><strong>{v}</strong></li>)}
                    </ul>
                  ) : defaults ? (
                    <p id="defaults-summary" className="hint">Defaults are saved, but none differ from stock.</p>
                  ) : (
                    <p className="hint">No defaults saved yet. New rooms use the stock settings.</p>
                  )}
                  <div className="mcc-settings-actions">
                    <a href="/dashboard?new=1" className="btn">Edit defaults</a>
                    {defaults ? (
                      <button type="button" id="clear-defaults" disabled={busy} onClick={() => void clearDefaults()} className="btn-ghost">
                        {busy ? 'Clearing…' : 'Clear defaults'}
                      </button>
                    ) : null}
                  </div>
                  {note ? <p className="hint">{note}</p> : null}
                </section>
              ) : null}

              {section === 'connections' ? (
                <section className="mcc-connections-zone" id="connections">
                  <header><span className="mcc-coordinate">Linked sign-ins</span><h2>One identity, multiple ways back in.</h2><p>Every provider below resolves to this same MegaChat account.</p></header>
                  {!identity ? (
                    <div className="mcc-empty-connection"><p>Wallet-only session. Add Google, email, passkey, Twitch, X, or another supported sign-in.</p><button type="button" className="btn" onClick={openSignIn}>Add a sign-in</button></div>
                  ) : accounts == null ? (
                    <p className="hint">Loading…</p>
                  ) : accounts.length === 0 ? (
                    <div className="mcc-empty-connection"><p>No linked providers returned for this identity.</p><button type="button" className="btn-ghost" onClick={openSignIn}>Open sign in</button></div>
                  ) : (
                    <ul id="linked-accounts" className="mcc-connections-list">
                      {accounts.map((a, i) => (
                        <li key={`${a.type}-${i}`}>
                          <span className="mcc-provider">{providerLabel(a.type).charAt(0)}</span>
                          <span><strong>{providerLabel(a.type)}</strong><small>{a.name || 'Connected account'}</small></span>
                          <b>Connected</b>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mcc-wallet-line">
                    <span><strong>Payment balance</strong><small>{wallet.address ? shortAddr(wallet.address) : 'Not connected'}</small></span>
                    {!wallet.address ? <button type="button" className="btn-ghost" onClick={() => void connectBalance()} disabled={!wallet.configured || connectingBalance}>Connect</button> : <b>Connected</b>}
                  </div>
                </section>
              ) : null}
            </section>
          </div>
        </main>
      )}
    </div>
  )
}
