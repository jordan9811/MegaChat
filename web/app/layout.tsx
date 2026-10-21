// NOTE: @vercel/analytics was removed — the app deploys on Railway, so the
// injected /_vercel/insights/script.js could only ever 404 on every page.
import type { Metadata, Viewport } from 'next'
import { Archivo, Pacifico, Plus_Jakarta_Sans, Space_Mono } from 'next/font/google'
import { ThemeProvider } from '@/components/theme-provider'
import { TempoWalletProvider } from '@/components/providers/tempo-wallet'
import './globals.css'
import './product.css'

const ui = Plus_Jakarta_Sans({ variable: '--font-ui', subsets: ['latin'], weight: ['400', '500', '600', '700', '800'] })
// Brush-script graffiti face for the hero tagline — Pacifico is thick and
// smooth like the brand reference (Kaushan read too thin/gritty).
// Display face for headlines and the wordmark, and a mono for anything that
// reads like a readout (coordinates, meters, meta). Site-wide so every page
// can reach them; the UI face stays Jakarta.
// Variable Archivo with the width axis, so the Holler mark's font-stretch: 112%
// is a real wider cut, not a synthesized one.
const display = Archivo({ variable: '--font-display', subsets: ['latin'], axes: ['wdth'] })
const code = Space_Mono({ variable: '--font-code', subsets: ['latin'], weight: ['400', '700'] })
const graffiti = Pacifico({
  variable: '--font-graffiti',
  subsets: ['latin'],
  weight: '400',
})

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://megachat.fun'
const SITE_TITLE = 'Holler — Skip the chat. Be the stream.'
const SITE_DESC =
  'Viewers pay per-second in USDC to put their camera on your live broadcast. One-tap passkey to go live, unused balance refunds automatically. Turn chat into content.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESC,
  applicationName: 'Holler',
  keywords: [
    'live streaming',
    'creator monetization',
    'USDC',
    'pay per second',
    'OBS overlay',
    'passkey wallet',
    'Arc network',
  ],
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'Holler',
    title: SITE_TITLE,
    description: SITE_DESC,
    images: [
      {
        // Purpose-built 1200x630 card (scripts/generate-og.mjs) — the old
        // portrait hero PNG cropped badly in every link preview.
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Holler — the word HOLLER on a deep-violet broadcast strap, the O a red record button',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESC,
    images: ['/og.png'],
  },
  // Versioned: browsers cache a tab icon by its URL and ignore no-cache, so a
  // new icon needs a new URL. Bump ?v= whenever icon.svg or apple-icon.png change.
  icons: {
    icon: '/icon.svg?v=2',
    apple: '/apple-icon.png?v=2',
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark light',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f5fa' },
    { media: '(prefers-color-scheme: dark)', color: '#060a17' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${ui.variable} ${graffiti.variable} ${display.variable} ${code.variable}`}
      data-scroll-behavior="smooth"
    >
      <body className="bg-background font-sans antialiased">
        {/* Simple/Advanced presentation mode — applied before paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var m=localStorage.getItem('mc-ui-mode');document.documentElement.dataset.ui=(m==='simple'?'simple':'advanced');}catch(e){document.documentElement.dataset.ui='advanced';}})()",
          }}
        />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {/* App-wide so every header can offer login + balance, and a
              returning Privy session is adopted on ANY page — not just /join. */}
          <TempoWalletProvider>{children}</TempoWalletProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
