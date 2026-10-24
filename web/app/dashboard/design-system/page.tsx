import type { Metadata } from 'next'
import { RoomDesignLab } from '@/components/design-system/room-design-lab'
import './design-system.css'

export const metadata: Metadata = {
  title: 'Holler UI direction lab',
  robots: { index: false, follow: false },
}

export default function DesignSystemPage() {
  return (
    <main className="design-lab-page">
      <RoomDesignLab />
    </main>
  )
}
