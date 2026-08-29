'use client'

// Which chrome the dashboard wears depends on what you're doing.
//
// CREATING is its own page: it owns the viewport and carries a single thin
// bar, the way the room board does. Wrapping it in the marketing header,
// the lime kicker and the pill tabs put two different designs on one screen
// and read as a half-finished merge — the create panel is the app, and the
// app doesn't wear the marketing site's chrome.
//
// MANAGING keeps the existing shell: header, heading, section tabs, footer.
// It is a control room you return to, and those tabs are how you reach
// Account and Defaults.

import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { useRoom } from '@/components/room-provider'
import { SiteHeader } from '@/components/site-header'
import { SiteFooter } from '@/components/site-footer'
import { DashboardSections } from '@/components/dashboard-sections'
import { DashboardRooms } from '@/components/dashboard-rooms'
import { CreateRoom } from '@/components/create-room/create-room'

export function DashboardShell({ contactHref }: { contactHref: string }) {
  const { mode, switchRoom } = useRoom()
  const params = useSearchParams()

  // "Open a room" has to reach the create page even for someone who already
  // owns one — without this it resumes their existing room and looks like
  // the link is broken.
  const wantsNew = params.get('new') === '1'
  useEffect(() => {
    if (wantsNew && mode === 'managing') switchRoom()
  }, [wantsNew, mode, switchRoom])

  if (mode !== 'managing') return <CreateRoom />

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      <main id="dashboard" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-14 md:py-20">
        <div className="reveal mb-8 flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-widest text-[var(--neon-lime)]">
            Streamer dashboard
          </span>
          <h2 className="font-heading text-3xl font-bold text-foreground">Your room</h2>
          <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">
            Share your links, watch viewers roll onto camera, and tune anything you set up.
          </p>
        </div>

        <DashboardSections rooms={<DashboardRooms />} />
      </main>

      <SiteFooter contactHref={contactHref} />
    </div>
  )
}
