'use client'

// The obs-websocket password the one-click flow stores. THE PASSWORD NEVER
// LEAVES THIS BROWSER: it is read only to open the same local connection to
// OBS. One key, one reader, one announcement, for the three surfaces that use
// it (obs-oneclick.tsx, overlay-health-card.tsx, use-obs-audio-check.ts).

import { useEffect, useState } from 'react'

export const LS_OBS_PASSWORD = 'mc_obs_ws_password'

// Fired on this page when OBS has just accepted the stored password.
const OBS_PASSWORD_EVENT = 'mc-obs-password'

export function readObsPassword(): string | null {
  try { return localStorage.getItem(LS_OBS_PASSWORD) || null } catch { return null }
}

export function writeObsPassword(value: string) {
  try { localStorage.setItem(LS_OBS_PASSWORD, value) } catch { /* storage blocked: kept for this visit only */ }
}

/** OBS just accepted the stored password: every reader on the page re-reads it. */
export function announceObsPassword() {
  window.dispatchEvent(new Event(OBS_PASSWORD_EVENT))
}

/**
 * The stored password, kept current. It used to be read once on mount, so a
 * streamer who connected OBS on the dashboard had no overlay-visibility watch
 * until a reload, and a hidden overlay kept billing guests (audit web-6). It
 * follows a successful connect on this page at once, and a change made in
 * another tab once the typing there stops (each keystroke is a write, and a
 * half-typed password is not worth an OBS login attempt).
 */
export function useObsPassword(): string | null {
  const [password, setPassword] = useState<string | null>(null)
  useEffect(() => {
    const sync = () => setPassword(readObsPassword())
    sync()
    let settle: ReturnType<typeof setTimeout> | null = null
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LS_OBS_PASSWORD && e.key !== null) return
      if (settle) clearTimeout(settle)
      settle = setTimeout(sync, 1000)
    }
    window.addEventListener(OBS_PASSWORD_EVENT, sync)
    window.addEventListener('storage', onStorage)
    return () => {
      if (settle) clearTimeout(settle)
      window.removeEventListener(OBS_PASSWORD_EVENT, sync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return password
}
