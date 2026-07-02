// Backend origin helpers. The Express backend and this Next app now run in
// ONE process on one port (../server.js mounts Next as its fallthrough
// handler), so at runtime the backend origin IS the page origin. The env
// override remains for unusual split-process setups.

const PUBLIC_BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || null

/** Backend HTTP origin — same origin as the page in the unified app. */
export function backendHttpUrl(): string {
  if (PUBLIC_BACKEND_URL) return PUBLIC_BACKEND_URL.replace(/\/$/, '')
  if (typeof window !== 'undefined') return window.location.origin
  return 'http://localhost:3000'
}

/** ws:// or wss:// URL of the backend WebSocket server (root path). */
export function backendWsUrl(): string {
  return backendHttpUrl().replace(/^http/, 'ws')
}
