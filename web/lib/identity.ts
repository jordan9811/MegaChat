// "Who am I" and "what is my balance", asked once per page burst.
//
// Every sign-in surface used to ask on its own: three useAccount instances,
// RoomProvider twice and the join page's identity line, so a cold /join sent
// /api/auth/me five times in its first second (audit web-35). These share one
// request. A plain module, not 'use client': join-page.ts imports it too.

// siteAdmin: present (true) only for the site's owner, so the account menu can
// offer the hidden /dev page (site-settings.js).
export type Identity = { provider: string; username: string; handle: string; siteAdmin?: boolean } | null

// A sign-in mints the handle server-side and announces it with
// megachat:identity. Bumping the epoch here, at import time, means this
// listener runs before any reader's own listener for the same event, so every
// reader asks again and they all share the one fresh request.
let epoch = 0
if (typeof window !== 'undefined') {
  window.addEventListener('megachat:identity', () => { epoch++ })
}

// An answer stays good this long. Long enough to absorb the boot burst, short
// enough that a later question (the bounty terms opening minutes after load,
// after a sign-in in another tab) gets a fresh one.
const FRESH_MS = 10_000

let cached: { epoch: number; at: number | null; p: Promise<Identity> } | null = null

export function fetchIdentity(): Promise<Identity> {
  const mine = epoch
  const stale = !cached || cached.epoch !== mine || (cached.at != null && Date.now() - cached.at > FRESH_MS)
  if (stale) {
    const entry: { epoch: number; at: number | null; p: Promise<Identity> } = { epoch: mine, at: null, p: Promise.resolve(null) }
    entry.p = fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((me) => (me?.identity ?? null) as Identity)
    entry.p.then(() => { entry.at = Date.now() }, () => {
      // A failed answer must not stick: the next reader asks again.
      if (cached === entry) cached = null
    })
    cached = entry
  }
  const p = cached!.p
  // A sign-in landed while this request was out: the answer is from before it,
  // so hand the caller the newer one instead.
  return p.then((id) => (epoch === mine ? id : fetchIdentity()))
}

// /api/balance/<addr> is an on-chain read; each useAccount instance with an
// address used to make its own. One in-flight request per address, and a
// short memo so a menu opening right after load does not ask again.
const BALANCE_FRESH_MS = 5_000
const balances = new Map<string, { at: number | null; p: Promise<{ available?: string | null } | null> }>()

export function fetchBalance(address: string): Promise<{ available?: string | null } | null> {
  const key = address.toLowerCase()
  const hit = balances.get(key)
  if (hit && (hit.at == null || Date.now() - hit.at <= BALANCE_FRESH_MS)) return hit.p
  const entry: { at: number | null; p: Promise<{ available?: string | null } | null> } = { at: null, p: Promise.resolve(null) }
  entry.p = fetch(`/api/balance/${address}`)
    .then((r) => (r.ok ? r.json() : null))
  entry.p.then(() => { entry.at = Date.now() }, () => { if (balances.get(key) === entry) balances.delete(key) })
  balances.set(key, entry)
  return entry.p
}
