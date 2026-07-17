// NOTE: @vercel/analytics was removed — the app deploys on Railway, so the
// injected /_vercel/insights/script.js could only ever 404 on every page.
import type { Metadata, Viewport } from 'next'
import { Inter, Space_Grotesk, Geist_Mono, Pacifico } from 'next/font/google'
import { ThemeProvider } from '@/components/theme-provider'
import { TempoWalletProvider } from '@/components/providers/tempo-wallet'
import './globals.css'

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] })
const spaceGrotesk = Space_Grotesk({
  variable: '--font-space-grotesk',
  subsets: ['latin'],
  weight: ['500', '600', '700'],
})
const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})
// Brush-script graffiti face for the hero tagline — Pacifico is thick and
// smooth like the brand reference (Kaushan read too thin/gritty).
const graffiti = Pacifico({
  variable: '--font-graffiti',
  subsets: ['latin'],
  weight: '400',
})

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://megachat-production.up.railway.app'
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
        url: '/megachat-hero.png',
        width: 697,
        height: 985,
        alt: 'MegaChat — crowned glitch microphone',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESC,
    images: ['/megachat-hero.png'],
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
      className={`${inter.variable} ${spaceGrotesk.variable} ${geistMono.variable} ${graffiti.variable}`}
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
