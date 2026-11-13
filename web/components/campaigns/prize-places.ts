/**
 * Prize places (campaign-engine.js prizeTerms): what each place pays, as the
 * form, the campaign page and the public page show it.
 */
import { toUnits } from './form-rules'

export const MAX_PRIZE_PLACES = 10

/** 1st, 2nd, 3rd, 4th … */
export function ordinal(n: number): string {
  const t = n % 100
  if (t >= 11 && t <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`
}

/** Smallest units back to a plain decimal string ("6.5", not "6.500000"). */
export function fromUnits(v: bigint, decimals: number): string {
  const neg = v < BigInt(0); const a = neg ? -v : v
  let scale = BigInt(1)
  for (let i = 0; i < decimals; i++) scale *= BigInt(10)
  const frac = (a % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${(a / scale).toString()}${frac ? `.${frac}` : ''}`
}

/** Typed amounts summed exactly; null when any is not a usable amount. */
export function sumAmounts(typed: string[], decimals: number): string | null {
  let s = BigInt(0)
  for (const t of typed) { const u = toUnits(t, decimals); if (u == null) return null; s += u }
  return fromUnits(s, decimals)
}

/** What a percent place pays out of the prize, exactly as the server floors it. */
export function percentOf(prize: string, percent: number, decimals: number): string | null {
  const u = toUnits(prize, decimals)
  if (u == null || !Number.isFinite(percent)) return null
  return fromUnits((u * BigInt(Math.round(percent * 100))) / BigInt(10000), decimals)
}

/** Each place's nominal amount (what it pays when the pot is whole). */
export function placeAmounts(prize: string, places: { by: 'amount' | 'percent'; places: { amount?: string; percent?: number }[] } | null | undefined, decimals: number): string[] {
  if (!places?.places?.length) return [prize]
  return places.places.map((p) => (places.by === 'amount' ? p.amount || '0' : percentOf(prize, p.percent ?? 0, decimals) || '0'))
}

/** Problems with the places as typed, in the server's words. */
export function placesProblems(by: 'amount' | 'percent', typed: string[], decimals: number, cap: number | null): string[] {
  const out: string[] = []
  if (typed.length < 2) return out
  const vals: number[] = []
  typed.forEach((t, i) => {
    const n = Number(t)
    if (by === 'amount') {
      const u = toUnits(t, decimals)
      if (u == null || u <= BigInt(0)) out.push(`${ordinal(i + 1)} place needs an amount above zero.`)
    } else if (!Number.isFinite(n) || n <= 0 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6) out.push(`${ordinal(i + 1)} place needs a percentage above zero.`)
    vals.push(n)
  })
  if (!out.length && vals.some((v, i) => i > 0 && v > vals[i - 1])) out.push('Each place pays no more than the place above it.')
  if (!out.length && by === 'percent') {
    const sum = vals.reduce((s, v) => s + Math.round(v * 100), 0)
    if (sum !== 10000) out.push(`The places add up to ${sum / 100}%; they must add up to 100%.`)
  }
  if (cap != null && cap < typed.length) out.push(`Max entries must be at least the number of places (${typed.length}).`)
  return out
}
