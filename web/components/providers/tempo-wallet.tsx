'use client'

// Privy embedded-wallet layer for Tempo mainnet + the window.MegaWallet bridge.
//
// The legacy join logic (lib/join-page.ts) is vanilla DOM code, so React-side
// wallet state is exposed through a small window bridge instead of hooks:
//
//   window.MegaWallet = {
//     configured, ready, authenticated, address,
//     connect(): Promise<address>   // opens Privy modal if needed, ensures
//                                   // the embedded wallet is on Tempo
//     logout(): Promise<void>
//     getProvider(): Promise<EIP-1193 provider>   // embedded wallet signer
//   }
//
// The Privy app id comes from GET /api/config (same source the join page
// already loads) so it can live in the root .env next to every other secret
// instead of being baked into the Next build.
//
// The Privy SDK itself lives in privy-bridge.tsx and is loaded only once an
// app id arrives (audit web-1): it was ~600 KB gzip of every route's
// first-load JS, pages that never sign anyone in included.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { useTheme } from 'next-themes'
import { fetchPublicConfig } from '@/lib/api'
import { emitChange, type MegaWalletBridge } from './wallet-bridge'

const loadPrivyBridge = () => import('./privy-bridge')

// A chunk that fails to download (a flaky phone network) must not take the
// page down with it: a lazy component whose import rejects throws in render,
// and nothing above this provider would catch it. The page stays up, and
// whoever is waiting on the bridge is told sign-in could not load.
function BridgeLoadFailed() {
  useEffect(() => { window.dispatchEvent(new CustomEvent('megawallet:failed')) }, [])
  return null
}
const PrivyBridge = dynamic(
  () => loadPrivyBridge().catch(() => ({ default: BridgeLoadFailed })),
  { ssr: false },
)

// How long a caller waits for the real bridge before giving up: the Privy
// chunk is ~600 KB gzip, seconds on a slow phone, never this long.
const BRIDGE_LOAD_TIMEOUT_MS = 30_000

/**
 * Stands in for window.MegaWallet from the moment the app id is known until
 * the Privy chunk has loaded and the real bridge installs itself. Without it a
 * tap on Sign in during the download read "Sign-in is unavailable on this
 * server." It says configured but not ready, which every caller already reads
 * as "still loading", and the async calls wait for the real bridge, then hand
 * over to it.
 */
function installLoadingBridge() {
  if (window.MegaWallet) return // the real one (or a placeholder) is already up
  const real = () => new Promise<MegaWalletBridge>((resolve, reject) => {
    const check = () => {
      const mw = window.MegaWallet
      if (mw && mw !== placeholder) { done(); resolve(mw) }
    }
    const failed = () => { done(); reject(new Error('Sign-in could not load — refresh and try again.')) }
    const timer = setTimeout(() => {
      done()
      reject(new Error('Sign-in service took too long to load — refresh and try again.'))
    }, BRIDGE_LOAD_TIMEOUT_MS)
    const done = () => {
      clearTimeout(timer)
      window.removeEventListener('megawallet:changed', check)
      window.removeEventListener('megawallet:failed', failed)
    }
    window.addEventListener('megawallet:changed', check)
    window.addEventListener('megawallet:failed', failed)
    check()
  })
  const placeholder: MegaWalletBridge = {
    configured: true,
    ready: false,
    authenticated: false,
    address: null,
    displayName: null,
    modalOpen: false,
    // Callers check `ready` before opening the modal; nothing to open yet.
    openLogin: () => {},
    connect: async () => (await real()).connect(),
    // Nobody is signed in to a bridge that has not loaded.
    logout: async () => {},
    getProvider: async () => (await real()).getProvider(),
  }
  window.MegaWallet = placeholder
  emitChange()
}

/** Marks the bridge as unconfigured so the UI can say exactly what's missing. */
function UnconfiguredBridge() {
  useEffect(() => {
    window.MegaWallet = {
      configured: false,
      ready: true,
      authenticated: false,
      address: null,
      displayName: null,
      modalOpen: false,
      openLogin: () => {},
      connect: async () => {
        throw new Error(
          'Privy is not configured — set NEXT_PUBLIC_PRIVY_APP_ID in .env and restart.',
        )
      },
      logout: async () => {},
      getProvider: async () => {
        throw new Error('Privy is not configured')
      },
    }
    emitChange()
  }, [])
  return null
}

/**
 * Mounts the wallet bridge app-wide.
 *
 * CRITICAL — the bridge is a SIBLING of `children`, never an ancestor. The app
 * id arrives async, so an ancestor would change the tree shape mid-flight
 * (`<>{children}</>` → `<PrivyProvider><WalletBridge>{children}</…>`), and
 * React would unmount and remount the ENTIRE app. That regression re-ran the
 * join page's init and orphaned its WebSocket mid-handshake ("closed before
 * the connection is established"). Nothing outside privy-bridge.tsx uses Privy
 * hooks — children talk to window.MegaWallet — so keeping them at a fixed
 * position costs nothing and makes remounts impossible. The lazy bridge keeps
 * that shape: next/dynamic renders it in the same sibling slot.
 */
export function TempoWalletProvider({ children }: { children: React.ReactNode }) {
  const [appId, setAppId] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    // Shared with the join page and the dashboard, which ask for the same
    // room's config at boot (lib/api.ts).
    fetchPublicConfig('default')
      .then(({ body }) => {
        if (cancelled) return
        const id = (body as { privy?: { appId?: string | null } }).privy?.appId || null
        if (id) {
          // Start the download now and answer sign-in taps with "still
          // loading" while it runs, never "unavailable".
          loadPrivyBridge().catch(() => { /* the render's own import reports it */ })
          installLoadingBridge()
        }
        setAppId(id)
      })
      .catch(() => {
        if (!cancelled) setAppId(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The sign-in modal wears Holler: azure strap accent (--hl-strap, the same
  // in both themes) on Privy's own light or dark ground, following the theme
  // the page is in (next-themes resolves 'system' to one of the two). Until
  // the theme is known it reads as dark, the old fixed value.
  const { resolvedTheme } = useTheme()
  const privyTheme: 'light' | 'dark' = resolvedTheme === 'light' ? 'light' : 'dark'

  return (
    <>
      {appId === undefined ? null : appId ? (
        <PrivyBridge appId={appId} privyTheme={privyTheme} />
      ) : (
        <UnconfiguredBridge />
      )}
      {children}
    </>
  )
}
