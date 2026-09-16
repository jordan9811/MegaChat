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

import { useRoom } from '@/components/room-provider'
import type { RoomLayout } from '@/lib/api'
import { docsUrl } from '@/lib/docs-url.mjs'

const ORIGINS: { value: RoomLayout['origin']; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
]

const DIRECTIONS: { value: RoomLayout['direction']; label: string }[] = [
  { value: 'down', label: 'Downward' },
  { value: 'up', label: 'Upward' },
  { value: 'right', label: 'Rightward' },
  { value: 'left', label: 'Leftward' },
]

// The preview canvas is a 1080p OBS canvas at 1/4 scale.
const CANVAS_W = 1920
const CANVAS_H = 1080
const SCALE = 0.25

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

  const set = (patch: Partial<RoomLayout>) => updateDraft({ layout: { ...layout, ...patch } })
  const setTile = (patch: Partial<RoomLayout['tile']>) =>
    updateDraft({ layout: { ...layout, tile: { ...layout.tile, ...patch } } })
  const setClip = (patch: Partial<RoomLayout['clip']>) =>
    updateDraft({ layout: { ...layout, clip: { ...layout.clip, ...patch } } })

  const vertical = layout.direction === 'down' || layout.direction === 'up'

  // One extra ghost tile stands in for a whitelisted guest, who raises the cap
  // at runtime. It is drawn at the NEXT slot in the same fill order, which is
  // the behaviour being promised: nobody already placed moves.
  const tiles = Array.from({ length: seats + 1 }, (_, i) => i)

  const place = (i: number) => {
    const along = i * ((vertical ? layout.tile.h : layout.tile.w) + layout.tile.gap)
    const style: React.CSSProperties = { position: 'absolute', width: layout.tile.w * SCALE, height: layout.tile.h * SCALE }
    const m = layout.margin * SCALE
    if (layout.origin.startsWith('top')) style.top = m; else style.bottom = m
    if (layout.origin.endsWith('left')) style.left = m; else style.right = m
    if (vertical) {
      const edge = layout.direction === 'down' ? 'top' : 'bottom'
      style[edge] = m + along * SCALE
      if (edge === 'top') delete style.bottom; else delete style.top
    } else {
      const edge = layout.direction === 'right' ? 'left' : 'right'
      style[edge] = m + along * SCALE
      if (edge === 'left') delete style.right; else delete style.left
    }
    return style
  }

  return (
    <section className="mcc-preview-card" aria-label="Overlay layout">
      <div className="mcc-preview-top">
        <div>
          <span className="mcc-eyebrow">Overlay layout</span>
          <strong>Where the tiles sit on your canvas</strong>
        </div>
        <b>v{layout.version}</b>
      </div>

      <div
        className="mcc-layout-canvas"
        style={{ position: 'relative', width: CANVAS_W * SCALE, height: CANVAS_H * SCALE }}
        aria-label="Canvas preview with mock seats"
      >
        {tiles.map((i) => (
          <div
            key={i}
            className={i >= seats ? 'mcc-layout-tile is-guest' : 'mcc-layout-tile'}
            style={place(i)}
          >
            {i >= seats ? 'guest' : `seat ${i + 1}`}
          </div>
        ))}
      </div>
      <small className="mcc-preview-note">
        1920&times;1080 canvas at quarter scale. The dashed tile is a whitelisted guest —
        they raise the cap at runtime and land at the next slot, so nobody already on
        screen moves.
      </small>

      <div className="mcc-layout-controls">
        <label>
          <span>Corner</span>
          <select value={layout.origin} onChange={(e) => set({ origin: e.target.value as RoomLayout['origin'] })}>
            {ORIGINS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label>
          <span>Stack</span>
          <select value={layout.direction} onChange={(e) => set({ direction: e.target.value as RoomLayout['direction'] })}>
            {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </label>
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

      <div className="mcc-layout-controls">
        <label className="mcc-layout-wide">
          <span>MegaChat clips</span>
          <select value={layout.clip.follow ? 'follow' : 'own'}
            onChange={(e) => setClip({ follow: e.target.value === 'follow' })}>
            <option value="follow">In the same stack as the seats</option>
            <option value="own">Its own size and corner</option>
          </select>
        </label>
        {!layout.clip.follow ? (
          <>
            <label>
              <span>Clip corner</span>
              <select value={layout.clip.origin} onChange={(e) => setClip({ origin: e.target.value as RoomLayout['origin'] })}>
                {ORIGINS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label>
              <span>Clip width</span>
              <input type="number" min={160} max={1920} value={layout.clip.w}
                onChange={(e) => setClip({ w: Number(e.target.value) })} />
            </label>
            <label>
              <span>Clip height</span>
              <input type="number" min={90} max={1080} value={layout.clip.h}
                onChange={(e) => setClip({ h: Number(e.target.value) })} />
            </label>
          </>
        ) : null}
      </div>

      {layoutRefused ? (
        <p role="alert" className="mcc-error">{saveError}</p>
      ) : null}

      <small className="mcc-preview-note">
        {room?.active
          ? 'Saving while you are live moves the tiles on the next overlay tick — seat 1 stays seat 1, only its position changes.'
          : 'Tile sizes have a floor: the bounty badge rides in the tile, and below it a clip that genuinely aired can stop being verifiable.'}
        {/* The page that explains the floor and the ceiling, only when the
            handbook is configured (docs-url.mjs returns null otherwise). */}
        {docsUrl('create-room-and-layout') ? (
          <> <a href={docsUrl('create-room-and-layout') as string} target="_blank" rel="noreferrer">How the layout works</a></>
        ) : null}
      </small>
    </section>
  )
}
