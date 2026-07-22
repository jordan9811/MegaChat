// Confetti is brand — bright, glowing, plenty of it. The ONE rule: it never
// lands on text. Bright squares next to body copy read as stuck pixels or
// render artifacts; out in the page gutters they read as decoration.
//
// Percentages can't express "the gutter" (content is max-w-6xl = 1152px
// centred, so at 1280 the gutters are only 64px — "left: 6%" is already
// INSIDE the text column, which is how a piece landed on a section kicker).
// So each piece is anchored to the column EDGE with calc(): it sits in the
// real gutter at every viewport wide enough to have one.
const COLUMN_HALF = 576 // max-w-6xl / 2

type Piece = { top: string; side: 'left' | 'right'; gap: number; color: string; size: number; rot: number }

const CONFETTI: Piece[] = [
  { top: '7%', side: 'left', gap: 10, color: 'var(--neon-magenta)', size: 11, rot: 24 },
  { top: '16%', side: 'left', gap: 34, color: 'var(--neon-cyan)', size: 8, rot: -12 },
  { top: '27%', side: 'left', gap: 4, color: 'var(--neon-lime)', size: 12, rot: 40 },
  { top: '38%', side: 'left', gap: 26, color: 'var(--neon-violet)', size: 9, rot: 8 },
  { top: '48%', side: 'left', gap: 12, color: 'var(--neon-magenta)', size: 10, rot: -30 },
  { top: '60%', side: 'left', gap: 40, color: 'var(--neon-lime)', size: 8, rot: 18 },
  { top: '72%', side: 'left', gap: 6, color: 'var(--neon-cyan)', size: 11, rot: -20 },
  { top: '87%', side: 'left', gap: 30, color: 'var(--neon-magenta)', size: 9, rot: 34 },
  { top: '5%', side: 'right', gap: 22, color: 'var(--neon-violet)', size: 12, rot: -8 },
  { top: '18%', side: 'right', gap: 6, color: 'var(--neon-lime)', size: 9, rot: 14 },
  { top: '30%', side: 'right', gap: 38, color: 'var(--neon-cyan)', size: 11, rot: -26 },
  { top: '43%', side: 'right', gap: 14, color: 'var(--neon-magenta)', size: 8, rot: 20 },
  { top: '55%', side: 'right', gap: 32, color: 'var(--neon-lime)', size: 10, rot: -16 },
  { top: '68%', side: 'right', gap: 8, color: 'var(--neon-violet)', size: 9, rot: 30 },
  { top: '80%', side: 'right', gap: 28, color: 'var(--neon-cyan)', size: 12, rot: -22 },
  { top: '92%', side: 'right', gap: 12, color: 'var(--neon-magenta)', size: 8, rot: 16 },
]

// Narrow viewports have NO gutter (content is full-bleed), so the gutter set
// can't render there. These few ride the top/bottom section padding instead,
// where no copy sits, and stay small.
const EDGE_CONFETTI = [
  { top: '2%', left: '4%', color: 'var(--neon-magenta)', size: 8, rot: 24 },
  { top: '3%', left: '92%', color: 'var(--neon-cyan)', size: 7, rot: -18 },
  { top: '97%', left: '8%', color: 'var(--neon-lime)', size: 7, rot: 30 },
  { top: '96%', left: '90%', color: 'var(--neon-violet)', size: 8, rot: -12 },
]

export function GlitchBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-noir" />
      <div className="absolute inset-0 bg-grid opacity-60" />
      {/* soft neon glow blooms */}
      <div className="absolute -left-24 top-1/4 size-72 rounded-full bg-[var(--neon-violet)] opacity-20 blur-[100px]" />
      <div className="absolute right-0 top-0 size-80 rounded-full bg-[var(--neon-magenta)] opacity-20 blur-[120px]" />

      {/* gutter confetti — desktop, where a gutter actually exists */}
      {CONFETTI.map((c, i) => (
        <span
          key={`g${i}`}
          className="animate-float-slow absolute hidden rounded-[2px] xl:block"
          style={{
            top: c.top,
            // anchored OUTSIDE the content column at any width
            ...(c.side === 'left'
              ? { right: `calc(50% + ${COLUMN_HALF + c.gap}px)` }
              : { left: `calc(50% + ${COLUMN_HALF + c.gap}px)` }),
            width: c.size,
            height: c.size * 0.7,
            backgroundColor: c.color,
            transform: `rotate(${c.rot}deg)`,
            boxShadow: `0 0 10px ${c.color}`,
            animationDelay: `${(i % 5) * 0.6}s`,
            opacity: 0.85,
          }}
        />
      ))}

      {/* edge confetti — narrow viewports, in the section padding */}
      {EDGE_CONFETTI.map((c, i) => (
        <span
          key={`e${i}`}
          className="animate-float-slow absolute block rounded-[2px] xl:hidden"
          style={{
            top: c.top,
            left: c.left,
            width: c.size,
            height: c.size * 0.7,
            backgroundColor: c.color,
            transform: `rotate(${c.rot}deg)`,
            boxShadow: `0 0 8px ${c.color}`,
            animationDelay: `${(i % 4) * 0.7}s`,
            opacity: 0.7,
          }}
        />
      ))}
    </div>
  )
}
