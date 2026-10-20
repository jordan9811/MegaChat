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

import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  LogOut,
  LayoutDashboard,
  UserRound,
  Wallet,
} from 'lucide-react'
import { useUiMode } from '@/lib/ui-mode'
import { shortAddr, useAccount } from '@/lib/use-account'

const itemCls =
  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold text-hl-fg transition-colors hover:bg-hl-panel-2'
const itemDisabledCls =
  'flex w-full cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold text-hl-muted opacity-60'

export function HeaderAuth() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const simple = useUiMode() === 'simple'
  // Shared with the app-skin chip so the two controls cannot disagree.
  const {
    loaded,
    identity,
    wallet,
    balance,
    signedIn,
    chipLabel,
    openSignIn: startSignIn,
    connectBalance: doConnectBalance,
    connectingBalance,
    signOut: doSignOut,
  } = useAccount(open)

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
    setOpen(false)
    startSignIn()
  }

  // "Connect balance": the person is already signed in (has an identity) but
  // their embedded wallet is missing. openLogin() no-ops when authenticated,
  // so this path uses connect(), which creates the wallet directly — no modal,
  // so no dismissal-hang risk.
  async function connectBalance() {
    await doConnectBalance()
    setOpen(false)
  }

  async function signOut() {
    await doSignOut()
  }

  // Reserve the slot pre-load so the header never visibly reflows.
  if (!loaded) {
    return <span aria-hidden="true" className="inline-block h-9 w-24 rounded-full bg-hl-line" />
  }

  return (
    <div ref={rootRef} className="relative">
      {signedIn ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex items-center gap-2 rounded-full border border-hl-line-2 bg-hl-panel/60 px-3 py-2 text-sm font-semibold text-hl-fg transition-colors hover:bg-hl-panel-2 sm:px-4"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-hl-strap-hi dark:shadow-[0_0_8px_var(--hl-strap-hi)]" />
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
          className="glow-magenta flex items-center gap-2 rounded-full bg-hl-strap px-3 py-2 text-sm font-semibold text-white transition-transform hover:scale-[1.03] hover:bg-hl-strap-hover active:scale-[0.97] disabled:opacity-70 sm:px-4"
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
          className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-64 rounded-xl border border-hl-line-2 bg-hl-panel/95 p-1.5 shadow-[var(--hl-shadow)] backdrop-blur-md"
        >
          {identity ? (
            <a
              href="/dashboard?section=account"
              role="menuitem"
              className="block rounded-lg px-3 pb-1.5 pt-2 text-xs text-hl-muted transition-colors hover:bg-hl-panel-2"
            >
              @{identity.handle} is yours forever, and it&apos;s your room link:{' '}
              <span className="font-mono text-hl-strap-hi dark:text-[color-mix(in_srgb,var(--hl-strap-hi)_72%,var(--hl-fg))]">/{identity.handle}</span>
            </a>
          ) : null}

          {wallet.address ? (
            <div className="mx-1.5 mb-1 rounded-lg border border-hl-line bg-hl-panel-2 px-3 py-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-hl-muted">Balance</span>
                <span className="font-mono font-semibold text-f-bounty-ink">
                  {balance == null ? '…' : simple ? `$${balance}` : `${balance} USDC`}
                </span>
              </div>
              {/* the address lives HERE — opt-in, never on the button */}
              <p className="mt-0.5 font-mono text-[10px] text-hl-muted" title={wallet.address}>
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
              <Wallet className="size-4 text-hl-strap-hi" />
              {connectingBalance ? 'Connecting…' : 'Connect balance'}
            </button>
          )}

          <a href="/dashboard?section=account" role="menuitem" className={itemCls}>
            <UserRound className="size-4 text-hl-strap-hi" />
            Account
          </a>
          <a href="/dashboard" role="menuitem" className={itemCls}>
            <LayoutDashboard className="size-4 text-hl-strap-hi" />
            Dashboard
          </a>
          <button type="button" role="menuitem" onClick={() => void signOut()} className={itemCls}>
            <LogOut className="size-4 text-hl-muted" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
