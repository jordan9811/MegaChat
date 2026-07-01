'use client'

import { Gift } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import {
  Field,
  TextInput,
  InputAffix,
  SelectInput,
  Toggle,
} from '@/components/form-primitives'
import { useRoom } from '@/components/room-provider'
import { cn } from '@/lib/utils'

export function RewardsCard() {
  const { draft, updateDraft, room } = useRoom()
  const enabled = draft.rewardsEnabled

  const rewardSymbol =
    draft.rewardsType === 'points'
      ? 'PTS'
      : draft.rewardsType === 'token'
        ? room?.rewards?.rewardTokenSymbol || 'TOKEN'
        : 'USDC'

  return (
    <GlassCard>
      <CardHeader
        icon={<Gift className="size-5" />}
        title="Rewards / drops"
        description="Viewers earn while they watch — spendable on camera time."
        accent="lime"
        action={
          <Toggle
            checked={enabled}
            onChange={(v) => updateDraft({ rewardsEnabled: v })}
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
        <Field
          label="Drop interval"
          htmlFor="drop-interval"
          hint="Focused watch time between drops."
        >
          <InputAffix
            id="drop-interval"
            affix="sec"
            inputMode="numeric"
            value={draft.rewardsEarnInterval}
            onChange={(e) => updateDraft({ rewardsEarnInterval: e.target.value })}
            disabled={!enabled}
          />
        </Field>

        <Field label="Amount per drop" htmlFor="drop-amount">
          <InputAffix
            id="drop-amount"
            affix={rewardSymbol}
            inputMode="decimal"
            value={draft.rewardsEarnAmount}
            onChange={(e) => updateDraft({ rewardsEarnAmount: e.target.value })}
            disabled={!enabled}
          />
        </Field>

        <Field
          label="Session cap"
          htmlFor="drop-cap"
          hint="Max earned per watch session."
        >
          <InputAffix
            id="drop-cap"
            affix={rewardSymbol}
            inputMode="decimal"
            value={draft.rewardsEarnCap}
            onChange={(e) => updateDraft({ rewardsEarnCap: e.target.value })}
            disabled={!enabled}
          />
        </Field>

        <Field label="Reward type" htmlFor="drop-type">
          <SelectInput
            id="drop-type"
            value={draft.rewardsType}
            onChange={(e) => updateDraft({ rewardsType: e.target.value })}
            disabled={!enabled}
          >
            <option value="usdc">USDC</option>
            <option value="token">ERC-20 token</option>
            <option value="points">Points</option>
          </SelectInput>
        </Field>

        {draft.rewardsType === 'token' ? (
          <Field
            label="Reward token address"
            htmlFor="reward-token"
            hint="ERC-20 contract on Arc Testnet."
            className="sm:col-span-2"
          >
            <TextInput
              id="reward-token"
              value={draft.rewardsTokenAddress}
              onChange={(e) => updateDraft({ rewardsTokenAddress: e.target.value })}
              placeholder="0x…"
              className="font-mono"
              disabled={!enabled}
            />
          </Field>
        ) : null}
      </div>
    </GlassCard>
  )
}
