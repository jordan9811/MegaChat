'use client'

// LAYOUT EDITOR — where the tiles sit on the streamer's canvas.
//
// WORKS WITH MOCK SEATS AND NO OBS. The main user is somebody configuring
// before their first stream, so an obs-websocket connection is an enhancement
// and never a gate: there is nothing to connect to yet, and a preview that
// demanded one would be useless exactly when it is most needed. The preview
// below is a scaled 16:9 canvas with fake tiles, which is enough to answer the
// only question being asked — will this sit on top of my facecam.
//
// IT DRAWS FROM THE SAME RULE THE OVERLAY USES. Both place slot i at
// i * (tileH + gap) along the chosen direction from the chosen corner, so what
// is drawn here is what lands on the canvas rather than an impression of it.
// The bounty badge is drawn the same way: public/overlay.html applyBadgeAnchor
// puts it in the corner diagonally opposite where the stack lands, 16 px in.
// This file only reads that rule; it never moves the badge.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useRoom } from '@/components/room-provider'
import type { RoomLayout } from '@/lib/api'
import { docsUrl } from '@/lib/docs-url.mjs'

type Origin = RoomLayout['origin']
type Direction = RoomLayout['direction']

// One picker for where the stack starts and which way it fills. Each corner
// offers only its two inward directions, so all 8 choices are real layouts:
// the old Corner + Stack pair had 16, half of which ignored the corner
// (ss-corner-half-ignored). The stored origin/direction are unchanged.
const CORNERS: { origin: Origin; label: string; fills: Direction[] }[] = [
  { origin: 'top-left', label: 'Top left', fills: ['down', 'right'] },
  { origin: 'top-right', label: 'Top right', fills: ['down', 'left'] },
  { origin: 'bottom-left', label: 'Bottom left', fills: ['up', 'right'] },
  { origin: 'bottom-right', label: 'Bottom right', fills: ['up', 'left'] },
]
const ARROW: Record<Direction, string> = { down: '↓', up: '↑', right: '→', left: '←' }
const FILL_WORD: Record<Direction, string> = { down: 'downward', up: 'upward', right: 'rightward', left: 'leftward' }

// The preview stands for a 1080p OBS canvas. It is drawn fluid, in percent of
// that canvas, so it fits its card at any width (tb-dash-pan).
const CANVAS_W = 1920
const CANVAS_H = 1080
// The badge as it airs (overlay.html #bounty-badge: ~292×64, 16 px in from
// its corner). rooms-store.js reserves a larger 360×80 box when it refuses a
// layout; the preview shows the badge itself.
const BADGE_W = 292
const BADGE_H = 64
const BADGE_INSET = 16

const px = (v: number, of: number) => `${(v / of) * 100}%`

/** Where the stack actually lands: the edge the direction grows from, the
 *  side the origin names on the other axis (rooms-store.js layoutGeometry). */
function landing(layout: RoomLayout) {
  const vertical = layout.direction === 'down' || layout.direction === 'up'
  const v = vertical ? (layout.direction === 'down' ? 'top' : 'bottom') : (layout.origin.startsWith('top') ? 'top' : 'bottom')
  const h = vertical ? (layout.origin.endsWith('left') ? 'left' : 'right') : (layout.direction === 'right' ? 'left' : 'right')
  return { vertical, v, h, corner: `${v}-${h}` as Origin }
}

export function LayoutEditor() {
  const { draft, updateDraft, room, saveState, saveError } = useRoom()
  const layout = draft.layout
  // The server refuses a layout that would bury the verification badge, and
  // the reason rides back on the failed save. Surfaced HERE as well as in the
  // status line, because this is the card the streamer is looking at when the
  // refusal happens — a rejection they have to go hunting for is a rejection
  // with no reason. The check itself is server-side only, on the write path,
  // so there is one implementation and it cannot be bypassed by the API.
  const layoutRefused = saveState === 'error' && /layout refused/i.test(saveError || '')
  const seats = Math.max(1, Number(draft.maxSeats) || 3)

  // Layout edits autosave like every other field. While the room is live, the
  // moment one of those saves lands the streamer gets a toast saying the tiles
  // moved on stream; nothing waits on it and nothing is lost if they miss it.
  const editedRef = useRef(false)
  const [movedToast, setMovedToast] = useState(false)
  useEffect(() => {
    if (saveState !== 'saved' || !editedRef.current) return
    editedRef.current = false
    if (!room?.active) return
    setMovedToast(true)
    const t = setTimeout(() => setMovedToast(false), 2600)
    return () => clearTimeout(t)
  }, [saveState, room?.active])
  // Holler clips play one at a time in the seat slots, in the same fill
  // direction (owner, 2026-11-09). The old "its own size and corner" fields
  // did nothing on stream and are gone; an edit here also clears a stored
  // own-corner clip, so a setting nobody can see can no longer refuse a save.
  const edit = (next: RoomLayout) => { editedRef.current = true; updateDraft({ layout: { ...next, clip: { ...next.clip, follow: true } } }) }

  const set = (patch: Partial<RoomLayout>) => edit({ ...layout, ...patch })
  const setTile = (patch: Partial<RoomLayout['tile']>) =>
    edit({ ...layout, tile: { ...layout.tile, ...patch } })

  const land = landing(layout)

  // One extra ghost tile stands in for a whitelisted guest, who raises the cap
  // at runtime. It is drawn at the NEXT slot in the same fill order, which is
  // the behaviour being promised: nobody already placed moves.
  const tiles = Array.from({ length: seats + 1 }, (_, i) => i)

  const place = (i: number): CSSProperties => {
    const along = i * ((land.vertical ? layout.tile.h : layout.tile.w) + layout.tile.gap)
    const m = layout.margin
    return {
      width: px(layout.tile.w, CANVAS_W),
      height: px(layout.tile.h, CANVAS_H),
      [land.h]: px(m + (land.vertical ? 0 : along), CANVAS_W),
      [land.v]: px(m + (land.vertical ? along : 0), CANVAS_H),
    }
  }

  const badge: CSSProperties = {
    width: px(BADGE_W, CANVAS_W),
    height: px(BADGE_H, CANVAS_H),
    [land.h === 'left' ? 'right' : 'left']: px(BADGE_INSET, CANVAS_W),
    [land.v === 'top' ? 'bottom' : 'top']: px(BADGE_INSET, CANVAS_H),
  }

  return (
    <section className="mcc-preview-card" aria-label="Overlay layout">
      <div className="mcc-preview-top">
        <div>
          <strong>Where the tiles sit on your canvas</strong>
        </div>
      </div>

      <div className="mcc-layout-canvas" aria-label="Canvas preview with mock seats">
        {tiles.map((i) => (
          <div
            key={i}
            className={i >= seats ? 'mcc-layout-tile is-guest' : 'mcc-layout-tile'}
            style={place(i)}
            title={i >= seats ? 'Guest slot: a whitelisted guest raises the cap and lands here, so nobody already on screen moves.' : undefined}
          >
            {i >= seats ? 'guest' : `seat ${i + 1}`}
          </div>
        ))}
        <div className="mcc-layout-badge" style={badge} title="The bounty code shows here during bounty clips, in the corner opposite your tiles.">
          Bounty code
        </div>
      </div>

      <div className="mcc-corner-picker" role="group" aria-label="Where the tiles start and which way they fill">
        {CORNERS.map((c) => (
          <div key={c.origin} className="mcc-corner" data-corner={c.origin}>
            <span>{c.label}</span>
            <span className="mcc-corner-fills">
              {c.fills.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-label={`${c.label}, fill ${FILL_WORD[d]}`}
                  aria-pressed={land.corner === c.origin && layout.direction === d}
                  onClick={() => set({ origin: c.origin, direction: d })}
                >
                  {ARROW[d]}
                </button>
              ))}
            </span>
          </div>
        ))}
      </div>

      <div className="mcc-layout-controls">
        <label>
          <span>Margin</span>
          <input type="number" min={0} max={400} value={layout.margin}
            onChange={(e) => set({ margin: Number(e.target.value) })} />
        </label>
        <label>
          <span>Tile width</span>
          <input type="number" min={160} max={1920} value={layout.tile.w}
            onChange={(e) => setTile({ w: Number(e.target.value) })} />
        </label>
        <label>
          <span>Tile height</span>
          <input type="number" min={90} max={1080} value={layout.tile.h}
            onChange={(e) => setTile({ h: Number(e.target.value) })} />
        </label>
        <label>
          <span>Gap</span>
          <input type="number" min={0} max={200} value={layout.tile.gap}
            onChange={(e) => setTile({ gap: Number(e.target.value) })} />
        </label>
      </div>

      {layoutRefused ? (
        <p role="alert" className="mcc-error">{saveError}</p>
      ) : null}

      {movedToast ? <span className="mcc-toast" role="status">Tiles moved on stream</span> : null}

      {/* The page that explains the floor and the ceiling, only when the
          handbook is configured (docs-url.mjs returns null otherwise). */}
      {docsUrl('create-room-and-layout') ? (
        <small className="mcc-preview-note"><a href={docsUrl('create-room-and-layout') as string} target="_blank" rel="noreferrer">How the layout works</a></small>
      ) : null}
    </section>
  )
}
