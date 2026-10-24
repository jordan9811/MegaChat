// The window.MegaWallet contract, shared by the root provider (tempo-wallet.tsx)
// and the lazily loaded Privy half (privy-bridge.tsx). A plain module, so the
// root can install a placeholder without pulling the Privy SDK into the page.

export type MegaWalletBridge = {
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

export function emitChange() {
  window.dispatchEvent(new CustomEvent('megawallet:changed'))
}
