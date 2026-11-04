'use client'

// Retro/Classic switch, beside the sun/moon in every page header. Retro is the
// default look; Classic is the neon look the site shipped with before it. The
// choice lives on <html data-style>, set before paint by STYLE_BOOT_SCRIPT, so
// this only reads it after mount and flips it. Styles: .hl-st in globals.css.

import { useEffect, useState } from 'react'
import { STYLE_KEY, type HollerStyle } from '@/lib/style-mode-boot'

export function StyleToggle({ className }: { className?: string }) {
  const [style, setStyle] = useState<HollerStyle | null>(null)

  useEffect(() => {
    setStyle(document.documentElement.dataset.style === 'classic' ? 'classic' : 'retro')
  }, [])

  if (!style) {
    return <span className={['hl-st', 'hl-st--placeholder', className].filter(Boolean).join(' ')} aria-hidden="true" />
  }

  const next: HollerStyle = style === 'retro' ? 'classic' : 'retro'
  const flip = () => {
    document.documentElement.dataset.style = next
    try {
      localStorage.setItem(STYLE_KEY, next)
    } catch {
      // storage blocked: the switch still applies for this page
    }
    setStyle(next)
  }

  return (
    <button
      type="button"
      className={['hl-st', className].filter(Boolean).join(' ')}
      aria-label={next === 'classic' ? 'Switch to the classic look' : 'Switch to the retro look'}
      title={next === 'classic' ? 'Switch to the classic look' : 'Switch to the retro look'}
      onClick={flip}
    >
      {next === 'classic' ? 'Classic' : 'Retro'}
    </button>
  )
}
