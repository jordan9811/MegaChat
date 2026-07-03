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
}

export default nextConfig
