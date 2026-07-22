'use client'

// Dashboard is no longer just "create room": three sections — Rooms
// (create/manage, the existing grid), Account, and Defaults. Deep-linkable
// via ?section= so the header chip's Account item lands directly here.

import { useEffect, useState, type ReactNode } from 'react'
import { LayoutDashboard, UserRound, SlidersHorizontal } from 'lucide-react'
import { AccountCard, DefaultsCard } from '@/components/account-panel'
import { cn } from '@/lib/utils'

type Section = 'rooms' | 'account' | 'defaults'

const TABS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'rooms', label: 'Rooms', icon: <LayoutDashboard className="size-4" /> },
  { id: 'account', label: 'Account', icon: <UserRound className="size-4" /> },
  { id: 'defaults', label: 'Defaults', icon: <SlidersHorizontal className="size-4" /> },
]

function sectionFromUrl(): Section {
  if (typeof window === 'undefined') return 'rooms'
  const s = new URLSearchParams(window.location.search).get('section')
  return s === 'account' || s === 'defaults' ? s : 'rooms'
}

export function DashboardSections({ rooms }: { rooms: ReactNode }) {
  // Read the deep-link AFTER mount — SSR always renders 'rooms', and
  // useSearchParams would demand a Suspense boundary for no gain here.
  const [section, setSection] = useState<Section>('rooms')
  useEffect(() => {
    setSection(sectionFromUrl())
  }, [])

  function go(next: Section) {
    setSection(next)
    const url = next === 'rooms' ? '/dashboard' : `/dashboard?section=${next}`
    window.history.replaceState(null, '', url)
  }

  return (
    <>
      <nav
        aria-label="Dashboard sections"
        className="reveal mb-6 flex w-fit gap-1 rounded-full border border-border bg-input/20 p-1"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            id={`section-${t.id}`}
            aria-current={section === t.id ? 'page' : undefined}
            onClick={() => go(t.id)}
            className={cn(
              'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition-colors',
              section === t.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      {/* Rooms stays MOUNTED when hidden: it owns the live room session
          (WS, seats, autosave) — unmounting it on a tab flip would tear the
          managing session down. */}
      <div style={{ display: section === 'rooms' ? undefined : 'none' }}>{rooms}</div>
      {section === 'account' ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <AccountCard />
          <DefaultsCard />
        </div>
      ) : null}
      {section === 'defaults' ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <DefaultsCard />
          <AccountCard />
        </div>
      ) : null}
    </>
  )
}
