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
  const { ready, authenticated, login, logout } = usePrivy()
  const { wallets, ready: walletsReady } = useWallets()

  const embedded: ConnectedWallet | undefined = wallets.find(
    (w) => w.walletClientType === 'privy',
  )

  // connect() resolvers waiting for the embedded wallet to become available.
  const waitersRef = useRef<Array<(w: ConnectedWallet) => void>>([])

  useEffect(() => {
    if (embedded && waitersRef.current.length) {
      const ws = waitersRef.current.splice(0)
      ws.forEach((resolve) => resolve(embedded))
    }
  }, [embedded])

  useEffect(() => {
    const waitForEmbedded = () =>
      new Promise<ConnectedWallet>((resolve, reject) => {
        // Already there (returning user with a live session).
        if (embedded) return resolve(embedded)
        waitersRef.current.push(resolve)
        // Modal abandoned / login failed — don't hang the join button forever.
        setTimeout(() => {
          const i = waitersRef.current.indexOf(resolve)
          if (i >= 0) {
            waitersRef.current.splice(i, 1)
            reject(new Error('Sign-in was not completed.'))
          }
        }, 180_000)
      })

    window.MegaWallet = {
      configured: true,
      ready: ready && walletsReady,
      authenticated,
      address: embedded?.address ?? null,
      async connect() {
        if (!authenticated) login()
        const wallet = await waitForEmbedded()
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
        const wallet = embedded ?? (await waitForEmbedded())
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
