/** @type {import('next').NextConfig} */

// This app is mounted INSIDE the Express backend process (../server.js custom
// server): Express claims /api/*, /overlay, the WebSocket, and public/ static
// files first; everything else falls through to Next. Same origin, so no
// rewrites/proxying is needed (a /api rewrite here would loop back into the
// same server).
const nextConfig = {
  // Dev-only: Next 16 rejects /_next requests whose Host isn't allowlisted,
  // which breaks testing the DEV server through cloudflared tunnels or other
  // mapped hostnames ("Unauthorized" on /_next/*). Prod builds are unaffected.
  allowedDevOrigins: ['*.trycloudflare.com', '*.up.railway.app', 'railway-sim.test'],
  turbopack: {
    root: import.meta.dirname,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // The likeliest typos are the nav labels themselves: the pages live at /app
  // and /bounty. Temporary (307), so a browser never caches them if either
  // name is ever given a page of its own. They only run for what Express let
  // fall through, so a room that owns one of these handles (server.js
  // /:handle) still wins; 'rooms' is reserved (rooms-store.js), 'bounties'
  // is not.
  async redirects() {
    return [
      { source: '/rooms', destination: '/app', permanent: false },
      { source: '/bounties', destination: '/bounty', permanent: false },
    ]
  },
}

export default nextConfig
