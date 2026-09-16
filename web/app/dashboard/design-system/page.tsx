import type { Metadata } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { RoomDesignLab } from '@/components/design-system/room-design-lab'
import './design-system.css'

export const metadata: Metadata = {
  title: 'MegaChat UI direction lab',
  robots: { index: false, follow: false },
}

const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-ui',
})

export default function DesignSystemPage() {
  return (
    <main className={`${ui.variable} design-lab-page`}>
      <RoomDesignLab />
    </main>
  )
}
