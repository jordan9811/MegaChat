'use client'

// Simple ↔ Advanced switch, lives beside the theme toggle. Persists like the
// theme; purely presentational (see lib/ui-mode.ts). Square corners, like
// every other control in the Holler skin.

import { useUiMode, setUiMode } from '@/lib/ui-mode'

export function ModeToggle() {
  const mode = useUiMode()
  return (
    <button
      type="button"
      onClick={() => setUiMode(mode === 'simple' ? 'advanced' : 'simple')}
      title={
        mode === 'simple'
          ? 'Simple mode: amounts as credits, tech hidden. Click for Advanced.'
          : 'Advanced mode: the full crypto-native view. Click for Simple.'
      }
      aria-label="Toggle simple / advanced mode"
      className="inline-flex items-center gap-1 rounded-[2px] border border-hl-line-2 bg-hl-panel/60 p-1 text-[11px] font-bold uppercase tracking-wide"
    >
      {/* On phones only the ACTIVE segment shows (the header shares 375px
          with the wordmark and the login chip); sm+ shows both segments. */}
      <span
        className={
          mode === 'simple'
            ? 'rounded-[2px] bg-hl-strap px-2 py-0.5 text-hl-on-strap'
            : 'hidden px-2 py-0.5 text-hl-muted sm:inline-block'
        }
      >
        Simple
      </span>
      <span
        className={
          mode === 'advanced'
            ? 'rounded-[2px] bg-hl-strap px-2 py-0.5 text-hl-on-strap'
            : 'hidden px-2 py-0.5 text-hl-muted sm:inline-block'
        }
      >
        Adv
      </span>
    </button>
  )
}
