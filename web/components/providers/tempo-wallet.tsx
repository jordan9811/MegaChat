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
import { PrivyProvider, usePrivy, useWallets, type ConnectedWallet } from '@privy-io/react-auth'
import { tempo } from 'viem/chains'

type MegaWalletBridge = {
  configured: boolean
  ready: boolean
  authenticated: boolean
  address: string | null
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

/** Inner component with Privy hooks; keeps window.MegaWallet in sync. */
function WalletBridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, logout, createWallet } = usePrivy()
  const { wallets, ready: walletsReady } = useWallets()

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

  // resolvers waiting for authentication (modal completed).
  const authWaitersRef = useRef<Array<() => void>>([])
  useEffect(() => {
    if (authenticated && authWaitersRef.current.length) {
      authWaitersRef.current.splice(0).forEach((resolve) => resolve())
    }
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
            setTimeout(() => {
              const i = authWaitersRef.current.indexOf(resolve)
              if (i >= 0) {
                authWaitersRef.current.splice(i, 1)
                reject(new Error('Sign-in was not completed.'))
              }
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
  }, [ready, walletsReady, authenticated, embedded?.address])

  return <>{children}</>
}

/** Marks the bridge as unconfigured so the UI can say exactly what's missing. */
function UnconfiguredBridge({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    window.MegaWallet = {
      configured: false,
      ready: true,
      authenticated: false,
      address: null,
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
  return <>{children}</>
}

/**
 * Fetches the Privy app id from the backend config, then mounts the Privy
 * provider on the Tempo chain. Children always render — the join page works
 * in a degraded (MetaMask-only) mode when Privy isn't configured yet.
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
      // Email first — crypto stays invisible. Passkey + socials behind it.
      loginMethods: ['email', 'passkey', 'google', 'twitter'] as (
        | 'email'
        | 'passkey'
        | 'google'
        | 'twitter'
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

  if (appId === undefined) {
    // Config still loading — render children so the page paints instantly.
    return <>{children}</>
  }

  if (!appId) {
    return <UnconfiguredBridge>{children}</UnconfiguredBridge>
  }

  return (
    <TempoChainContext.Provider value={tempo.id}>
      <PrivyProvider appId={appId} config={providerConfig}>
        <WalletBridge>{children}</WalletBridge>
      </PrivyProvider>
    </TempoChainContext.Provider>
  )
}
