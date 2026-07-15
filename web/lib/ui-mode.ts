'use client'

// Simple vs Advanced presentation mode. ADVANCED = the app exactly as it is
// (crypto-native). SIMPLE = consumer skin: amounts render as credits
// (1 credit = 1 second of Join Stream), wallet/chain lingo hidden. This is
// PRESENTATION ONLY — same balances, same transactions underneath; nothing
// in the payment path ever reads this value.

import { useSyncExternalStore } from 'react'

export type UiMode = 'advanced' | 'simple'
const KEY = 'mc-ui-mode'
const EVT = 'mc-ui-mode-changed'

export function getUiMode(): UiMode {
  if (typeof document === 'undefined') return 'advanced'
  return document.documentElement.dataset.ui === 'simple' ? 'simple' : 'advanced'
}

export function setUiMode(mode: UiMode) {
  try {
    localStorage.setItem(KEY, mode)
  } catch { /* private browsing */ }
  document.documentElement.dataset.ui = mode
  window.dispatchEvent(new CustomEvent(EVT, { detail: mode }))
}

function subscribe(cb: () => void) {
  window.addEventListener(EVT, cb)
  return () => window.removeEventListener(EVT, cb)
}

/** React hook — re-renders on toggle. SSR snapshot is 'advanced'. */
export function useUiMode(): UiMode {
  return useSyncExternalStore(subscribe, getUiMode, () => 'advanced')
}

/** Inline bootstrap for <head>-adjacent injection (runs before paint). */
export const UI_MODE_BOOT_SCRIPT = `(function(){try{var m=localStorage.getItem('${KEY}');document.documentElement.dataset.ui=(m==='simple'?'simple':'advanced');}catch(e){document.documentElement.dataset.ui='advanced';}})()`
