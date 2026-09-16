import type { Metadata } from 'next'
import { Archivo, Plus_Jakarta_Sans } from 'next/font/google'
import { PageMockSuite } from '@/components/design-system/page-mock-suite'
import './page-mocks.css'

export const metadata: Metadata = {
  title: 'MegaChat page mock suite',
  robots: { index: false, follow: false },
}

const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

const display = Archivo({
  subsets: ['latin'],
  weight: ['800'],
  variable: '--font-display',
})

export default function PageMocksPage() {
  return (
    <main className={`${ui.variable} ${display.variable} page-mocks-root`}>
      <PageMockSuite />
    </main>
  )
}
