import { cn } from '@/lib/utils'

export function Wordmark({
  className,
  size = 'lg',
}: {
  className?: string
  size?: 'sm' | 'lg'
}) {
  return (
    <span
      className={cn(
        'font-heading font-bold tracking-tight text-glow-magenta',
        size === 'lg' ? 'text-6xl md:text-8xl' : 'text-2xl',
        className,
      )}
      style={{
        backgroundImage:
          'linear-gradient(180deg, oklch(0.82 0.16 350) 0%, oklch(0.6 0.24 320) 55%, oklch(0.52 0.24 295) 100%)',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        // Theme-aware outline (near-white on dark, dark plum on light) — the
        // hardcoded white stroke made the mark illegible on the light header.
        WebkitTextStroke:
          size === 'lg'
            ? '2px var(--wordmark-stroke)'
            : '1px var(--wordmark-stroke)',
        paintOrder: 'stroke fill',
      }}
    >
      MegaChat
    </span>
  )
}
