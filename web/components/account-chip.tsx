'use client'

// The account control for the NEW surfaces (room board, create room).
//
// Same state as the old header chip — one hook, so the two can never disagree
// about whether you are signed in — but drawn in the near-black app skin
// instead of the legacy neon one. Before this existed, the board and the
// create page carried a "Sign in" link that pointed at /dashboard and did no
// signing in, so once you were signed in there was nowhere to see your
// handle, your balance, or a way out.

import { useEffect, useRef, useState } from 'react'
import { shortAddr, useAccount } from '@/lib/use-account'

export function AccountChip({ accent = '#f2f2f4' }: { accent?: string }) {
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
  if (!loaded) return <span aria-hidden="true" className="inline-block h-[31px] w-[92px] bg-white/5" />

  if (!signedIn) {
    return (
      <button
        type="button"
        onClick={openSignIn}
        disabled={wallet.modalOpen}
        title={wallet.configured ? 'Twitch, X, Google, email or passkey' : 'Sign-in is not configured on this server'}
        className="px-3.5 py-[7px] text-[13px] font-[700] text-[#08080a] disabled:opacity-70"
        style={{ background: accent }}
      >
        {wallet.modalOpen ? 'Opening…' : 'Sign in'}
      </button>
    )
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 border border-white/20 px-3 py-[6px] text-[13px] font-[600] text-white hover:border-white/45"
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
          className="absolute right-0 top-[calc(100%+6px)] z-40 w-[248px] border border-white/15 bg-[#101014] p-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.6)]"
        >
          {identity ? (
            <a
              href={`/${identity.handle}`}
              role="menuitem"
              className="block px-2.5 pb-1.5 pt-2 text-[11.5px] leading-[1.45] text-[#9aa4ad] hover:text-white"
            >
              Your room link
              <span className="mt-0.5 block font-[600] text-[#43e0a8]">
                megachat.fun/{identity.handle}
              </span>
            </a>
          ) : null}

          {wallet.address ? (
            <div className="mb-1 border border-white/10 bg-black/30 px-2.5 py-2">
              <span className="flex items-baseline justify-between text-[12.5px]">
                <span className="text-[#9aa4ad]">Balance</span>
                <span className="font-[700] tabular-nums text-white">
                  {balance == null ? '…' : `${balance} USDC`}
                </span>
              </span>
              <span
                className="mt-0.5 block text-[10.5px] text-[#6d7780]"
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
              className="block w-full px-2.5 py-2 text-left text-[13px] text-white hover:bg-white/10 disabled:opacity-50"
              title={wallet.configured ? 'Connect the wallet that pays for seats' : 'Wallet service not configured on this server'}
            >
              {connectingBalance ? 'Connecting…' : 'Connect balance'}
            </button>
          )}

          <a href="/dashboard?section=account" role="menuitem" className="block px-2.5 py-2 text-[13px] text-white hover:bg-white/10">
            Account
          </a>
          <a href="/dashboard" role="menuitem" className="block px-2.5 py-2 text-[13px] text-white hover:bg-white/10">
            Your room
          </a>
          <a href="/dashboard?new=1" role="menuitem" className="block px-2.5 py-2 text-[13px] text-white hover:bg-white/10">
            Open a new room
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut()}
            className="block w-full px-2.5 py-2 text-left text-[13px] text-[#9aa4ad] hover:bg-white/10 hover:text-white"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
