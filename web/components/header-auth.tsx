'use client'

// Log in / Sign up in the site header — on EVERY page, join included.
// Two kinds of signed-in, shown as one coherent state:
//   · identity (Twitch / X OAuth) — your @handle + permanent /handle link
//   · balance (Privy email/passkey wallet) — the money that pays for seats
// Either alone works; together the chip shows the handle and the dropdown
// carries the balance. One quiet dropdown, no modals unless asked for.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  LogOut,
  LayoutDashboard,
  Mail,
  UserRound,
  Wallet,
} from 'lucide-react'
import { useUiMode } from '@/lib/ui-mode'

type Providers = { twitch: boolean; x: boolean }
type Identity = { provider: string; username: string; handle: string } | null
type WalletState = { configured: boolean; authenticated: boolean; address: string | null }

const itemCls =
  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-input/50'
const itemDisabledCls =
  'flex w-full cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold text-muted-foreground opacity-60'

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

function readWallet(): WalletState {
  const MW = typeof window !== 'undefined' ? window.MegaWallet : undefined
  return {
    configured: !!MW?.configured,
    authenticated: !!MW?.authenticated,
    address: MW?.address ?? null,
  }
}

export function HeaderAuth() {
  const [providers, setProviders] = useState<Providers>({ twitch: false, x: false })
  const [identity, setIdentity] = useState<Identity>(null)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [returnTo, setReturnTo] = useState('/')
  const [wallet, setWallet] = useState<WalletState>({ configured: false, authenticated: false, address: null })
  const [balance, setBalance] = useState<string | null>(null)
  const [emailBusy, setEmailBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const simple = useUiMode() === 'simple'

  // Sign-in should drop you back on the page you started from, not on some
  // room's checkout page. Read after mount (no SSR skew).
  useEffect(() => {
    setReturnTo(window.location.pathname + window.location.search)
  }, [])
  const authHref = (p: string) => `/auth/${p}?returnTo=${encodeURIComponent(returnTo)}`

  useEffect(() => {
    Promise.all([
      fetch('/api/auth/providers').then((r) => r.json()).catch(() => ({})),
      fetch('/api/auth/me').then((r) => r.json()).catch(() => ({})),
    ]).then(([prov, me]) => {
      setProviders({ twitch: !!prov.twitch, x: !!prov.x })
      setIdentity(me?.identity || null)
      setLoaded(true)
    })
  }, [])

  // Wallet state comes from the window bridge (provider mounts app-wide).
  useEffect(() => {
    const sync = () => setWallet(readWallet())
    sync()
    window.addEventListener('megawallet:changed', sync)
    return () => window.removeEventListener('megawallet:changed', sync)
  }, [])

  // Balance preview for the dropdown — read-only, refreshed on address
  // change and every time the menu opens.
  const refreshBalance = useCallback((address: string) => {
    fetch(`/api/balance/${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.available != null) {
          const n = parseFloat(d.available)
          setBalance(Number.isFinite(n) ? n.toFixed(2) : null)
        }
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (wallet.address) refreshBalance(wallet.address)
    else setBalance(null)
  }, [wallet.address, refreshBalance])
  useEffect(() => {
    if (open && wallet.address) refreshBalance(wallet.address)
  }, [open, wallet.address, refreshBalance])

  // click-outside + escape close the menu
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function emailSignIn() {
    if (!window.MegaWallet?.configured || emailBusy) return
    setEmailBusy(true)
    try {
      await window.MegaWallet.connect()
      setOpen(false)
    } catch {
      /* modal abandoned — state unchanged */
    } finally {
      setEmailBusy(false)
    }
  }

  async function signOut() {
    // Both halves: OAuth identity cookie AND the Privy session.
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    if (window.MegaWallet?.authenticated) {
      await window.MegaWallet.logout().catch(() => {})
    }
    window.location.reload()
  }

  // Reserve the slot pre-load so the header never visibly reflows.
  if (!loaded) {
    return <span aria-hidden="true" className="inline-block h-9 w-24 rounded-full bg-input/20" />
  }

  const signedIn = !!identity || !!wallet.address
  const chipLabel = identity ? `@${identity.handle}` : wallet.address ? shortAddr(wallet.address) : ''

  return (
    <div ref={rootRef} className="relative">
      {signedIn ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex items-center gap-2 rounded-full border border-border bg-input/30 px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-input/50 sm:px-4"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-[var(--neon-lime)] shadow-[0_0_8px_var(--neon-lime)]" />
          {/* handles run up to 20 chars — truncate or the chip blows up a
              375px header */}
          <span
            className={`max-w-[4.5rem] truncate sm:max-w-[12rem] ${identity ? '' : 'font-mono text-xs'}`}
          >
            {chipLabel}
          </span>
          <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          className="glow-magenta flex items-center gap-2 rounded-full bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.03] sm:px-4"
        >
          <UserRound className="size-4" />
          {/* full label needs more width than a 375px header has */}
          <span className="hidden sm:inline">Log in / Sign up</span>
          <span className="sm:hidden">Log in</span>
        </button>
      )}

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-64 rounded-xl border border-border bg-card/95 p-1.5 shadow-[0_12px_40px_oklch(0.1_0.03_300/0.5)] backdrop-blur-md"
        >
          {signedIn ? (
            <>
              {identity ? (
                <p className="px-3 pb-1.5 pt-2 text-xs text-muted-foreground">
                  Signed in via {identity.provider === 'x' ? 'X' : 'Twitch'} — @{identity.handle} is
                  yours forever, and it&apos;s your room link:{' '}
                  <span className="font-mono text-foreground">/{identity.handle}</span>
                </p>
              ) : null}

              {wallet.address ? (
                <div className="mx-1.5 mb-1 rounded-lg border border-border/70 bg-input/20 px-3 py-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Balance</span>
                    <span className="font-mono font-semibold text-foreground">
                      {balance == null ? '…' : simple ? `$${balance}` : `${balance} USDC`}
                    </span>
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground" title={wallet.address}>
                    {shortAddr(wallet.address)}
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void emailSignIn()}
                  disabled={!wallet.configured || emailBusy}
                  className={wallet.configured ? itemCls : itemDisabledCls}
                  title={wallet.configured ? 'Connect the wallet that pays for seats' : 'Wallet service not configured on this server'}
                >
                  <Wallet className="size-4 text-[var(--neon-cyan)]" />
                  {emailBusy ? 'Waiting for sign-in…' : 'Connect balance'}
                </button>
              )}

              <a href="/dashboard" role="menuitem" className={itemCls}>
                <LayoutDashboard className="size-4 text-[var(--neon-lime)]" />
                Dashboard
              </a>
              <button type="button" role="menuitem" onClick={() => void signOut()} className={itemCls}>
                <LogOut className="size-4 text-muted-foreground" />
                Sign out
              </button>
            </>
          ) : (
            <>
              <p className="px-3 pb-1.5 pt-2 text-xs text-muted-foreground">
                Twitch / X claims your @handle + room link. Google / email
                sets up your balance.
              </p>
              {providers.twitch ? (
                <a href={authHref('twitch')} role="menuitem" className={itemCls}>
                  <span
                    aria-hidden="true"
                    className="inline-flex size-4 items-center justify-center rounded-sm bg-[#9146FF] text-[10px] font-black text-white"
                  >
                    T
                  </span>
                  Continue with Twitch
                </a>
              ) : (
                <span role="menuitem" title="Twitch login not configured on this server" className={itemDisabledCls}>
                  <span aria-hidden="true" className="inline-flex size-4 items-center justify-center rounded-sm bg-muted text-[10px] font-black">T</span>
                  Twitch — not configured
                </span>
              )}
              {providers.x ? (
                <a href={authHref('x')} role="menuitem" className={itemCls}>
                  <span aria-hidden="true" className="inline-flex size-4 items-center justify-center text-sm font-black">𝕏</span>
                  Continue with X
                </a>
              ) : (
                <span role="menuitem" title="X login not configured on this server" className={itemDisabledCls}>
                  <span aria-hidden="true" className="inline-flex size-4 items-center justify-center text-sm font-black">𝕏</span>
                  X — not configured
                </span>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => void emailSignIn()}
                disabled={!wallet.configured || emailBusy}
                className={wallet.configured ? itemCls : itemDisabledCls}
                title={wallet.configured ? 'Opens the sign-in window' : 'Wallet service not configured on this server'}
              >
                <Mail className="size-4 text-[var(--neon-cyan)]" />
                {emailBusy
                  ? 'Waiting for sign-in…'
                  : wallet.configured
                    ? 'Google, email or passkey'
                    : 'Google / email — not configured'}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
