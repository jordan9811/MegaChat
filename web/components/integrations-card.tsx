import { Plug } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'

/** Streamer-side platform link stub — no OAuth logic yet (ROADMAP.md → Integrations). */
export function IntegrationsCard() {
  return (
    <GlassCard>
      <CardHeader
        icon={<Plug className="size-5" />}
        title="Integrations"
        description="Credit viewers for external watch time."
        accent="cyan"
      />
      <div className="px-5 py-5 sm:px-6">
        {/* Audit P1-3: a non-action must not dress as a button. Plain
            status row until the OAuth linkage actually ships. */}
        <p className="rounded-xl border border-dashed border-border/60 bg-input/10 px-4 py-3 text-center text-sm text-muted-foreground">
          Twitch / Kick channel linking — coming soon
        </p>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Link your channel to credit viewers for watch time on Twitch or Kick
          and unlock subscriber/follower join gates.
        </p>
      </div>
    </GlassCard>
  )
}
