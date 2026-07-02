/** @type {import('next').NextConfig} */

// This app is mounted INSIDE the Express backend process (../server.js custom
// server): Express claims /api/*, /overlay, the WebSocket, and public/ static
// files first; everything else falls through to Next. Same origin, so no
// rewrites/proxying is needed (a /api rewrite here would loop back into the
// same server).
const nextConfig = {
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
