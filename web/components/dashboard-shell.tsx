'use client'

// One surface for the room. Owning a room means landing IN it: the same page
// as creating one, bound to the live room — never a fresh form with a bumped
// handle. The provider decides which: it opens your room when you have one
// and starts a draft when you don't (and ?room= picks among several).
//
// There used to be a ?new=1 escape hatch here that forced the create form
// even for someone who owned a room, with a bumped handle prefilled. That is
// exactly how an owner ended up staring at megachat.fun/theirname_2. ?new=1 is
// back as New room (account menu, Switch room), read by the provider, and it
// leaves the link field EMPTY for the streamer to fill: nothing is bumped.

import { CreateRoom } from '@/components/create-room/create-room'

export function DashboardShell(_props: { contactHref?: string }) {
  return <CreateRoom />
}
