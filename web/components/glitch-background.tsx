// Noise pass: 14 glowing squares at 0.85 opacity read as STUCK PIXELS, not
// texture. Six, dimmer, edge-hugging, no glow shadow — felt not noticed.
const CONFETTI = [
  { top: '8%', left: '6%', color: 'var(--neon-magenta)', size: 9, rot: 24 },
  { top: '20%', left: '88%', color: 'var(--neon-cyan)', size: 8, rot: -30 },
  { top: '46%', left: '4%', color: 'var(--neon-lime)', size: 8, rot: 18 },
  { top: '72%', left: '92%', color: 'var(--neon-violet)', size: 9, rot: 20 },
  { top: '86%', left: '12%', color: 'var(--neon-cyan)', size: 7, rot: -16 },
  { top: '32%', left: '95%', color: 'var(--neon-lime)', size: 7, rot: 14 },
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
            animationDelay: `${(i % 5) * 0.6}s`,
            opacity: 0.3,
          }}
        />
      ))}
    </div>
  )
}
