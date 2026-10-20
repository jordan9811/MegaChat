import type { ReactNode } from 'react'

// A subtle pill that says what a room offers, or labels a recorded moment
// (a recorded clip = holler, a guest on camera = callin). SPEC §4; styles in
// app/globals.css under the .ft- section, colours from the --f-<kind>-* tokens.

export type FeatureKind = 'holler' | 'callin' | 'bounty' | 'rewards'

export const FEATURE_LABELS: Record<FeatureKind, string> = {
  holler: 'Holler',
  callin: 'Call in',
  bounty: 'Bounty',
  rewards: 'Rewards',
}

export function FeatureTag({
  kind,
  children,
  size = 'sm',
  className,
}: {
  kind: FeatureKind
  children?: ReactNode
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <span className={['ft', `ft--${kind}`, `ft--${size}`, className].filter(Boolean).join(' ')}>
      <span className="ft-dot" aria-hidden="true" />
      {children ?? FEATURE_LABELS[kind]}
    </span>
  )
}
