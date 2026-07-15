'use client'

// Simple ↔ Advanced pill, lives beside the theme toggle. Persists like the
// theme; purely presentational (see lib/ui-mode.ts).

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
      className="inline-flex items-center gap-1 rounded-full border border-border bg-input/30 p-1 text-[11px] font-bold uppercase tracking-wide"
    >
      <span
        className={
          mode === 'simple'
            ? 'rounded-full bg-[var(--neon-lime)]/20 px-2 py-0.5 text-[var(--neon-lime)]'
            : 'px-2 py-0.5 text-muted-foreground'
        }
      >
        Simple
      </span>
      <span
        className={
          mode === 'advanced'
            ? 'rounded-full bg-primary/20 px-2 py-0.5 text-[var(--neon-magenta)]'
            : 'px-2 py-0.5 text-muted-foreground'
        }
      >
        Adv
      </span>
    </button>
  )
}
