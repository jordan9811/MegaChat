import { cn } from '@/lib/utils'

export function Wordmark({
  className,
  size = 'lg',
  animated = false,
}: {
  className?: string
  size?: 'sm' | 'lg'
  animated?: boolean
}) {
  // Animated variant bakes a bright sheen band into the fill gradient and pans
  // it — since the fill is background-clip:text, the sheen travels through the
  // glyphs themselves (a real metallic wordmark, not a rectangle sweep).
  const fill = animated
    ? 'linear-gradient(105deg, oklch(0.82 0.16 350) 0%, oklch(0.6 0.24 320) 34%, oklch(0.96 0.07 340) 50%, oklch(0.6 0.24 320) 66%, oklch(0.52 0.24 295) 100%)'
    : 'linear-gradient(180deg, oklch(0.82 0.16 350) 0%, oklch(0.6 0.24 320) 55%, oklch(0.52 0.24 295) 100%)'
  return (
    <span
      className={cn(
        'font-heading font-bold tracking-tight text-glow-magenta',
        size === 'lg' ? 'text-6xl md:text-8xl' : 'text-2xl',
        animated && 'animate-gradient-pan',
        className,
      )}
      style={{
        backgroundImage: fill,
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
