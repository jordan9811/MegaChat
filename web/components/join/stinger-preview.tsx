'use client'

// Mock camera-square preview for the stinger picker. Plays the SAME CSS
// animations the OBS overlay uses (ported in join.css) on a fake tile so
// viewers can see an entrance/exit before buying a seat. Purely cosmetic:
// reads the two <select>s the legacy join script owns, never touches the
// real camera iframes or any join/payment logic.

import { useEffect, useRef } from 'react'

// Mirrors FLY_INS / FLY_OUTS in public/overlay.html (class + duration + fx).
const FLY_INS: Record<string, { cls: string; ms: number; fx?: string }> = {
  '': { cls: 'joining', ms: 700 },
  storm: { cls: 'in-storm', ms: 1400, fx: 'fx-storm' },
  proroll: { cls: 'in-proroll', ms: 900, fx: 'fx-proroll' },
  callme: { cls: 'in-callme', ms: 1200, fx: 'fx-callme' },
  breaking: { cls: 'in-breaking', ms: 1300, fx: 'fx-breaking' },
  wildin: { cls: 'in-wildin', ms: 1400, fx: 'fx-scanline' },
}
const FLY_OUTS: Record<string, { cls: string; ms: number }> = {
  '': { cls: 'out-default', ms: 460 },
  crt: { cls: 'out-crt', ms: 800 },
  crumble: { cls: 'out-crumble', ms: 1200 },
  zapped: { cls: 'out-zapped', ms: 1100 },
  wildout: { cls: 'out-wildout', ms: 1000 },
}

const ALL_ANIM_CLASSES = [
  ...Object.values(FLY_INS).map((v) => v.cls),
  ...Object.values(FLY_OUTS).map((v) => v.cls),
]

export function StingerPreview() {
  const tileRef = useRef<HTMLDivElement>(null)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    const tile = tileRef.current
    const flyIn = document.getElementById('flyInSelect') as HTMLSelectElement | null
    const flyOut = document.getElementById('flyOutSelect') as HTMLSelectElement | null
    if (!tile || !flyIn || !flyOut) return

    const timers = timersRef.current
    const later = (fn: () => void, ms: number) => {
      timers.push(setTimeout(fn, ms))
    }
    const clearTimers = () => {
      timers.forEach(clearTimeout)
      timers.length = 0
    }

    const reset = () => {
      clearTimers()
      tile.classList.remove(...ALL_ANIM_CLASSES)
      tile.querySelectorAll('.stinger-fx').forEach((n) => n.remove())
      tile.style.opacity = ''
      // force reflow so re-adding a class restarts its animation
      void tile.offsetWidth
    }

    const playIn = () => {
      reset()
      const fin = FLY_INS[flyIn.value] || FLY_INS['']
      if (fin.fx) {
        const fx = document.createElement('div')
        fx.className = 'stinger-fx ' + fin.fx
        tile.appendChild(fx)
        later(() => fx.remove(), fin.ms + 120)
      }
      tile.classList.add(fin.cls)
      later(() => tile.classList.remove(fin.cls), fin.ms + 50)
    }

    const playOut = () => {
      reset()
      const fout = FLY_OUTS[flyOut.value] || FLY_OUTS['']
      tile.classList.add(fout.cls)
      // pop the tile back after the exit so the preview never stays blank
      later(() => {
        tile.classList.remove(fout.cls)
        void tile.offsetWidth
        tile.classList.add('joining')
        later(() => tile.classList.remove('joining'), 750)
      }, fout.ms + 450)
    }

    const replay = () => {
      playIn()
      const fin = FLY_INS[flyIn.value] || FLY_INS['']
      later(() => playOut(), fin.ms + 900)
    }

    const btn = document.getElementById('stingerReplayBtn')
    flyIn.addEventListener('change', playIn)
    flyOut.addEventListener('change', playOut)
    btn?.addEventListener('click', replay)

    return () => {
      clearTimers()
      flyIn.removeEventListener('change', playIn)
      flyOut.removeEventListener('change', playOut)
      btn?.removeEventListener('click', replay)
    }
  }, [])

  return (
    <div className="stinger-preview sm:col-span-2">
      <div className="sp-stage" aria-hidden="true">
        <div ref={tileRef} className="sp-tile">
          <div className="sp-cam">
            <span className="sp-avatar" />
          </div>
          <div className="crt-flash" />
          <span className="sp-label">YOU</span>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[12px] text-[var(--mcj-faint)]">
          Preview — how you&apos;ll hit the stream
        </span>
        <button
          id="stingerReplayBtn"
          type="button"
          className="border border-[var(--mcj-rule-2)] px-3 py-1 text-[12px] font-semibold text-[var(--mcj-dim)] transition-colors hover:border-[var(--mcj-fg)] hover:text-[var(--mcj-fg)]"
        >
          Replay
        </button>
      </div>
    </div>
  )
}
