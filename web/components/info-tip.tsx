'use client'

// INFO TIP: the detail a label cannot hold, behind a small "i". A mouse opens
// it on hover; keyboard focus opens it; a tap toggles it (phones have no
// hover, and the focus a tap brings must not open it, or the tap's own click
// shuts it again in the same touch). A tap on the open tip closes it rather
// than passing through to the control underneath. A mouse click on a tip that
// is already open keeps it open. It is a sibling of the control it explains,
// never inside a <button>.
//
// Closed, the tip takes no layout at all (display: none in globals.css): a
// faded tip near the right edge used to widen the page and make a phone pan
// sideways. Open, it is kept inside the screen: an "i" in the right half
// anchors the tip to its own right edge instead of centring it.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

const GUTTER = 8

export function InfoTip({ text, label = 'More info', className }: { text: string; label?: string; className?: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<{ side: 'center' | 'start' | 'end'; room: number | null }>({ side: 'center', room: null })
  const rootRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLSpanElement>(null)
  // The pointer behind the next click: '' for a keyboard press.
  const pointer = useRef('')

  useLayoutEffect(() => {
    if (!open || !btnRef.current || !popRef.current) return
    const vw = document.documentElement.clientWidth
    const r = btnRef.current.getBoundingClientRect()
    const mid = r.left + r.width / 2
    if (mid > vw / 2) { setPlace({ side: 'end', room: Math.max(0, r.right - GUTTER) }); return }
    const w = popRef.current.offsetWidth
    if (mid - w / 2 < GUTTER) setPlace({ side: 'start', room: Math.max(0, vw - r.left - GUTTER) })
    else setPlace({ side: 'center', room: null })
  }, [open])

  // A press anywhere else closes it. Blur alone misses Safari, where a tap
  // never focuses the button.
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const style = place.room != null ? ({ ['--itip-room' as string]: `${place.room}px` } as CSSProperties) : undefined
  return (
    <span
      ref={rootRef}
      className={['itip', className].filter(Boolean).join(' ')}
      data-open={open}
      data-side={place.side}
      style={style}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') setOpen(true) }}
      onPointerLeave={(event) => { if (event.pointerType === 'mouse') setOpen(false) }}
    >
      <button
        ref={btnRef}
        type="button"
        className="itip-btn"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onPointerDown={(event) => { pointer.current = event.pointerType }}
        onClick={(event) => {
          event.preventDefault(); event.stopPropagation()
          const by = pointer.current
          pointer.current = ''
          if (by === 'mouse') setOpen(true)
          else setOpen((value) => !value)
        }}
        onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) setOpen(true) }}
        onBlur={(event) => { if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false) }}
        onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}
      >i</button>
      <span
        ref={popRef}
        role="tooltip"
        id={id}
        className="itip-pop"
        // Keeps the "i" focused through the press, so its blur cannot close
        // the tip before this click lands and drop the click on what lies under.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(false) }}
      >{text}</span>
    </span>
  )
}
