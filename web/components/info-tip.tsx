'use client'

// INFO TIP: the detail a label cannot hold, behind a small "i". Hover or
// focus shows it, a tap toggles it (phones have no hover). It is a sibling of
// the control it explains, never inside a <button>.
import { useId, useState } from 'react'

export function InfoTip({ text, label = 'More info', className }: { text: string; label?: string; className?: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <span className={['itip', className].filter(Boolean).join(' ')} data-open={open} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="itip-btn"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}
      >i</button>
      <span role="tooltip" id={id} className="itip-pop">{text}</span>
    </span>
  )
}
