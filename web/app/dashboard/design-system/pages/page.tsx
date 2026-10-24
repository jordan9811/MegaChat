import type { Metadata } from 'next'
import { PageMockSuite } from '@/components/design-system/page-mock-suite'
import './page-mocks.css'

export const metadata: Metadata = {
  title: 'Holler page mock suite',
  robots: { index: false, follow: false },
}

export default function PageMocksPage() {
  return (
    <main className="page-mocks-root">
      <PageMockSuite />
    </main>
  )
}
