'use client'

// The account state behind every sign-in control on the site.
//
// This used to live inside header-auth.tsx, which is welded to the old neon
// theme. The new landing/board/create surfaces need the SAME behaviour in a
// different skin, and a second copy of auth logic is how two sign-in buttons
// start disagreeing about whether you are signed in. So the state lives here
// and the components are only presentation.

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchBalance, fetchIdentity, type Identity } from '@/lib/identity'

export type { Identity }

export type WalletState = {
  configured: boolean
  ready: boolean
  authenticated: boolean
  address: string | null
  displayName: string | null
  modalOpen: boolean
}

const EMPTY_WALLET: WalletState = {
  configured: false,
  ready: false,
  authenticated: false,
  address: null,
  displayName: null,
  modalOpen: false,
}

function readWallet(): WalletState {
  const MW = typeof window !== 'undefined' ? window.MegaWallet : undefined
  return {
    configured: !!MW?.configured,
    ready: !!MW?.ready,
    authenticated: !!MW?.authenticated,
    address: MW?.address ?? null,
    displayName: MW?.displayName ?? null,
    modalOpen: !!MW?.modalOpen,
  }
}

export function useAccount(menuOpen = false) {
  const [identity, setIdentity] = useState<Identity>(null)
  const [loaded, setLoaded] = useState(false)
  const [wallet, setWallet] = useState<WalletState>(EMPTY_WALLET)
  const [balance, setBalance] = useState<string | null>(null)
  // What the balance slot can honestly say: no wallet ('none'), a read in
  // flight ('loading'), a read that failed ('error'), or the figure
  // ('ready'). A failed read used to be swallowed, leaving "…" forever.
  const [balanceStatus, setBalanceStatus] = useState<'none' | 'loading' | 'ready' | 'error'>('none')
  const [connectingBalance, setConnectingBalance] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const signInTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (signInTimer.current) clearTimeout(signInTimer.current) }, [])

  useEffect(() => {
    fetchIdentity()
      .then(setIdentity)
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
      fetchIdentity().then(setIdentity).catch(() => {})
    }
    window.addEventListener('megachat:identity', onIdentity)
    return () => window.removeEventListener('megachat:identity', onIdentity)
  }, [])

  const refreshBalance = useCallback((address: string) => {
    setBalanceStatus((s) => (s === 'ready' ? s : 'loading'))
    fetchBalance(address)
      .then((d) => {
        const n = d?.available != null ? parseFloat(d.available) : NaN
        if (Number.isFinite(n)) { setBalance(n.toFixed(2)); setBalanceStatus('ready') }
        else setBalanceStatus('error')
      })
      .catch(() => setBalanceStatus('error'))
  }, [])

  useEffect(() => {
    if (wallet.address) refreshBalance(wallet.address)
    else { setBalance(null); setBalanceStatus('none') }
  }, [wallet.address, refreshBalance])

  /** Read the balance again (the "Couldn't load · Retry" slot). */
  const retryBalance = useCallback(() => {
    if (wallet.address) refreshBalance(wallet.address)
  }, [wallet.address, refreshBalance])

  useEffect(() => {
    if (menuOpen && wallet.address) refreshBalance(wallet.address)
  }, [menuOpen, wallet.address, refreshBalance])

  // Fire-and-forget: open Privy's modal and return. Reactive state updates the
  // chip on success, and dismissing the modal flips modalOpen back to false —
  // nothing hangs waiting on a promise that never settles.
  const openSignIn = useCallback(() => {
    setAuthError(null)
    const MW = window.MegaWallet
    // Only an installed bridge can say sign-in is missing. No bridge yet means
    // the config is still on its way; a configured one that is not ready is
    // the Privy chunk still downloading (tempo-wallet.tsx).
    if (MW && !MW.configured) { setAuthError('Sign-in is unavailable on this server.'); return }
    if (!MW || !MW.ready) { setAuthError('Sign-in is still loading. Wait a moment, then retry.'); return }
    MW.openLogin()
    if (signInTimer.current) clearTimeout(signInTimer.current)
    signInTimer.current = setTimeout(() => {
      if (!window.MegaWallet?.modalOpen && !window.MegaWallet?.authenticated) {
        setAuthError('Sign-in could not open on this address. Refresh and retry. Your work is still here.')
      }
    }, 2500)
  }, [])

  // Signed in (has an identity) but the embedded wallet is missing.
  // openLogin() no-ops when authenticated, so this uses connect().
  const connectBalance = useCallback(async () => {
    if (!window.MegaWallet?.configured || connectingBalance) return
    setConnectingBalance(true)
    setAuthError(null)
    try {
      await window.MegaWallet.connect()
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : 'Balance could not connect. Retry when ready.')
    } finally {
      setConnectingBalance(false)
    }
  }, [connectingBalance])

  const signOut = useCallback(async () => {
    // Both halves: the OAuth identity cookie AND the Privy session.
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    if (window.MegaWallet?.authenticated) {
      await window.MegaWallet.logout().catch(() => {})
    }
    window.location.reload()
  }, [])

  const signedIn = !!identity || !!wallet.address

  // NEVER a wallet address here. This is a consumer app: you are your name,
  // and hex on a button is the opposite of that. The address lives inside the
  // dropdown for the people who actually want it.
  const chipLabel = identity
    ? `@${identity.handle}`
    : wallet.displayName
      ? `@${wallet.displayName}`
      : 'Account'

  return {
    loaded,
    identity,
    wallet,
    balance,
    balanceStatus,
    retryBalance,
    signedIn,
    chipLabel,
    openSignIn,
    authError,
    connectBalance,
    connectingBalance,
    signOut,
  }
}
