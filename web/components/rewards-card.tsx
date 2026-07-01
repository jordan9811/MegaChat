'use client'

import { useState } from 'react'
import { Gift } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import {
  Field,
  InputAffix,
  SelectInput,
  Toggle,
} from '@/components/form-primitives'
import { cn } from '@/lib/utils'

export function RewardsCard() {
  const [enabled, setEnabled] = useState(true)
  const [interval, setInterval] = useState('5')
  const [amount, setAmount] = useState('1.00')
  const [cap, setCap] = useState('50')
  const [type, setType] = useState('random')

  return (
    <GlassCard>
      <CardHeader
        icon={<Gift className="size-5" />}
        title="Rewards / drops"
        description="Surprise on-camera viewers with token drops."
        accent="lime"
        action={
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            label="Enable rewards"
          />
        }
      />
      <div
        className={cn(
          'grid grid-cols-1 gap-5 px-5 py-6 transition-opacity sm:grid-cols-2 sm:px-6',
          enabled ? 'opacity-100' : 'pointer-events-none opacity-40',
        )}
      >
        <Field label="Drop interval" htmlFor="drop-interval">
          <InputAffix
            id="drop-interval"
            affix="min"
            inputMode="numeric"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            disabled={!enabled}
          />
        </Field>

        <Field label="Amount per drop" htmlFor="drop-amount">
          <InputAffix
            id="drop-amount"
            affix="USDC"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={!enabled}
          />
        </Field>

        <Field label="Session cap" htmlFor="drop-cap" hint="Max total per stream.">
          <InputAffix
            id="drop-cap"
            affix="USDC"
            inputMode="decimal"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            disabled={!enabled}
          />
        </Field>

        <Field label="Drop type" htmlFor="drop-type">
          <SelectInput
            id="drop-type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            disabled={!enabled}
          >
            <option value="random">Random viewer</option>
            <option value="all">Split across all</option>
            <option value="top">Top spender</option>
          </SelectInput>
        </Field>
      </div>
    </GlassCard>
  )
}
