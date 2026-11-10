'use client'

// The site tour's chapter for this page (lib/site-tour-chapters.ts). Renders
// nothing and loads nothing unless the tour started on the demo handed off to
// this very chapter: a direct visit, or a skipped or finished tour, never
// sees it (lib/site-tour-state.ts resumeStep).

import { useEffect } from 'react'
import { resumeStep, type ChapterId } from '@/lib/site-tour-state'

export function SiteTour({ chapter }: { chapter: Exclude<ChapterId, 'demo'> }) {
  useEffect(() => {
    if (resumeStep(chapter) == null) return
    let alive = true
    let stop: (() => void) | null = null
    import('@/lib/site-tour-chapters')
      .then(({ startChapter }) => {
        if (alive) stop = startChapter(chapter)
      })
      .catch(() => { /* no tour is the fallback */ })
    return () => {
      alive = false
      if (stop) stop()
    }
  }, [chapter])
  return null
}
