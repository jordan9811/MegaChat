'use client'

// Log in / Sign up in the site header — OAuth identity (Twitch / X).
// Signed-in users get their @handle chip with a small menu (Dashboard,
// sign out). One quiet dropdown, no modals: the whole app stays usable
// without an account, so this never nags.

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, LogOut, LayoutDashboard, UserRound } from 'lucide-react'

type Providers = { twitch: boolean; x: boolean }
type Identity = { provider: string; username: string; handle: string } | null

const itemCls =
  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-input/50'
const itemDisabledCls =
  'flex w-full cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold text-muted-foreground opacity-60'

export function HeaderAuth() {
  const [providers, setProviders] = useState<Providers>({ twitch: false, x: false })
  const [identity, setIdentity] = useState<Identity>(null)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    window.location.reload()
  }

  // Reserve the slot pre-load so the header never visibly reflows.
  if (!loaded) {
    return <span aria-hidden="true" className="inline-block h-9 w-24 rounded-full bg-input/20" />
  }

  return (
    <div ref={rootRef} className="relative">
      {identity ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex items-center gap-2 rounded-full border border-border bg-input/30 px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-input/50"
        >
          <span className="size-1.5 rounded-full bg-[var(--neon-lime)] shadow-[0_0_8px_var(--neon-lime)]" />
          @{identity.handle}
          <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
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
          className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-60 rounded-xl border border-border bg-card/95 p-1.5 shadow-[0_12px_40px_oklch(0.1_0.03_300/0.5)] backdrop-blur-md"
        >
          {identity ? (
            <>
              <p className="px-3 pb-1.5 pt-2 text-xs text-muted-foreground">
                Signed in via {identity.provider === 'x' ? 'X' : 'Twitch'} — your handle is
                yours forever: <span className="font-mono text-foreground">/r/{identity.handle}</span>
              </p>
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
                Reserves your handle as your display name and permanent /r/ link.
                Optional — everything works without it.
              </p>
              {providers.twitch ? (
                <a href="/auth/twitch" role="menuitem" className={itemCls}>
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
                <a href="/auth/x" role="menuitem" className={itemCls}>
                  <span aria-hidden="true" className="inline-flex size-4 items-center justify-center text-sm font-black">𝕏</span>
                  Continue with X
                </a>
              ) : (
                <span role="menuitem" title="X login not configured on this server" className={itemDisabledCls}>
                  <span aria-hidden="true" className="inline-flex size-4 items-center justify-center text-sm font-black">𝕏</span>
                  X — not configured
                </span>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
