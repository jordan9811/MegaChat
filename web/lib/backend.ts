// Client-side pointers to the real Express backend (../server.js).
// HTTP API calls use relative /api/* paths (proxied by next.config.mjs
// rewrites, so no CORS). WebSockets cannot be proxied by rewrites, so the
// browser connects straight to the backend origin.

const PUBLIC_BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3000'

/** Backend HTTP origin — used for links that must open backend-served pages
 *  (viewer join page, OBS overlay) and for the WebSocket connection. */
export function backendHttpUrl(): string {
  return PUBLIC_BACKEND_URL.replace(/\/$/, '')
}

/** ws:// or wss:// URL of the backend WebSocket server. */
export function backendWsUrl(): string {
  return backendHttpUrl().replace(/^http/, 'ws')
}
