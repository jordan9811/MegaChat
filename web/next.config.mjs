/** @type {import('next').NextConfig} */

// The real backend (Express + WebSocket in ../server.js) keeps all payment,
// meter, auth, and seat-lifecycle logic. Next.js only proxies HTTP API calls
// to it; WebSocket connections go directly to the backend origin.
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000'

const nextConfig = {
  turbopack: {
    root: import.meta.dirname,
  },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${BACKEND_URL}/api/:path*` },
      // Passkey wallet ESM bundle (built by scripts/build-passkey.mjs, served
      // by Express) — proxied so the join page can import it same-origin.
      {
        source: '/passkey-wallet.bundle.js',
        destination: `${BACKEND_URL}/passkey-wallet.bundle.js`,
      },
    ]
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
