'use client'

// One surface for the room. Owning a room means landing IN it: the same page
// as creating one, bound to the live room — never a fresh form with a bumped
// handle. The provider decides which: it opens your room when you have one
// and starts a draft when you don't (and ?room= picks among several).
//
// There used to be a ?new=1 escape hatch here that forced the create form
// even for someone who owned a room. That is exactly how an owner ended up
// staring at megachat.fun/theirname_2. Gone.

import { CreateRoom } from '@/components/create-room/create-room'

export function DashboardShell(_props: { contactHref?: string }) {
  return <CreateRoom />
}
