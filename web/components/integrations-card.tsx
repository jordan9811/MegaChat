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
      {/* One line. A coming-soon feature doesn't get a dashed stage AND an
          explainer paragraph — that's a card spending 120px to say "nothing
          here yet". */}
      <p className="text-pretty px-5 py-4 text-sm text-muted-foreground sm:px-6">
        Twitch / Kick channel linking — coming soon. Unlocks watch-time credit
        and follower/sub gates.
      </p>
    </GlassCard>
  )
}
