import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

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

export function CardHeader({
  icon,
  title,
  description,
  accent = 'magenta',
  action,
}: {
  icon: ReactNode
  title: string
  description?: string
  accent?: 'magenta' | 'lime' | 'cyan'
  action?: ReactNode
}) {
  const accentColor =
    accent === 'lime'
      ? 'var(--neon-lime)'
      : accent === 'cyan'
        ? 'var(--neon-cyan)'
        : 'var(--neon-magenta)'
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4 sm:px-6">
      <div className="flex items-center gap-3">
        <span
          className="flex size-9 items-center justify-center rounded-lg text-[oklch(0.14_0.04_305)]"
          style={{ backgroundColor: accentColor }}
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
