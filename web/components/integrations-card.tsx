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
        <button
          type="button"
          disabled
          title="Coming soon"
          className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-input/20 px-4 py-3 text-sm font-semibold text-muted-foreground opacity-70"
        >
          Connect Twitch / Kick account — coming soon
        </button>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Link your channel to credit viewers for watch time on Twitch or Kick
          and unlock subscriber/follower join gates.
        </p>
      </div>
    </GlassCard>
  )
}
