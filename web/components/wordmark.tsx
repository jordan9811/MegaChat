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
        WebkitTextStroke:
          size === 'lg'
            ? '2px oklch(0.98 0.02 320 / 0.85)'
            : '1px oklch(0.98 0.02 320 / 0.7)',
        paintOrder: 'stroke fill',
      }}
    >
      MegaChat
    </span>
  )
}
