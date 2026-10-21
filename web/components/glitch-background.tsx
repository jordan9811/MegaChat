// Confetti in the four feature colours plus the strap ultramarine. The hues are
// the non-text --f-* tokens; the glow is dark-only (--hl-glow-k is 0 in light).
const CONFETTI = [
  { top: '8%', left: '6%', color: 'var(--hl-strap-hi)', size: 10, rot: 24 },
  { top: '14%', left: '22%', color: 'var(--f-callin)', size: 8, rot: -12 },
  { top: '6%', left: '48%', color: 'var(--f-bounty)', size: 12, rot: 40 },
  { top: '10%', left: '70%', color: 'var(--f-holler)', size: 9, rot: 8 },
  { top: '20%', left: '88%', color: 'var(--f-rewards)', size: 11, rot: -30 },
  { top: '34%', left: '4%', color: 'var(--f-bounty)', size: 8, rot: 18 },
  { top: '46%', left: '15%', color: 'var(--f-callin)', size: 10, rot: -20 },
  { top: '62%', left: '8%', color: 'var(--f-holler)', size: 9, rot: 34 },
  { top: '78%', left: '20%', color: 'var(--hl-strap-hi)', size: 12, rot: -8 },
  { top: '30%', left: '94%', color: 'var(--f-rewards)', size: 9, rot: 14 },
  { top: '52%', left: '90%', color: 'var(--f-callin)', size: 11, rot: -26 },
  { top: '72%', left: '82%', color: 'var(--f-holler)', size: 8, rot: 20 },
  { top: '86%', left: '58%', color: 'var(--f-bounty)', size: 10, rot: -16 },
  { top: '24%', left: '36%', color: 'var(--f-rewards)', size: 7, rot: 30 },
]

// The confetti stays in the gutters: this mask hides it over the centre 940px
// on desktop, and below about 1000px everywhere inside the 24px page padding
// (px-6), which is the only gutter a phone has. So no speck lands on copy.
const GUTTERS_ONLY =
  'linear-gradient(90deg, #000 0, #000 max(16px, calc(50% - 520px)), transparent max(24px, calc(50% - 470px)), transparent min(calc(100% - 24px), calc(50% + 470px)), #000 min(calc(100% - 16px), calc(50% + 520px)))'

export function GlitchBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-noir" />
      <div className="absolute inset-0 bg-grid opacity-60" />
      {/* soft glow blooms, both the strap ultramarine: a faint pink bloom over
          the blue ink reads as a violet smudge, and pink means Holler */}
      <div className="absolute -left-24 top-1/4 size-72 rounded-full bg-hl-strap opacity-20 blur-[100px]" />
      <div className="absolute right-0 top-0 size-80 rounded-full bg-hl-strap opacity-[0.12] blur-[120px]" />
      {/* confetti, masked out of the content column */}
      <div className="absolute inset-0" style={{ maskImage: GUTTERS_ONLY, WebkitMaskImage: GUTTERS_ONLY }}>
        {CONFETTI.map((c, i) => (
          <span
            key={i}
            className="absolute block rounded-[2px] animate-float-slow"
            style={{
              top: c.top,
              left: c.left,
              width: c.size,
              height: c.size * 0.7,
              backgroundColor: c.color,
              transform: `rotate(${c.rot}deg)`,
              boxShadow: `0 0 10px color-mix(in srgb, ${c.color} calc(100% * var(--hl-glow-k)), transparent)`,
              animationDelay: `${(i % 5) * 0.6}s`,
              opacity: 0.85,
            }}
          />
        ))}
      </div>
    </div>
  )
}
