const CONFETTI = [
  { top: '8%', left: '6%', color: 'var(--neon-magenta)', size: 10, rot: 24 },
  { top: '14%', left: '22%', color: 'var(--neon-cyan)', size: 8, rot: -12 },
  { top: '6%', left: '48%', color: 'var(--neon-lime)', size: 12, rot: 40 },
  { top: '10%', left: '70%', color: 'var(--neon-violet)', size: 9, rot: 8 },
  { top: '20%', left: '88%', color: 'var(--neon-magenta)', size: 11, rot: -30 },
  { top: '34%', left: '4%', color: 'var(--neon-lime)', size: 8, rot: 18 },
  { top: '46%', left: '15%', color: 'var(--neon-cyan)', size: 10, rot: -20 },
  { top: '62%', left: '8%', color: 'var(--neon-magenta)', size: 9, rot: 34 },
  { top: '78%', left: '20%', color: 'var(--neon-violet)', size: 12, rot: -8 },
  { top: '30%', left: '94%', color: 'var(--neon-lime)', size: 9, rot: 14 },
  { top: '52%', left: '90%', color: 'var(--neon-cyan)', size: 11, rot: -26 },
  { top: '72%', left: '82%', color: 'var(--neon-magenta)', size: 8, rot: 20 },
  { top: '86%', left: '58%', color: 'var(--neon-lime)', size: 10, rot: -16 },
  { top: '24%', left: '36%', color: 'var(--neon-violet)', size: 7, rot: 30 },
]

export function GlitchBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-noir" />
      <div className="absolute inset-0 bg-grid opacity-60" />
      {/* soft neon glow blooms */}
      <div className="absolute -left-24 top-1/4 size-72 rounded-full bg-[var(--neon-violet)] opacity-20 blur-[100px]" />
      <div className="absolute right-0 top-0 size-80 rounded-full bg-[var(--neon-magenta)] opacity-20 blur-[120px]" />
      {/* confetti */}
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
            boxShadow: `0 0 10px ${c.color}`,
            animationDelay: `${(i % 5) * 0.6}s`,
            opacity: 0.85,
          }}
        />
      ))}
    </div>
  )
}
