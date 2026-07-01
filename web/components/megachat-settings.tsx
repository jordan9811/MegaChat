'use client'

import { useState } from 'react'
import { Radio, Rocket, Link2, RefreshCw } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import {
  Field,
  TextInput,
  InputAffix,
  SelectInput,
} from '@/components/form-primitives'
import { CopyRow } from '@/components/copy-row'

type RoomResult = {
  room: string
  viewerUrl: string
  obsUrl: string
}

export function MegaChatSettings() {
  const [roomName, setRoomName] = useState('late-night-arena')
  const [price, setPrice] = useState('0.05')
  const [interval, setInterval] = useState('1')
  const [maxSpend, setMaxSpend] = useState('25')
  const [maxSeats, setMaxSeats] = useState('4')
  const [token, setToken] = useState('USDC')
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState<RoomResult | null>(null)

  function handleCreate() {
    setCreating(true)
    setTimeout(() => {
      const slug = (roomName || 'room').toLowerCase().replace(/\s+/g, '-')
      setResult({
        room: slug,
        viewerUrl: `https://megachat.live/${slug}`,
        obsUrl: `https://megachat.live/obs/${slug}?key=mc_${Math.random()
          .toString(36)
          .slice(2, 10)}`,
      })
      setCreating(false)
    }, 700)
  }

  return (
    <GlassCard>
      <CardHeader
        icon={<Radio className="size-5" />}
        title="MegaChat Settings"
        description="Configure how viewers buy their moment on stream."
        accent="magenta"
        action={
          <span className="hidden items-center gap-1.5 rounded-full border border-border bg-input/30 px-3 py-1 text-xs font-medium text-muted-foreground sm:inline-flex">
            <span className="size-1.5 rounded-full bg-[var(--neon-lime)]" />
            Draft
          </span>
        }
      />

      <div className="grid grid-cols-1 gap-5 px-5 py-6 sm:grid-cols-2 sm:px-6">
        <Field
          label="Room name"
          htmlFor="room-name"
          hint="Shown to viewers in their join link."
          className="sm:col-span-2"
        >
          <TextInput
            id="room-name"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            placeholder="late-night-arena"
          />
        </Field>

        <Field label="Price per charge" htmlFor="price">
          <InputAffix
            id="price"
            affix={token}
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>

        <Field label="Charge interval" htmlFor="interval">
          <InputAffix
            id="interval"
            affix="sec"
            inputMode="numeric"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          />
        </Field>

        <Field
          label="Max spend / viewer"
          htmlFor="max-spend"
          hint="Auto-kicks the camera when reached."
        >
          <InputAffix
            id="max-spend"
            affix={token}
            inputMode="decimal"
            value={maxSpend}
            onChange={(e) => setMaxSpend(e.target.value)}
          />
        </Field>

        <Field
          label="Max seats"
          htmlFor="max-seats"
          hint="Cameras live on screen at once."
        >
          <InputAffix
            id="max-seats"
            affix="cams"
            inputMode="numeric"
            value={maxSeats}
            onChange={(e) => setMaxSeats(e.target.value)}
          />
        </Field>

        <Field
          label="Payment token"
          htmlFor="token"
          className="sm:col-span-2"
        >
          <SelectInput
            id="token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          >
            <option value="USDC">USDC — USD Coin</option>
            <option value="USDT">USDT — Tether</option>
            <option value="ETH">ETH — Ethereum</option>
            <option value="SOL">SOL — Solana</option>
          </SelectInput>
        </Field>
      </div>

      {/* Create room */}
      <div className="border-t border-border/70 px-5 py-5 sm:px-6">
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="glow-magenta flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3.5 font-heading text-base font-bold uppercase tracking-wide text-primary-foreground transition-transform hover:scale-[1.01] disabled:opacity-70"
        >
          {creating ? (
            <>
              <RefreshCw className="size-5 animate-spin" />
              Spinning up room…
            </>
          ) : (
            <>
              <Rocket className="size-5" />
              Create room
            </>
          )}
        </button>
      </div>

      {/* Result panel */}
      {result ? (
        <div className="border-t border-border/70 bg-input/20 px-5 py-5 sm:px-6">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Link2 className="size-4 text-[var(--neon-lime)]" />
            Room <span className="text-[var(--neon-lime)]">{result.room}</span>{' '}
            is live
          </div>
          <div className="flex flex-col gap-2">
            <CopyRow label="Viewer" value={result.viewerUrl} />
            <CopyRow label="OBS" value={result.obsUrl} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Drop the viewer link in chat. Add the OBS link as a Browser Source
            to show cameras on your scene.
          </p>
        </div>
      ) : null}
    </GlassCard>
  )
}
