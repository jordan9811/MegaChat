'use client'

// The account control for the NEW surfaces (room board, create room).
//
// Same state as the old header chip — one hook, so the two can never disagree
// about whether you are signed in — but drawn in the app skin, from the Holler
// tokens, so it follows the light/dark theme. Before this existed, the board and the
// create page carried a "Sign in" link that pointed at /dashboard and did no
// signing in, so once you were signed in there was nowhere to see your
// handle, your balance, or a way out.

import { useEffect, useRef, useState } from 'react'
import { shortAddr, useAccount } from '@/lib/use-account'
import { formatDollars } from '@/lib/display-format'

// `accent` colours the signed-in dot only. The Sign in button is always the
// strap azure with white text, so whatever accent a page passes, its label
// keeps ≥4.5:1 in both themes.
export function AccountChip({ accent = 'var(--hl-strap-hi)' }: { accent?: string }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const {
    loaded,
    identity,
    wallet,
    balance,
    signedIn,
    chipLabel,
    openSignIn,
    authError,
    connectBalance,
    connectingBalance,
    signOut,
  } = useAccount(open)

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

  // Hold the slot pre-load so the header never visibly reflows.
  // 36px, the same height as the theme toggle and Create room beside it.
  if (!loaded) return <span aria-hidden="true" className="inline-block h-9 w-[92px] bg-hl-line" />

  if (!signedIn) {
    return (
      <div className="relative">
      <button
        type="button"
        onClick={openSignIn}
        disabled={wallet.modalOpen}
        title={wallet.configured ? 'Twitch, X, Google, email or passkey' : 'Sign-in is not configured on this server'}
        className="inline-flex h-9 items-center bg-hl-strap px-3.5 text-[13px] font-[700] text-hl-on-strap transition-transform duration-150 ease-[cubic-bezier(.23,1,.32,1)] hover:bg-hl-strap-hover active:scale-[0.97] disabled:opacity-70"
      >
        {wallet.modalOpen ? 'Opening…' : 'Sign in'}
      </button>
      {authError && <p role="alert" className="absolute right-0 top-full z-50 mt-2 w-72 border border-hl-danger bg-hl-panel p-3 text-left text-[13px] leading-normal text-hl-fg shadow-[var(--hl-shadow)]">{authError}</p>}
      </div>
    )
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-9 items-center gap-2 border border-hl-line-2 px-3 text-[13px] font-[600] text-hl-fg hover:border-hl-strap-hi"
      >
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: accent }} />
        <span className="max-w-[10rem] truncate">{chipLabel}</span>
        <span aria-hidden="true" className="text-[10px] opacity-70">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-40 w-[248px] border border-hl-line-2 bg-hl-panel p-1.5 shadow-[var(--hl-shadow)]"
        >
          {identity ? (
            <a
              href={`/${identity.handle}`}
              role="menuitem"
              className="block px-2.5 pb-1.5 pt-2 text-[11.5px] leading-[1.45] text-hl-muted hover:text-hl-fg"
            >
              Your room link
              <span className="mt-0.5 block font-[600] text-hl-strap-hi dark:text-[color-mix(in_srgb,var(--hl-strap-hi)_72%,var(--hl-fg))]">
                megachat.fun/{identity.handle}
              </span>
            </a>
          ) : null}

          {wallet.address ? (
            <div className="mb-1 border border-hl-line bg-hl-panel-2 px-2.5 py-2">
              <span className="flex items-baseline justify-between text-[12.5px]">
                <span className="text-hl-muted">Balance</span>
                <span className="font-[700] tabular-nums text-f-bounty-ink">
                  {balance == null ? '…' : formatDollars(balance)}
                </span>
              </span>
              <span
                className="mt-0.5 block text-[10.5px] text-hl-dim"
                title={wallet.address}
              >
                {shortAddr(wallet.address)}
              </span>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => void connectBalance()}
              disabled={!wallet.configured || connectingBalance}
              className="block w-full px-2.5 py-2 text-left text-[13px] text-hl-fg hover:bg-hl-panel-2 disabled:opacity-50"
              title={wallet.configured ? 'Connect the wallet that pays for seats' : 'Wallet service not configured on this server'}
            >
              {connectingBalance ? 'Connecting…' : 'Connect balance'}
            </button>
          )}
          {authError && <p role="alert" className="px-2.5 py-2 text-[13px] text-hl-danger">{authError}</p>}

          <a href="/account" role="menuitem" className="block px-2.5 py-2 text-[13px] text-hl-fg hover:bg-hl-panel-2">
            Account
          </a>
          <a href="/dashboard" role="menuitem" className="block px-2.5 py-2 text-[13px] text-hl-fg hover:bg-hl-panel-2">
            Your room
          </a>
          {/* The site owner's own settings page. Nobody else is ever told it
              exists — the server sends siteAdmin only for them. */}
          {identity?.siteAdmin ? (
            <a href="/dev" role="menuitem" className="block px-2.5 py-2 text-[13px] text-hl-strap-hi dark:text-[color-mix(in_srgb,var(--hl-strap-hi)_72%,var(--hl-fg))] hover:bg-hl-panel-2">
              Site settings
            </a>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut()}
            className="block w-full px-2.5 py-2 text-left text-[13px] text-hl-muted hover:bg-hl-panel-2 hover:text-hl-fg"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
