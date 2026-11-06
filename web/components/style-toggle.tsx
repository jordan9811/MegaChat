'use client'

// V1 / V2 look switch (V1 = classic, V2 = retro), beside the sun/moon in every page header. Retro is the
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
      aria-label={next === 'classic' ? 'Switch to look V1' : 'Switch to look V2'}
      title={next === 'classic' ? 'Switch to look V1' : 'Switch to look V2'}
      onClick={flip}
    >
      <span className="hl-st-v" data-on={style === 'classic'}>V1</span>
      <span className="hl-st-v" data-on={style === 'retro'}>V2</span>
    </button>
  )
}
