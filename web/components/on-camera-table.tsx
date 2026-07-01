import { Video, Circle } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'

type Viewer = {
  handle: string
  wallet: string
  elapsed: string
  spent: string
  status: 'live' | 'queued'
}

const VIEWERS: Viewer[] = [
  { handle: '@pixel_wraith', wallet: '0x9f…3ac1', elapsed: '01:24', spent: '4.20', status: 'live' },
  { handle: '@juno.eth', wallet: '0x1b…77de', elapsed: '00:48', spent: '2.40', status: 'live' },
  { handle: '@lofi_kat', wallet: '0xa3…9002', elapsed: '00:12', spent: '0.60', status: 'live' },
  { handle: '@bigmoodz', wallet: '0x77…12ff', elapsed: '—', spent: '0.00', status: 'queued' },
]

export function OnCameraTable() {
  return (
    <GlassCard>
      <CardHeader
        icon={<Video className="size-5" />}
        title="On camera"
        description="Viewers currently paying to be on stream."
        accent="cyan"
        action={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-input/30 px-3 py-1 text-xs font-medium text-foreground">
            <Circle className="size-2 animate-neon-pulse fill-[var(--neon-magenta)] text-[var(--neon-magenta)]" />
            3 live
          </span>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-border/70 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-medium sm:px-6">Viewer</th>
              <th className="px-3 py-3 font-medium">Wallet</th>
              <th className="px-3 py-3 font-medium">On for</th>
              <th className="px-3 py-3 font-medium">Spent</th>
              <th className="px-5 py-3 font-medium sm:px-6">Status</th>
            </tr>
          </thead>
          <tbody>
            {VIEWERS.map((v) => (
              <tr
                key={v.handle}
                className="border-b border-border/40 last:border-0 transition-colors hover:bg-input/20"
              >
                <td className="px-5 py-3 font-medium text-foreground sm:px-6">
                  {v.handle}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                  {v.wallet}
                </td>
                <td className="px-3 py-3 font-mono text-foreground/90">
                  {v.elapsed}
                </td>
                <td className="px-3 py-3 font-mono text-foreground/90">
                  {v.spent} USDC
                </td>
                <td className="px-5 py-3 sm:px-6">
                  {v.status === 'live' ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--neon-magenta)]/15 px-2.5 py-1 text-xs font-semibold text-[var(--neon-magenta)]">
                      <span className="size-1.5 rounded-full bg-[var(--neon-magenta)]" />
                      Live
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-input/50 px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                      Queued
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </GlassCard>
  )
}
