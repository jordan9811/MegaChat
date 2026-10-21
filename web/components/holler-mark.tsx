// The Holler mark (design-assets/holler-brand/SPEC.md §2): HOLLER set in a
// slanted azure broadcast strap, the O drawn as a pink record button.
// Styles live in app/globals.css under the .hm- section.
//
//   variant  'full' strap + HOLLER (default) · 'icon' strap fragment "H◉"
//            (app icon, avatars) · 'bare' letters only, no strap
//   px       rendered font-size in px. Below 24 the O is a solid dot (the thin
//            ring vanishes at small sizes). Omit it to size to 1em of the
//            parent — header lockups — which also uses the solid dot.
//   glow     an azure drop-shadow on hero-size marks; dark theme only (light
//            gets a soft shadow instead).

export type HollerMarkVariant = 'full' | 'icon' | 'bare'

export function HollerMark({
  variant = 'full',
  px,
  glow = false,
  className,
}: {
  variant?: HollerMarkVariant
  px?: number
  glow?: boolean
  className?: string
}) {
  const solid = px == null || px < 24
  const classes = ['hm', `hm--${variant}`, solid && 'hm--solid', glow && 'hm--glow', className]
    .filter(Boolean)
    .join(' ')
  return (
    <span className={classes} style={px == null ? undefined : { fontSize: px }} role="img" aria-label="Holler">
      <span className="hm-strap" aria-hidden="true">
        <span className="hm-l">H</span>
        <span className="hm-o" />
        {variant === 'icon' ? null : <span className="hm-l">LLER</span>}
      </span>
    </span>
  )
}
