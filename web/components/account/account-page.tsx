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
import { GuestWhitelist } from '@/components/account/guest-whitelist'
import {
  disconnectAccountLink,
  getAccountDefaults,
  getAccountOverview,
  listLinkedAccounts,
  saveAccountDefaults,
  setAccountPrimary,
  type AccountOverview,
  type AccountTier,
  type LinkedAccount,
} from '@/lib/api'
import { shortAddr, useAccount } from '@/lib/use-account'
import { formatDollars } from '@/lib/display-format'
import { BrandText } from '@/components/brand-text'
import { docsUrl } from '@/lib/docs-url.mjs'

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

// The classifier in plain language. Shown to the account holder and nobody
// else — no feature reads it yet, so this is the only place it surfaces.
const TIER_COPY: Record<AccountTier, { title: string; blurb: string }> = {
  recognized: { title: 'Recognised', blurb: 'We can tell who you are on sight. Nothing here will ever ask you to prove it.' },
  plausible: { title: 'Looks like a person', blurb: 'Your linked accounts read as a real person. Nothing here will ask you to prove it.' },
  ambiguous: { title: 'Not enough to tell', blurb: 'Not much to go on yet. Connecting another account is the quickest way to fill this in.' },
  suspect: { title: 'Reads as automated', blurb: 'The numbers on your linked accounts look automated. Connecting another account is the way to change that.' },
  unknown: { title: 'Nothing fetched yet', blurb: 'No profile details have been read from your linked accounts.' },
}

function whenLinked(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
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
  const [section, setSection] = useState<'overview' | 'defaults' | 'guests' | 'connections'>('overview')
  const [overview, setOverview] = useState<AccountOverview | null>(null)
  const [linkBusy, setLinkBusy] = useState<string | null>(null)

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
    getAccountOverview()
      .then(setOverview)
      .catch(() => setOverview(null))
  }, [identity])

  const reloadOverview = useCallback(() => {
    getAccountOverview().then(setOverview).catch(() => {})
  }, [])

  const makePrimary = useCallback(async (provider: string) => {
    setLinkBusy(provider)
    setNote(null)
    try {
      await setAccountPrimary(provider)
      reloadOverview()
      setNote(`${providerLabel(provider)} now supplies your display name — your handle and links are unchanged`)
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not switch')
    } finally {
      setLinkBusy(null)
    }
  }, [reloadOverview])

  const disconnect = useCallback(async (provider: string) => {
    setLinkBusy(provider)
    setNote(null)
    try {
      await disconnectAccountLink(provider)
      reloadOverview()
      setNote(`${providerLabel(provider)} disconnected`)
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not disconnect')
    } finally {
      setLinkBusy(null)
    }
  }, [reloadOverview])

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
            {docsUrl() ? <a href={docsUrl() as string}>Docs</a> : null}
          </nav>
          <span className="mcc-product-actions">
            <a href="/dashboard">Create room</a>
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
                <button type="button" aria-current={section === 'guests' ? 'page' : undefined} onClick={() => setSection('guests')}>Guest list</button>
                <button type="button" aria-current={section === 'connections' ? 'page' : undefined} onClick={() => setSection('connections')}>Connections</button>
              </div>
              <div className="mcc-nav-links">
                <span>Go to</span>
                <a href="/dashboard">Your room</a>
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
                    <a href="/dashboard" className="btn-ghost">Open full setup</a>
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
                    <a href="/dashboard" className="btn">Edit defaults</a>
                    {defaults ? (
                      <button type="button" id="clear-defaults" disabled={busy} onClick={() => void clearDefaults()} className="btn-ghost">
                        {busy ? 'Clearing…' : 'Clear defaults'}
                      </button>
                    ) : null}
                  </div>
                  {note ? <p className="hint">{note}</p> : null}
                </section>
              ) : null}

              {section === 'guests' ? (
                !identity
                  ? <section className="mcc-settings-zone"><p className="hint">Add a sign-in before keeping a guest list — it is tied to your account, not to a room.</p></section>
                  : <GuestWhitelist myHandle={identity.handle ?? null} />
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

                  {/* The account's own links: the ones we hold a platform id
                      for, so they carry attributes and can be made primary.
                      A sign-in an aggregator reports but we have no id for is
                      shown above and upgrades by connecting it here. */}
                  {overview && overview.account.links.length > 0 ? (
                    <div className="mcc-links-zone">
                      <header><span className="mcc-coordinate">Platforms</span><h3>Connected platforms</h3><p>One account, one handle — @{overview.account.handle}. Adding a platform or changing which one names you never moves your link or your room.</p></header>
                      <ul id="account-links" className="mcc-connections-list">
                        {overview.account.links.map((l) => (
                          <li key={l.provider}>
                            <span className="mcc-provider">{l.label.charAt(0)}</span>
                            <span>
                              <strong>{l.label}{overview.account.primary === l.provider ? ' · primary' : ''}</strong>
                              <small>
                                {l.username ? `@${l.username}` : 'Connected'} · linked {whenLinked(l.linkedAt)}
                                {l.attributeCount > 0 ? ` · ${l.attributeCount} profile details` : ' · no profile details'}
                              </small>
                            </span>
                            <span className="mcc-link-actions">
                              {overview.account.primary === l.provider ? null : (
                                <button type="button" className="btn-ghost" disabled={linkBusy === l.provider} onClick={() => void makePrimary(l.provider)}>Make primary</button>
                              )}
                              <a className="btn-ghost" href={l.refreshUrl}>Refresh</a>
                              {overview.account.links.length > 1 ? (
                                <button type="button" className="btn-ghost" disabled={linkBusy === l.provider} onClick={() => void disconnect(l.provider)}>Disconnect</button>
                              ) : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {overview.connectable.length > 0 ? (
                        <div className="mcc-connect-row">
                          {overview.connectable.map((c) => (
                            c.configured
                              ? <a key={c.provider} className="btn-ghost" href={c.connectUrl}>Connect {c.label}</a>
                              : <button key={c.provider} type="button" className="btn-ghost" disabled title="Coming soon">Connect {c.label}</button>
                          ))}
                        </div>
                      ) : null}
                      <p className="hint">Refreshing sends you through that platform&rsquo;s sign-in once more — it is how the numbers update, and an app you have already authorised will not ask you anything.</p>
                    </div>
                  ) : null}

                  {/* The classifier, to the account holder only. Nothing reads
                      it yet; it is shown so a person can see what we think. */}
                  {overview ? (
                    <div className="mcc-standing-zone">
                      <header><span className="mcc-coordinate">How you read</span><h3>{TIER_COPY[overview.classification.tier].title}</h3><p>{TIER_COPY[overview.classification.tier].blurb}</p></header>
                      <ul className="mcc-standing-reasons">
                        {overview.classification.reasons.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                      <p className="hint">Only you can see this. Nothing on MegaChat uses it yet.</p>
                    </div>
                  ) : null}
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
