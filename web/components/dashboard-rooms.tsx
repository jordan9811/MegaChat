'use client'

// The Rooms section's layout, split by the lifecycle rule in DESIGN.md:
//
//   LEFT  = config  — what you set up (settings, rewards, integrations)
//   RIGHT = runtime — what only exists once the room does (links, seats,
//                     booth, clip queue)
//
// Two consequences fall out of that split, both of which were bugs before:
//   · While CREATING there is no runtime column at all, so the page is ONE
//     focused column instead of a form beside a stack of cards explaining
//     they have nothing to show yet.
//   · Managing no longer piles six cards on the right against a lone card
//     on the left — the columns carry comparable weight.
//
// CREATING now renders its own page (components/create-room) rather than the
// managing cards with the runtime column hidden: the two jobs want different
// layouts, and the old shared form asked for thirty settings before you had
// a room. Managing is untouched — it owns the live session (WS, seats,
// autosave) and none of that belongs in a create form.

import { useRoom } from '@/components/room-provider'
import { CreateRoom } from '@/components/create-room/create-room'
import { MegaChatSettings } from '@/components/megachat-settings'
import { OnCameraTable } from '@/components/on-camera-table'
import { RewardsCard } from '@/components/rewards-card'
import { LettersQueueCard } from '@/components/letters-queue-card'
import { HostCamCard } from '@/components/host-cam-card'
import { IntegrationsCard } from '@/components/integrations-card'
import { ShareLinksCard } from '@/components/share-links-card'
import { OverlayHealthCard } from '@/components/overlay-health-card'

function Card({ delay, children }: { delay: string; children: React.ReactNode }) {
  // empty:hidden — a card that renders null must not leave a wrapper eating
  // a flex-gap slot (that was the dead band between cards).
  return (
    <div className="reveal empty:hidden" style={{ ['--reveal-delay' as string]: delay }}>
      {children}
    </div>
  )
}

export function DashboardRooms() {
  const { mode } = useRoom()

  if (mode !== 'managing') {
    return (
      <div className="reveal">
        <CreateRoom />
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1.05fr_0.95fr]">
      {/* config */}
      {/* min-w-0: grid items also default to min-width:auto, so one long
          unbreakable string inside can blow the track past its fr share */}
      <div className="flex min-w-0 flex-col gap-6">
        <Card delay="0.08s">
          <MegaChatSettings />
        </Card>
        <Card delay="0.16s">
          <RewardsCard />
        </Card>
        <Card delay="0.24s">
          <IntegrationsCard />
        </Card>
      </div>

      {/* runtime — mounts only alongside a real room */}
      <div className="flex min-w-0 flex-col gap-6">
        <Card delay="0.12s">
          <ShareLinksCard />
        </Card>
        {/* Overlay health sits directly under the OBS link it reports on —
            lazy connect means a dead overlay is now a real failure mode. */}
        <Card delay="0.16s">
          <OverlayHealthCard />
        </Card>
        <Card delay="0.2s">
          <OnCameraTable />
        </Card>
        <Card delay="0.28s">
          <HostCamCard />
        </Card>
        <Card delay="0.36s">
          <LettersQueueCard />
        </Card>
      </div>
    </div>
  )
}
