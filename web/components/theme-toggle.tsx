'use client'

// Sun/moon switch for every page header (SPEC §5). The theme is unknown on the
// server, so until mount it renders an inert ring of the same size — no layout
// shift and no wrong icon flashing. Styles: .hl-tt in app/globals.css.

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.5 14.1A8.5 8.5 0 1 1 9.9 3.5a6.6 6.6 0 0 0 10.6 10.6Z" />
    </svg>
  )
}

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  if (!mounted) {
    return <span className={['hl-tt', 'hl-tt--placeholder', className].filter(Boolean).join(' ')} aria-hidden="true" />
  }

  const dark = resolvedTheme !== 'light'
  return (
    <button
      type="button"
      className={['hl-tt', className].filter(Boolean).join(' ')}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? <SunIcon key="sun" /> : <MoonIcon key="moon" />}
    </button>
  )
}
