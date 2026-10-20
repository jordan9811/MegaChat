import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'
import type { FeatureKind } from '@/components/feature-tag'

export function GlassCard({
  children,
  className,
  id,
}: {
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <div
      id={id}
      className={cn(
        'rounded-2xl border border-border bg-card/70 shadow-xl backdrop-blur-md',
        className,
      )}
    >
      {children}
    </div>
  )
}

// The header chip is a feature-tag in miniature: the feature's tint, edge and
// ink (app/globals.css --f-*), or the brand strap for a card that belongs to no
// feature. The retired neon names still work and resolve the way globals.css
// resolves them — magenta to the strap, lime to rewards, cyan to call-in.
type CardAccent = FeatureKind | 'strap' | 'magenta' | 'lime' | 'cyan'

const LEGACY_ACCENT: Record<'magenta' | 'lime' | 'cyan', FeatureKind | 'strap'> = {
  magenta: 'strap',
  lime: 'rewards',
  cyan: 'callin',
}

function accentStyle(accent: CardAccent) {
  const kind = accent === 'magenta' || accent === 'lime' || accent === 'cyan' ? LEGACY_ACCENT[accent] : accent
  if (kind === 'strap') {
    return {
      backgroundColor: 'color-mix(in srgb, var(--hl-strap) 14%, transparent)',
      borderColor: 'color-mix(in srgb, var(--hl-strap-hi) 45%, transparent)',
      color: 'var(--hl-strap-hi)',
    }
  }
  return {
    backgroundColor: `var(--f-${kind}-bg)`,
    borderColor: `var(--f-${kind}-line)`,
    color: `var(--f-${kind}-ink)`,
  }
}

export function CardHeader({
  icon,
  title,
  description,
  accent = 'strap',
  action,
}: {
  icon: ReactNode
  title: string
  description?: string
  accent?: CardAccent
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4 sm:px-6">
      <div className="flex items-center gap-3">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border"
          style={accentStyle(accent)}
        >
          {icon}
        </span>
        <div>
          <h2 className="font-heading text-base font-bold text-foreground">
            {title}
          </h2>
          {description ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {action}
    </div>
  )
}
