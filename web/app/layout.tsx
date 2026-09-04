// NOTE: @vercel/analytics was removed — the app deploys on Railway, so the
// injected /_vercel/insights/script.js could only ever 404 on every page.
import type { Metadata, Viewport } from 'next'
import { Plus_Jakarta_Sans, Pacifico } from 'next/font/google'
import { ThemeProvider } from '@/components/theme-provider'
import { TempoWalletProvider } from '@/components/providers/tempo-wallet'
import './globals.css'
import './product.css'

const ui = Plus_Jakarta_Sans({ variable: '--font-ui', subsets: ['latin'], weight: ['400', '500', '600', '700', '800'] })
// Brush-script graffiti face for the hero tagline — Pacifico is thick and
// smooth like the brand reference (Kaushan read too thin/gritty).
const graffiti = Pacifico({
  variable: '--font-graffiti',
  subsets: ['latin'],
  weight: '400',
})

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://megachat.fun'
const SITE_TITLE = 'MegaChat — Skip the chat. Be the stream.'
const SITE_DESC =
  'Viewers pay per-second in USDC to put their camera on your live broadcast. One-tap passkey to go live, unused balance refunds automatically. Turn chat into content.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESC,
  applicationName: 'MegaChat',
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
    siteName: 'MegaChat',
    title: SITE_TITLE,
    description: SITE_DESC,
    images: [
      {
        // Purpose-built 1200x630 card (scripts/generate-og.mjs) — the old
        // portrait hero PNG cropped badly in every link preview.
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'MegaChat — crowned glitch microphone and wordmark',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESC,
    images: ['/og.png'],
  },
  icons: {
    icon: '/icon.svg',
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark light',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4ecfa' },
    { media: '(prefers-color-scheme: dark)', color: '#1a1029' },
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
      className={`${ui.variable} ${graffiti.variable}`}
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
          defaultTheme="dark"
          enableSystem={false}
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
