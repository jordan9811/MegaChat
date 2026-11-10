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
import { AccountRewards } from '@/components/account/account-rewards'
import {
  disconnectAccountLink,
  getAccountDefaults,
  getAccountOverview,
  getAccountPrefs,
  listLinkedAccounts,
  saveAccountDefaults,
  saveAccountPrefs,
  setAccountPrimary,
  type AccountOverview,
  type AccountPrefs,
  type LinkedAccount,
} from '@/lib/api'
import { formatDollars, shortAddr } from '@/lib/display-format'
import { useAccount } from '@/lib/use-account'
import { BrandText } from '@/components/brand-text'
import { FeatureTag, type FeatureKind } from '@/components/feature-tag'
import { ThemeToggle } from '@/components/theme-toggle'
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

// Why a platform login was not linked, in the person's terms. The OAuth
// callback comes back here with ?link_error=<reason> (auth.js refuse()); the
// reason codes never reach the screen.
const LINK_ERROR_COPY: Record<string, string> = {
  provider_linked: 'That login was not linked: this account already has a different login on that platform. To switch, disconnect the one it has, then connect the new one.',
  already_linked: 'That login already belongs to another Holler account, so it was not linked here. Sign in with it to use that account.',
  not_linked: 'That login changed while it was being linked, so nothing was saved. Connect it again.',
}
const LINK_ERROR_FALLBACK = 'That login could not be linked. Try connecting it again.'

/** The aggregator's sign-in type as the account's own provider key. */
const providerKey = (type: string) => (type === 'twitter' ? 'x' : type)

/** "a, b and c". */
function joinAnd(parts: string[]) {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || ''
}

const REFRESH_TIP = 'Refreshing sends you through that platform’s sign-in once more. It is how your profile details update, and an app you have already authorised will not ask you anything.'

// Human summary of a saved defaults blob — only fields worth glancing at.
// A feature row carries its kind, so an On value shows as that feature's tag.
type SummaryRow = [string, string, FeatureKind?]

function defaultsSummary(d: Record<string, unknown>): SummaryRow[] {
  const rows: SummaryRow[] = []
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
  if (mc != null) rows.push(['Hollers', mc ? 'On' : 'Off', 'holler'])
  const js = b('joinStreamEnabled')
  if (js != null) rows.push(['Call in', js ? 'On' : 'Off', 'callin'])
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
    balanceStatus,
    retryBalance,
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
  const [section, setSection] = useState<'overview' | 'rewards' | 'defaults' | 'bounties' | 'guests' | 'connections'>(
    typeof window !== 'undefined' && window.location.hash === '#bounties' ? 'bounties'
      : typeof window !== 'undefined' && window.location.hash === '#rewards' ? 'rewards' : 'overview',
  )
  // Bounty protection: the liveness tier this account's pledges release at.
  const [prefs, setPrefs] = useState<AccountPrefs | null>(null)
  const [prefsBusy, setPrefsBusy] = useState(false)
  const [prefsError, setPrefsError] = useState<string | null>(null)
  const [overview, setOverview] = useState<AccountOverview | null>(null)
  const [linkBusy, setLinkBusy] = useState<string | null>(null)
  const [linkNotice, setLinkNotice] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => setOrigin(window.location.origin), [])

  // Connecting or refreshing a platform leaves through its sign-in and comes
  // back here (connectUrl / refreshUrl, returnTo=/account) with ?linked=<p>
  // or ?link_error=<reason>. Nothing read either, so a refused link looked
  // like nothing happened. Said once, in Connections, then taken off the URL
  // so a reload does not say it again.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const linked = params.get('linked')
    const refused = params.get('link_error')
    if (!linked && !refused) return
    setLinkNotice(refused
      ? { ok: false, text: LINK_ERROR_COPY[refused] || LINK_ERROR_FALLBACK }
      : { ok: true, text: `${providerLabel(linked || '')} is linked to this account, and its profile details are up to date.` })
    setSection('connections')
    params.delete('linked')
    params.delete('link_error')
    const rest = params.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`)
  }, [])

  // Both endpoints are authorized by the identity cookie, so a wallet-only
  // session has nothing to ask for.
  useEffect(() => {
    if (!identity) return
    listLinkedAccounts()
      .then((d) => setAccounts(d.accounts))
      .catch(() => setAccounts([]))
    getAccountPrefs().then((p) => setPrefs(p.prefs)).catch(() => {})
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
    <div className="mc-account min-h-screen">
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
            <ThemeToggle />
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
            <h1 className="text-[26px] font-bold leading-[1.15]">Sign in to see your account</h1>
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
              <h1>{identity ? `@${identity.handle}` : 'Wallet only'}</h1>
              {identity ? null : <p>Add a sign-in to claim a permanent handle and room link.</p>}
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
                <button type="button" data-section="overview" aria-current={section === 'overview' ? 'page' : undefined} onClick={() => setSection('overview')}>Overview</button>
                <button type="button" data-section="rewards" aria-current={section === 'rewards' ? 'page' : undefined} onClick={() => setSection('rewards')}>Rewards</button>
                <button type="button" data-section="defaults" aria-current={section === 'defaults' ? 'page' : undefined} onClick={() => setSection('defaults')}>Room defaults</button>
                <button type="button" data-section="bounties" aria-current={section === 'bounties' ? 'page' : undefined} onClick={() => setSection('bounties')}>Bounty protection</button>
                <button type="button" data-section="guests" aria-current={section === 'guests' ? 'page' : undefined} onClick={() => setSection('guests')}>Guest list</button>
                <button type="button" data-section="connections" aria-current={section === 'connections' ? 'page' : undefined} onClick={() => setSection('connections')}>Connections</button>
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
                  {/* The state lives in the value slot (ca-acct-balance):
                      "Not connected" with the way to connect, "..." only
                      while a read is in flight, "Couldn't load" with Retry
                      when it fails. It used to be a "…" that never resolved. */}
                  <section className="mcc-balance-zone">
                    <span className="mcc-coordinate">Available balance</span>
                    {!wallet.address ? (
                      <>
                        <strong className="mcc-balance-state">Not connected</strong>
                        <button
                          type="button"
                          onClick={() => void connectBalance()}
                          disabled={!wallet.configured || connectingBalance}
                        >
                          {connectingBalance ? 'Connecting…' : 'Connect balance'}
                        </button>
                      </>
                    ) : balanceStatus === 'error' ? (
                      <>
                        <strong className="mcc-balance-state">Couldn’t load</strong>
                        <p>{shortAddr(wallet.address)}</p>
                        <button type="button" onClick={retryBalance}>Retry</button>
                      </>
                    ) : balanceStatus === 'ready' && balance != null ? (
                      <>
                        <strong><b>$</b>{balance}</strong>
                        <p>{shortAddr(wallet.address)}</p>
                        <a href="/app">Use balance in a room</a>
                      </>
                    ) : (
                      <>
                        <strong aria-label="Loading your balance">...</strong>
                        <p>{shortAddr(wallet.address)}</p>
                      </>
                    )}
                  </section>
                </div>
              ) : null}

              {section === 'rewards' ? <AccountRewards /> : null}

              {section === 'bounties' ? (
                <section className="mcc-settings-zone" id="bounties">
                  <header>
                    <div><h2>When does your pledge pay out?</h2><p>Every pledge you make releases at the tier you pick here. Change it any time; pledges already made keep theirs.</p></div>
                  </header>
                  {!identity ? (
                    <p className="hint">Add a sign-in before choosing a tier.</p>
                  ) : !prefs ? (
                    <p className="hint">Loading…</p>
                  ) : (
                    <div className="mcc-setting-rows" role="radiogroup" aria-label="Minimum liveness tier">
                      {([
                        ['green', 'Green only', 'Pays only for airtime the badge verified on the real frames. The strongest protection, and the default.'],
                        ['yellow', 'Yellow or better', 'Also releases a slice after any broadcast that kept the keyed overlay up for at least 10 minutes. Protects against a forgotten overlay, not against fraud.'],
                      ] as const).map(([tier, label, copy]) => (
                        <label key={tier} className="flex cursor-pointer items-start gap-3 py-2">
                          <input type="radio" name="bountyMinTier" value={tier} checked={prefs.bountyMinTier === tier} disabled={prefsBusy}
                            onChange={() => {
                              setPrefsBusy(true); setPrefsError(null)
                              saveAccountPrefs({ bountyMinTier: tier }).then((r) => setPrefs(r.prefs)).catch((e) => setPrefsError(e instanceof Error ? e.message : 'Could not save')).finally(() => setPrefsBusy(false))
                            }} />
                          <span><span className={`lv lv--${tier}`} aria-hidden="true"><span className="lv-dot" />{label}</span><br /><small className="hint">{copy}</small></span>
                        </label>
                      ))}
                    </div>
                  )}
                  {prefsError ? <p role="alert" className="hint">{prefsError}</p> : null}
                </section>
              ) : null}

              {section === 'defaults' ? (
                <section className="mcc-settings-zone">
                  <header>
                    <div><h2>Start every room ready.</h2><p>These values load into Create Room and can still be changed per stream.</p></div>
                  </header>
                  {!identity ? (
                    <p className="hint">Add a sign-in before saving account-level room defaults.</p>
                  ) : !defaultsLoaded ? (
                    <p className="hint">Loading…</p>
                  ) : rows.length > 0 ? (
                    <ul id="defaults-summary" className="mcc-setting-rows">
                      {rows.map(([k, v, kind]) => (
                        <li key={k}>
                          <span>{k}</span>
                          {kind && v === 'On' ? <FeatureTag kind={kind}>On</FeatureTag> : <strong>{v}</strong>}
                        </li>
                      ))}
                    </ul>
                  ) : defaults ? (
                    <p id="defaults-summary" className="hint">Defaults are saved, but none differ from stock.</p>
                  ) : (
                    <p className="hint">No defaults saved yet. New rooms use the stock settings.</p>
                  )}
                  <div className="mcc-settings-actions">
                    <a href="/dashboard" className="btn">Set defaults in room setup →</a>
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
                  <header><h2>One identity, multiple ways back in.</h2><p>Every sign-in below opens this same Holler account{overview ? `, @${overview.account.handle}` : ''}. Adding one, or changing which one names you, never moves your link or your room.</p></header>
                  {linkNotice ? <p id="link-notice" role={linkNotice.ok ? 'status' : 'alert'} className="hint">{linkNotice.text}</p> : null}
                  {/* Make primary and Disconnect report here, where they were
                      clicked; the note used to show only under Room defaults. */}
                  {note ? <p className="hint">{note}</p> : null}
                  {!identity ? (
                    <div className="mcc-empty-connection"><p>Wallet-only session. Add Google, email, passkey, Twitch, X, or another supported sign-in.</p><button type="button" className="btn" onClick={openSignIn}>Add a sign-in</button></div>
                  ) : accounts == null && !overview ? (
                    <p className="hint">Loading…</p>
                  ) : (() => {
                    // ONE list (ca-connections-twice): each provider once,
                    // its state and actions on its row. The account's own
                    // links (a platform id: primary, refresh, disconnect)
                    // first; a sign-in only the aggregator reports after,
                    // with Connect where it can be upgraded.
                    const links = overview?.account.links || []
                    const primary = overview?.account.primary
                    const connectable = overview?.connectable || []
                    const linked = new Set(links.map((l) => l.provider))
                    const others = (accounts || []).filter((a, i, all) => !linked.has(providerKey(a.type)) && all.findIndex((b) => providerKey(b.type) === providerKey(a.type)) === i)
                    const shown = new Set([...linked, ...others.map((a) => providerKey(a.type))])
                    const toConnect = connectable.filter((c) => c.configured && !shown.has(c.provider))
                    const soon = connectable.filter((c) => !c.configured && !shown.has(c.provider)).map((c) => c.label)
                    if (links.length === 0 && others.length === 0) {
                      return <div className="mcc-empty-connection"><p>No linked providers returned for this identity.</p><button type="button" className="btn-ghost" onClick={openSignIn}>Open sign in</button></div>
                    }
                    return (
                      <>
                        <ul id="linked-accounts" className="mcc-connections-list">
                          {links.map((l) => (
                            <li key={l.provider}>
                              <span className="mcc-provider">{l.label.charAt(0)}</span>
                              <span>
                                <strong>{l.label}{primary === l.provider ? ' · primary' : ''}</strong>
                                <small>{l.username ? `@${l.username}` : 'Connected'}</small>
                              </span>
                              <span className="mcc-link-actions">
                                {primary === l.provider ? null : (
                                  <button type="button" className="btn-ghost" disabled={linkBusy === l.provider} onClick={() => void makePrimary(l.provider)}>Make primary</button>
                                )}
                                <a className="btn-ghost" href={l.refreshUrl} title={REFRESH_TIP}>Refresh</a>
                                {links.length > 1 ? (
                                  <button type="button" className="btn-ghost" disabled={linkBusy === l.provider} onClick={() => void disconnect(l.provider)}>Disconnect</button>
                                ) : null}
                              </span>
                            </li>
                          ))}
                          {others.map((a) => {
                            const up = connectable.find((c) => c.provider === providerKey(a.type) && c.configured)
                            return (
                              <li key={`agg-${a.type}`}>
                                <span className="mcc-provider">{providerLabel(a.type).charAt(0)}</span>
                                <span><strong>{providerLabel(a.type)}</strong><small>{a.name || 'Connected account'}</small></span>
                                {up ? <span className="mcc-link-actions"><a className="btn-ghost" href={up.connectUrl}>Connect</a></span> : <b>Connected</b>}
                              </li>
                            )
                          })}
                        </ul>
                        {toConnect.length > 0 ? (
                          <div className="mcc-connect-row">
                            {toConnect.map((c) => <a key={c.provider} className="btn-ghost" href={c.connectUrl}>Connect {c.label}</a>)}
                          </div>
                        ) : null}
                        {soon.length > 0 ? <p className="hint">{joinAnd(soon)}: coming soon</p> : null}
                      </>
                    )
                  })()}
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
