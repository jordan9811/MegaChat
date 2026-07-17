'use client'

// Log in / Sign up in the site header — on EVERY page, join included.
//
// ONE front door: the button opens Privy's modal, which carries Twitch, X,
// Google, email and passkey. That single sign-in yields BOTH halves at once —
// the @handle (minted server-side from the verified token) and the wallet that
// pays for seats. There is no second sign-in and no in-house chooser: those
// were the double-login.
//
// Signed in, the button becomes a chip (your @handle — never an address) and
// the dropdown carries balance, your room link, dashboard and sign out.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  LogOut,
  LayoutDashboard,
  UserRound,
  Wallet,
} from 'lucide-react'
import { useUiMode } from '@/lib/ui-mode'

type Identity = { provider: string; username: string; handle: string } | null
type WalletState = {
  configured: boolean
  authenticated: boolean
  address: string | null
  displayName: string | null
  modalOpen: boolean
}

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
    displayName: MW?.displayName ?? null,
    modalOpen: !!MW?.modalOpen,
  }
}

export function HeaderAuth() {
  const [identity, setIdentity] = useState<Identity>(null)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [wallet, setWallet] = useState<WalletState>({
    configured: false, authenticated: false, address: null, displayName: null, modalOpen: false,
  })
  const [balance, setBalance] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const simple = useUiMode() === 'simple'

  // Privy's modal keeps you on the page, so there's no returnTo to carry.
  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((me) => setIdentity(me?.identity || null))
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  // Wallet state comes from the window bridge (provider mounts app-wide).
  useEffect(() => {
    const sync = () => setWallet(readWallet())
    sync()
    window.addEventListener('megawallet:changed', sync)
    return () => window.removeEventListener('megawallet:changed', sync)
  }, [])

  // Privy sign-in mints the handle server-side — pick it up without a reload.
  useEffect(() => {
    const onIdentity = () => {
      fetch('/api/auth/me')
        .then((r) => r.json())
        .then((me) => setIdentity(me?.identity || null))
        .catch(() => {})
    }
    window.addEventListener('megachat:identity', onIdentity)
    return () => window.removeEventListener('megachat:identity', onIdentity)
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

  // Fire-and-forget: open Privy's modal and return. Reactive state (the
  // window bridge + megachat:identity event) updates the chip on success, and
  // dismissing the modal simply flips modalOpen back to false — nothing can
  // hang the button waiting on a promise that never settles.
  function openSignIn() {
    if (!window.MegaWallet?.configured) return
    setOpen(false)
    window.MegaWallet.openLogin()
  }

  // "Connect balance": the person is already signed in (has an identity) but
  // their embedded wallet is missing. openLogin() no-ops when authenticated,
  // so this path uses connect(), which creates the wallet directly — no modal,
  // so no dismissal-hang risk.
  const [connectingBalance, setConnectingBalance] = useState(false)
  async function connectBalance() {
    if (!window.MegaWallet?.configured || connectingBalance) return
    setConnectingBalance(true)
    try {
      await window.MegaWallet.connect()
      setOpen(false)
    } catch {
      /* cancelled/failed — state unchanged */
    } finally {
      setConnectingBalance(false)
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
  // NEVER a wallet address here. This is a consumer app: you are your name,
  // and hex on a button is the opposite of that. The address lives inside the
  // dropdown for the people who actually want it.
  // handle (server-minted) → Privy's own name (client-side, survives a failed
  // mint) → generic. An address is never a name.
  const chipLabel = identity
    ? `@${identity.handle}`
    : wallet.displayName
      ? `@${wallet.displayName}`
      : 'Account'

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
          onClick={openSignIn}
          disabled={wallet.modalOpen}
          title={wallet.configured ? 'Twitch, X, Google, email or passkey' : 'Sign-in is not configured on this server'}
          className="glow-magenta flex items-center gap-2 rounded-full bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.03] disabled:opacity-70 sm:px-4"
        >
          <UserRound className="size-4" />
          {/* Straight to Privy's modal — no in-house chooser in between.
              "Opening…" is tied to the modal being open, so dismissing it
              always resets the button (no stuck-churning refresh needed). */}
          <span className="hidden sm:inline">
            {wallet.modalOpen ? 'Opening…' : 'Log in / Sign up'}
          </span>
          <span className="sm:hidden">{wallet.modalOpen ? '…' : 'Log in'}</span>
        </button>
      )}

      {open && signedIn ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-64 rounded-xl border border-border bg-card/95 p-1.5 shadow-[0_12px_40px_oklch(0.1_0.03_300/0.5)] backdrop-blur-md"
        >
          {identity ? (
            <p className="px-3 pb-1.5 pt-2 text-xs text-muted-foreground">
              @{identity.handle} is yours forever, and it&apos;s your room link:{' '}
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
              {/* the address lives HERE — opt-in, never on the button */}
              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground" title={wallet.address}>
                {shortAddr(wallet.address)}
              </p>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => void connectBalance()}
              disabled={!wallet.configured || connectingBalance}
              className={wallet.configured ? itemCls : itemDisabledCls}
              title={wallet.configured ? 'Connect the wallet that pays for seats' : 'Wallet service not configured on this server'}
            >
              <Wallet className="size-4 text-[var(--neon-cyan)]" />
              {connectingBalance ? 'Connecting…' : 'Connect balance'}
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
        </div>
      ) : null}
    </div>
  )
}
