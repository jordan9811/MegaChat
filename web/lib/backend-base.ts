// The origin a SERVER component fetches our own Express API from. Server
// code only: it reads process.env at request time, and in a browser the
// relative /api path is the right one (lib/backend.ts).
//
// localhost, not 127.0.0.1: server.js answers a 127.0.0.1 host with a 301 to
// localhost (passkeys and localStorage need the one origin), so every loader
// that defaulted to 127.0.0.1 paid a redirect hop per fetch. BASE_URL, when
// set, is the PUBLIC origin and may carry a trailing slash; it is stripped so
// a path never becomes `//api/...`, which resolves to a different host.
export function backendBase(): string {
  const port = process.env.PORT || '3000'
  return (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '')
}
