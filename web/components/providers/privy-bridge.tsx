'use client'

// The Privy half of the wallet layer, loaded only when this server has a Privy
// app id. It is the one module that imports @privy-io/react-auth, so the SDK
// (about 600 KB gzip with styled-components and its viem copy) leaves every
// route's first-load JS and downloads in parallel with the page instead
// (audit web-1). tempo-wallet.tsx renders it as a SIBLING of the page through
// next/dynamic and installs a "still loading" bridge until this one mounts.
//
// Moved verbatim from tempo-wallet.tsx (2026-10-24); see that file for the
// window.MegaWallet contract (wallet-bridge.ts holds the type).

import { useEffect, useMemo, useRef } from 'react'
import {
  PrivyProvider,
  usePrivy,
  useWallets,
  useModalStatus,
  getAccessToken,
  type ConnectedWallet,
} from '@privy-io/react-auth'
import { tempo } from 'viem/chains'
import { emitChange } from './wallet-bridge'

/**
 * Installs window.MegaWallet and keeps it in sync. Renders NOTHING and does
 * NOT wrap the app — see TempoWalletProvider (tempo-wallet.tsx) for why that
 * matters.
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

export default function PrivyBridge({ appId, privyTheme }: { appId: string; privyTheme: 'light' | 'dark' }) {
  // Everything but appearance is built once, so a theme switch hands Privy
  // the same loginMethods / embeddedWallets / chain objects it already has.
  const baseConfig = useMemo(
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
      // DO NOT set externalWallets.disableAllExternalWallets here. It looks
      // like the fix for Phantom's "Which extension?" popup and is not: Privy
      // then never initializes its connectors, useWallets().ready stays false
      // forever, and every new sign-in hangs on "still loading" (found in
      // review, 2026-09-25). Privy finds extensions through EIP-6963 — each
      // wallet's own provider — which never shows Phantom's chooser; the popup
      // came from the join page calling window.ethereum on load
      // (_gate-no-wallet-prompt.mjs).
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

  const providerConfig = useMemo(
    () => ({
      ...baseConfig,
      appearance: {
        theme: privyTheme,
        accentColor: '#0a9bff' as `#${string}`,
        logo: '/holler-logo.png',
        walletChainType: 'ethereum-only' as const,
      },
    }),
    [baseConfig, privyTheme],
  )

  return (
    <PrivyProvider appId={appId} config={providerConfig}>
      <WalletBridge />
    </PrivyProvider>
  )
}
