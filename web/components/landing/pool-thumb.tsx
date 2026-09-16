'use client'

// The bounty board's thumbnail, on the landing. One slot, two sources: the
// streamer's real profile photo when we have one, a monogram when we don't —
// a missing photo must never read as broken. The platform pip sits in the
// corner so a row says who and where without a second line of text.

import { useState } from 'react'
import { PlatformPip } from '@/components/platform-pip'

export function PoolThumb({
  handle,
  platform,
  avatarUrl,
}: {
  handle: string
  platform: string | null
  avatarUrl?: string | null
}) {
  const [broken, setBroken] = useState(false)
  const letter = (handle.trim().charAt(0) || '?').toUpperCase()
  return (
    <span className="mcl-thumb">
      {avatarUrl && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" width={40} height={40} loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <i aria-hidden="true">{letter}</i>
      )}
      <b><PlatformPip platform={platform} notch="var(--mcl-panel-2)" /></b>
    </span>
  )
}
