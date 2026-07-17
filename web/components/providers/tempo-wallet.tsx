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

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  PrivyProvider,
  usePrivy,
  useWallets,
  useModalStatus,
  getAccessToken,
  type ConnectedWallet,
} from '@privy-io/react-auth'
import { tempo } from 'viem/chains'

type MegaWalletBridge = {
  configured: boolean
  ready: boolean
  authenticated: boolean
  address: string | null
  /** Human name from the Privy session (twitch > x > google > email).
   *  The UI's fallback so it can NEVER be reduced to showing an address —
   *  works even if the server-side handle mint is failing. */
  displayName: string | null
  /** Is the Privy sign-in modal open right now? Header ties its "opening"
   *  state to this so dismissing the modal always resets the button. */
  modalOpen: boolean
  /** Fire-and-forget: open the sign-in modal, don't await. Reactive state
   *  handles the result, so a dismissed modal can never hang the caller. */
  openLogin: () => void
  connect: () => Promise<string>
  logout: () => Promise<void>
  getProvider: () => Promise<unknown>
}

declare global {
  interface Window {
    MegaWallet?: MegaWalletBridge
  }
}

const TempoChainContext = createContext<number>(tempo.id)
export const useTempoChainId = () => useContext(TempoChainContext)

function emitChange() {
  window.dispatchEvent(new CustomEvent('megawallet:changed'))
}

/**
 * Installs window.MegaWallet and keeps it in sync. Renders NOTHING and does
 * NOT wrap the app — see TempoWalletProvider for why that matters.
 */
function WalletBridge() {
  const { ready, authenticated, login, logout, createWallet, user } = usePrivy()
  const { wallets, ready: walletsReady } = useWallets()
  const { isOpen: modalOpen } = useModalStatus()

  // When the Privy modal CLOSES without the user authenticating, any promise
  // waiting on that sign-in must reject NOW — otherwise the caller (a header
  // button, the join button) sits "Opening…" until a 3-minute timeout. This is
  // the "dismissed and it kept churning, had to refresh" bug.
  const authWaitersRef = useRef<Array<() => void>>([])
  const authRejectersRef = useRef<Array<(e: Error) => void>>([])
  const prevModalOpen = useRef(false)
  useEffect(() => {
    const wasOpen = prevModalOpen.current
    prevModalOpen.current = modalOpen
    if (wasOpen && !modalOpen && !authenticated) {
      authWaitersRef.current.length = 0
      const rejecters = authRejectersRef.current.splice(0)
      rejecters.forEach((reject) => reject(new Error('Sign-in was cancelled.')))
    }
    emitChange() // header derives its "opening" state from modalOpen
  }, [modalOpen, authenticated])

  // Same priority ladder the server uses (privy-identity.js) — kept in sync so
  // the optimistic client name matches the handle that gets minted.
  const displayName: string | null = (() => {
    type Acct = { type: string; username?: string; email?: string; address?: string }
    const accts = (user?.linkedAccounts || []) as unknown as Acct[]
    const f = (t: string) => accts.find((a) => a.type === t)
    return (
      f('twitch_oauth')?.username ||
      f('twitter_oauth')?.username ||
      f('google_oauth')?.email?.split('@')[0] ||
      f('email')?.address?.split('@')[0] ||
      null
    )
  })()

  const embedded: ConnectedWallet | undefined = wallets.find(
    (w) => w.walletClientType === 'privy',
  )

  // connect() spans user-time (typing an email code), so it must never act on
  // the state it captured at click time. This mirror always holds the latest.
  const stateRef = useRef({
    sdkReady: false,
    authenticated: false,
    embedded: undefined as ConnectedWallet | undefined,
  })
  stateRef.current = { sdkReady: ready && walletsReady, authenticated, embedded }

  // connect() resolvers waiting for the embedded wallet to become available.
  const waitersRef = useRef<Array<(w: ConnectedWallet) => void>>([])
  useEffect(() => {
    if (embedded && waitersRef.current.length) {
      const ws = waitersRef.current.splice(0)
      ws.forEach((resolve) => resolve(embedded))
    }
  }, [embedded])

  // resolvers waiting for the SDK itself to finish initializing.
  const readyWaitersRef = useRef<Array<() => void>>([])
  useEffect(() => {
    if (ready && walletsReady && readyWaitersRef.current.length) {
      readyWaitersRef.current.splice(0).forEach((resolve) => resolve())
    }
  }, [ready, walletsReady])

  // authWaitersRef / authRejectersRef declared above (modal-close handler).
  useEffect(() => {
    if (authenticated && authWaitersRef.current.length) {
      authRejectersRef.current.length = 0
      authWaitersRef.current.splice(0).forEach((resolve) => resolve())
    }
  }, [authenticated])

  // ── Identity registration ──
  // Signing in with Privy IS signing in to MegaChat: hand the verified token
  // to our server, which mints/returns the @handle. Runs on every auth (incl.
  // a session restored on page load), so a returning user is simply known —
  // no second sign-in, no claim screen. Idempotent server-side.
  const registeredRef = useRef(false)
  useEffect(() => {
    if (!authenticated || registeredRef.current) return
    registeredRef.current = true
    ;(async () => {
      try {
        const token = await getAccessToken()
        if (!token) return
        const r = await fetch('/api/auth/privy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        if (r.ok) window.dispatchEvent(new CustomEvent('megachat:identity'))
      } catch {
        /* identity is a nicety; the wallet still works without a handle */
      }
    })()
  }, [authenticated])

  useEffect(() => {
    const waitForSdk = () =>
      new Promise<void>((resolve, reject) => {
        if (stateRef.current.sdkReady) return resolve()
        readyWaitersRef.current.push(resolve)
        setTimeout(() => {
          const i = readyWaitersRef.current.indexOf(resolve)
          if (i >= 0) {
            readyWaitersRef.current.splice(i, 1)
            reject(new Error('Sign-in service took too long to load — refresh and try again.'))
          }
        }, 20_000)
      })
    const waitForEmbedded = (timeoutMs = 180_000) =>
      new Promise<ConnectedWallet>((resolve, reject) => {
        // Already there (returning user with a live session).
        if (stateRef.current.embedded) return resolve(stateRef.current.embedded)
        waitersRef.current.push(resolve)
        // Modal abandoned / login failed — don't hang the join button forever.
        setTimeout(() => {
          const i = waitersRef.current.indexOf(resolve)
          if (i >= 0) {
            waitersRef.current.splice(i, 1)
            reject(new Error('Sign-in was not completed.'))
          }
        }, timeoutMs)
      })

    window.MegaWallet = {
      configured: true,
      ready: ready && walletsReady,
      authenticated,
      address: embedded?.address ?? null,
      displayName,
      modalOpen,
      openLogin() {
        // Fire-and-forget. If already signed in, opening the login modal is a
        // no-op in Privy; callers that want a wallet use connect() instead.
        if (stateRef.current.authenticated) return
        try { login() } catch { /* SDK not ready — user can retry */ }
      },
      async connect() {
        // login() before the SDK is initialized is a silent no-op — the old
        // freeze: button says "waiting for sign-in", no modal ever opens.
        await waitForSdk()
        // Step 1 — authenticated. Fresh users get the modal; returning
        // sessions skip it entirely.
        if (!stateRef.current.authenticated) {
          login()
          await new Promise<void>((resolve, reject) => {
            if (stateRef.current.authenticated) return resolve()
            authWaitersRef.current.push(resolve)
            // Rejected the instant the modal is dismissed (see the modal-close
            // effect) — no more 3-minute "Opening…" hang.
            authRejectersRef.current.push(reject)
            setTimeout(() => {
              const i = authWaitersRef.current.indexOf(resolve)
              if (i >= 0) authWaitersRef.current.splice(i, 1)
              const j = authRejectersRef.current.indexOf(reject)
              if (j >= 0) authRejectersRef.current.splice(j, 1)
              reject(new Error('Sign-in was not completed.'))
            }, 180_000)
          })
        }
        // Step 2 — embedded wallet, REGARDLESS of which path got us here.
        // Accounts whose wallet creation was interrupted (login succeeds,
        // wallets stay empty — the "double sign-in still doesn't work" bug)
        // get the wallet created explicitly instead of waiting on a
        // createOnLogin that already mis-fired in the past.
        let wallet: ConnectedWallet
        if (stateRef.current.embedded) {
          wallet = stateRef.current.embedded
        } else {
          wallet = await waitForEmbedded(6_000).catch(async () => {
            try {
              await createWallet()
            } catch {
              /* already exists / creating — the waiter below settles it */
            }
            return waitForEmbedded(30_000)
          })
        }
        try {
          await wallet.switchChain(tempo.id)
        } catch {
          // Embedded wallets are created on the configured default chain
          // (Tempo); a failed explicit switch is not fatal for reads.
        }
        emitChange()
        return wallet.address
      },
      async logout() {
        await logout()
        emitChange()
      },
      async getProvider() {
        const wallet = stateRef.current.embedded ?? (await waitForEmbedded())
        return wallet.getEthereumProvider()
      },
    }
    emitChange()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, walletsReady, authenticated, embedded?.address, displayName, modalOpen])

  return null
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
 * the connection is established"). Nothing outside this file uses Privy hooks
 * — children talk to window.MegaWallet — so keeping them at a fixed position
 * costs nothing and makes remounts impossible.
 */
export function TempoWalletProvider({ children }: { children: React.ReactNode }) {
  const [appId, setAppId] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    fetch('/api/config?room=default')
      .then((r) => r.json())
      .then((cfg) => {
        if (!cancelled) setAppId(cfg?.privy?.appId || null)
      })
      .catch(() => {
        if (!cancelled) setAppId(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const providerConfig = useMemo(
    () => ({
      // THE front door — every provider lives in this one modal. Privy speaks
      // Twitch natively, which is what killed the old double sign-in (our own
      // Twitch OAuth for a handle + Privy for a wallet = two logins for one
      // human). Order is the on-screen order: the streamer platforms first.
      loginMethods: ['twitch', 'twitter', 'google', 'email', 'passkey'] as (
        | 'twitch'
        | 'twitter'
        | 'google'
        | 'email'
        | 'passkey'
      )[],
      appearance: {
        theme: 'dark' as const,
        accentColor: '#e91e8c' as `#${string}`,
        walletChainType: 'ethereum-only' as const,
      },
      // Silent signing: per-second session vouchers can't pop a modal each tick.
      embeddedWallets: {
        showWalletUIs: false,
        ethereum: { createOnLogin: 'users-without-wallets' as const },
      },
      defaultChain: tempo,
      supportedChains: [tempo],
    }),
    [],
  )

  return (
    <TempoChainContext.Provider value={tempo.id}>
      {appId === undefined ? null : appId ? (
        <PrivyProvider appId={appId} config={providerConfig}>
          <WalletBridge />
        </PrivyProvider>
      ) : (
        <UnconfiguredBridge />
      )}
      {children}
    </TempoChainContext.Provider>
  )
}
