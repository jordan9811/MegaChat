// The campaign form's input rules, kept apart from the component so they can
// be checked without a browser. Every bound here is the server's
// (campaign-engine.js validateDraft, campaign-eligibility.js normaliseRules,
// token-utils.js toAtomic): a value the form accepts is stored as typed, and
// a value the server would refuse, or quietly clamp, is refused here in plain
// words instead of coming back as an API key name.

/** What the server's toAtomic takes: "5", "0.25", "5.", ".5". */
const DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/
/** Dollars and cents: the server rounds X-API caps to the cent, so a third
 *  decimal would be stored as something the creator did not type. */
const CENTS = /^(\d+(\.\d{0,2})?|\.\d{1,2})$/

/** The server's bounds (validateDraft clamps the first two silently). */
export const LIMITS = {
  minSecondsMin: 10,
  minSecondsMax: 3600,
  maxClaimsMax: 100_000,
  capPerClaimMaxUsd: 50,
  capTotalMaxUsd: 100_000,
}

/**
 * A money amount as typed, which is what the form sends. It used to send
 * String(Number(typed)): '0.0000005' went out as '5e-7' (refused as "must be
 * numbers") and an 18-decimal amount was rounded to 17 significant digits.
 * Null when the amount is fine (a blank one is left to the "more than zero"
 * check); otherwise the sentence to show.
 */
export function amountProblem(typed: string, decimals: number, symbol: string, what: 'reward' | 'budget'): string | null {
  const s = typed.trim()
  if (!s) return null
  const label = what === 'reward' ? 'The reward' : 'The budget'
  if (!DECIMAL.test(s)) return `${label} must be a plain number, like 5 or 0.25.`
  // Trailing zeros carry nothing, so "1.50" is fine in a 1-decimal token.
  const frac = (s.split('.')[1] || '').replace(/0+$/, '')
  if (frac.length > decimals) return `${label} has more decimal places than ${symbol} does: ${symbol} has ${decimals}.`
  return null
}

/** The amount to send: exactly what was typed, trimmed. */
export const amountToSend = (typed: string) => typed.trim()

export type CostCaps = {
  /** null when the text is not a usable cap (the problem says why). */
  perClaim: number | null
  /** null when blank: the server then uses 20% of the budget. */
  total: number | null
  problems: string[]
}

/**
 * The two X-API cost caps of the "followed by" rule, typed as text and only
 * parsed here. The inputs used to store Number(text) on every keystroke, and a
 * controlled text input then shows String(number): deleting the 5 of "0.5"
 * left "0." → 0 → "0", and typing 2 then 5 read "02" → 2, "25" → 25, so a
 * creator aiming for $0.25 stored $25, which the server accepts.
 */
export function parseCostCaps(perClaimText: string, totalText: string): CostCaps {
  const problems: string[] = []
  const p = perClaimText.trim()
  let perClaim: number | null = null
  if (!CENTS.test(p) || !(Number(p) > 0) || Number(p) > LIMITS.capPerClaimMaxUsd) {
    problems.push(`The X-API cost cap per claim must be more than $0 and at most $${LIMITS.capPerClaimMaxUsd}. Use dollars and cents, e.g. 0.25.`)
  } else {
    perClaim = Number(p)
  }
  const t = totalText.trim()
  let total: number | null = null
  if (t) {
    if (!CENTS.test(t) || !(Number(t) > 0) || Number(t) > LIMITS.capTotalMaxUsd) {
      problems.push(`The X-API cost cap in total must be more than $0 and at most $${LIMITS.capTotalMaxUsd.toLocaleString('en-US')}, or blank. Use dollars and cents.`)
    } else if (perClaim != null && Number(t) < perClaim) {
      problems.push('The X-API cost cap in total must be at least the cap per claim.')
    } else {
      total = Number(t)
    }
  }
  return { perClaim, total, problems }
}

/** Max claims and the Call in's minimum time, against the server's bounds.
 *  The two upper bounds used to be clamped on the server without a word
 *  (5,000 seconds saved as 3,600). */
export function countProblems(maxClaims: number, minSeconds: number, callin: boolean): string[] {
  const out: string[] = []
  if (!(maxClaims >= 1)) out.push('Max claims must be at least 1.')
  else if (maxClaims > LIMITS.maxClaimsMax) out.push(`Max claims can be at most ${LIMITS.maxClaimsMax.toLocaleString('en-US')}.`)
  if (callin) {
    if (!(minSeconds >= LIMITS.minSecondsMin)) out.push('Minimum time on camera is at least 10 seconds.')
    else if (minSeconds > LIMITS.minSecondsMax) out.push(`Minimum time on camera can be at most ${LIMITS.minSecondsMax.toLocaleString('en-US')} seconds (an hour).`)
  }
  return out
}
