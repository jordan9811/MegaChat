// The rules menu, in plain language. Everything a campaign can ask of a
// claimant is a READ of their X profile; none of it is an action on X. The
// sentence builder turns the rules object (campaign-engine.js shape) into the
// one line the creator sees in the preview and the claimant sees on the
// public page.

import type { ActionKind, ActionRequire, Campaign, ClaimStatus, ReferenceSet, RuleKey, Rules, VerifiedType } from '@/lib/campaigns-api'

export type RuleMeta = {
  key: RuleKey
  title: string
  copy: string
  /** Shown as a small tag beside the title. */
  note?: string
  /** Needs a frozen reference set. */
  usesSet?: boolean
  /** The value written when the row is switched on. */
  on: Rules[RuleKey]
}

export const RULE_MENU: RuleMeta[] = [
  { key: 'minFollowers', title: 'Minimum followers', copy: 'Their X follower count is at least this.', on: 1000 },
  { key: 'verified', title: 'Verified on X', copy: 'Any checkmark counts.', on: true },
  { key: 'verifiedTypes', title: 'Verification type', copy: 'Only these kinds of checkmark count.', on: ['blue'] },
  { key: 'identityVerified', title: 'ID-verified on X', copy: 'They have completed X’s identity check.', on: true },
  { key: 'minAccountAgeDays', title: 'Account age', copy: 'Their X account is at least this old.', on: 365 },
  { key: 'minTweetCount', title: 'Minimum posts', copy: 'They have posted at least this many times.', on: 100 },
  { key: 'minListedCount', title: 'On enough Lists', copy: 'Other people have put them on at least this many X Lists.', on: 5 },
  { key: 'hasProfileImage', title: 'Has a profile photo', copy: 'Their X profile has a photo.', on: true },
  { key: 'hasDescription', title: 'Has a bio', copy: 'Their profile description is not empty.', on: true },
  { key: 'referenceSetId', title: 'On a list of mine', copy: 'They are in a frozen set — the accounts you follow, an X List, or ids you paste.', usesSet: true, on: '' },
  // `enabled: true` is what makes the server enforce this rule; without it
  // the rule is stored and never checked (campaign-eligibility.js
  // normaliseRules). The form also verifies the server echoed it on.
  { key: 'followedByFromSet', title: 'Followed by people on a list', copy: 'At least this many members of a frozen set follow them. Checking costs X-API calls per claim; the cap bounds that and it comes out of your budget.', usesSet: true, on: { referenceSetId: '', min: 1, perClaimCostCapUsd: 0.5, enabled: true } },
  { key: 'minVerifiedFollowers', title: 'Minimum verified followers', copy: 'Verified accounts following them.', note: 'if X exposes it', on: 10 },
]

/** The server's check keys in plain words, for the claims table. The
 *  always-on checks (campaign-eligibility.js) have no menu row. */
export const CHECK_LABEL: Record<string, string> = Object.assign(
  {
    xLinked: 'X account linked',
    notParodyOrProtected: 'not parody or protected',
    inReferenceSet: 'on the list',
    followedByFromSet: 'followed by the list',
  },
  // Lower-cased for mid-sentence use, keeping "X" and "ID" as they are:
  // only a leading capital followed by a lower-case letter is dropped.
  ...RULE_MENU.map((m) => ({ [m.key]: m.title.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()) })),
)

export function checkLabel(rule: string) {
  return CHECK_LABEL[rule] || rule
}

/** A check that failed because the claimant's X data could not be read
 *  (missing or stale), not because they fell short of the rule. The server's
 *  wording (campaign-eligibility.js `unknown`) is the contract. */
export const UNREAD_CHECK = /^We could not read your (.+?) from X\./

export function isUnreadCheck(c: { pass: boolean; detail: string }) {
  return !c.pass && UNREAD_CHECK.test(c.detail)
}

/** The claim's failures are all unread X data: nothing was judged yet. */
export function allUnread(checks: { pass: boolean; detail: string }[]) {
  const failed = checks.filter((c) => !c.pass)
  return failed.length > 0 && failed.every(isUnreadCheck)
}

/** "a, b and c" (no Oxford comma; the list is short). */
export function joinAnd(parts: string[]) {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || ''
}

/** "at least a year old", "at least 2 years old", "at least 400 days old". */
export function ageWords(days: number) {
  if (days >= 365 && days % 365 === 0) {
    const y = days / 365
    return y === 1 ? 'at least a year old' : `at least ${y} years old`
  }
  return `at least ${fmtInt(days)} days old`
}

/** "6.8 years old", "2 years old", "a year old"; days when under a year. */
export function haveAgeWords(days: number) {
  if (days < 365) return `${fmtInt(days)} days old`
  const y = days / 365
  if (Number.isInteger(y)) return y === 1 ? 'a year old' : `${y} years old`
  return `${y.toFixed(1)} years old`
}

/** Server-side wording the public page shows, polished where the server's
 *  form reads oddly. Only rewrites the exact shapes campaign-eligibility.js
 *  produces (describeRules for the rule list, evaluate for a claimant's
 *  check); anything else passes through untouched. */
export function polishRule(s: string) {
  const v = /^Verified as (.+)$/.exec(s)
  if (v) {
    const kinds = v[1].split(',').map((x) => x.trim()).filter(Boolean)
    return `Verified (${kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]}` : kinds[0]})`
  }
  // The age check: "Your X account is 2,487 days old; this needs 365." →
  // "Your X account is 6.8 years old; this needs at least a year." Days stay
  // days under a year, so a near miss still reads as the count it is.
  const ageCheck = /^Your X account is ([\d,]+) days old; this needs ([\d,]+)\.$/.exec(s)
  if (ageCheck) {
    const have = Number(ageCheck[1].replace(/,/g, ''))
    const need = Number(ageCheck[2].replace(/,/g, ''))
    return `Your X account is ${haveAgeWords(have)}; this needs ${ageWords(need).replace(/ old$/, '')}.`
  }
  // "An X account at least 365 days old" / "An X account 1+ year old" →
  // "An X account at least a year old".
  const age = /^An X account (?:at least )?([\d,]+)\+? (?:days?|years?) old$/.exec(s)
  if (age) {
    const n = Number(age[1].replace(/,/g, ''))
    return `An X account ${ageWords(/year/.test(s) ? n * 365 : n)}`
  }
  // "At least 1 account on "…" already follow you" → "… already follows you".
  const one = /^At least 1 account on (.+) already follow you on X$/.exec(s)
  if (one) return `At least 1 account on ${one[1]} already follows you on X`
  // "(4 accounts, snapshot 2026-10-23)" → "(4 accounts, frozen Oct 23, 2026)";
  // a snapshot date the server already made human only loses the word.
  return s
    .replace(/snapshot (\d{4}-\d{2}-\d{2})/, (m, iso: string) => {
      const d = fmtDate(`${iso}T00:00:00`)
      return d === '—' ? m : `frozen ${d}`
    })
    .replace(/(\d accounts?, )snapshot /, '$1frozen ')
}

/** The claims that hold a place: eligible, recorded, owed, paid — what counts
 *  against maxClaims. Ineligible checks are rows, not places. */
export function placesTaken(c: Pick<Campaign, 'claims'>) {
  const k = c.claims
  if (!k) return 0
  if (typeof k.active === 'number') return k.active
  if (k.counts) {
    const held: ClaimStatus[] = ['eligible', 'recorded', 'approved', 'aired', 'joined', 'owed', 'releasing', 'paid']
    return held.reduce((n, s) => n + (k.counts?.[s] || 0), 0)
  }
  return k.paid
}

export const VERIFIED_TYPE_LABEL: Record<VerifiedType, string> = {
  blue: 'Blue (Premium)',
  business: 'Business (gold)',
  government: 'Government (grey)',
}

export const ACTION_LABEL: Record<ActionKind, string> = {
  holler: 'send a Holler',
  callin: 'call in',
}

export const REQUIRE_LABEL: Record<ActionKind, Partial<Record<ActionRequire, { title: string; copy: string }>>> = {
  holler: {
    approved: { title: 'Approved', copy: 'Their Holler clears your room’s moderation. In an auto-moderated room that is the moment the upload passes the automatic check, with nobody looking; choose Aired if a person should see it first.' },
    aired: { title: 'Aired', copy: 'Their Holler plays on your stream.' },
  },
  callin: {
    joined: { title: 'Joined', copy: 'Their camera goes live in your room, as the server sees it on LiveKit. Counts the moment it does.' },
    aired: { title: 'On air', copy: 'Their camera stays live on your stream for the minimum time, timed by the server.' },
  },
}

export function requireLabel(kind: ActionKind, r: ActionRequire) {
  return REQUIRE_LABEL[kind][r] || { title: r, copy: '' }
}

export const COMPLIANCE_NOTICE =
  'This campaign never asks for anything on X. No follow, reply, repost or quote is required or rewarded — X’s developer policy forbids paying for those. The only paid action is the Holler or Call in on your stream.'

export const COMPLIANCE_SHORT = 'No follow, reply or repost needed — the only paid action is on Holler.'

export const fmtInt = (n: number) => n.toLocaleString('en-US')

function setName(setId: string, sets: ReferenceSet[]) {
  const s = sets.find((x) => x.id === setId)
  return s ? `‘${s.name}’` : 'a list of mine'
}

/** The rules in two kinds of part, in menu order. Profile facts are noun
 *  phrases that hang off one "with" ("5,000+ followers", "a bio"); the two
 *  list rules are relative clauses ("who is on my … list"). Seven rules as
 *  seven "who" clauses read as a list of people, so they are grouped. */
export function ruleParts(rules: Rules, sets: ReferenceSet[]): { with: string[]; who: string[] } {
  const w: string[] = []
  const who: string[] = []
  for (const m of RULE_MENU) {
    const v = rules[m.key]
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    switch (m.key) {
      case 'minFollowers': w.push(`${fmtInt(v as number)}+ followers`); break
      case 'verified': w.push('a verified account'); break
      case 'verifiedTypes': w.push(`a ${(v as VerifiedType[]).join(' or ')} checkmark`); break
      case 'identityVerified': w.push('an ID-verified account'); break
      case 'minAccountAgeDays': w.push(`an account ${ageWords(v as number)}`); break
      case 'minTweetCount': w.push(`${fmtInt(v as number)}+ posts`); break
      case 'minListedCount': w.push(`a place on ${fmtInt(v as number)}+ Lists`); break
      case 'hasProfileImage': w.push('a profile photo'); break
      case 'hasDescription': w.push('a bio'); break
      case 'referenceSetId': who.push(`who is on my ${setName(v as string, sets)} list`); break
      case 'followedByFromSet': {
        const f = v as NonNullable<Rules['followedByFromSet']>
        who.push(`who is followed by ${f.min}+ ${f.min === 1 ? 'person' : 'people'} on my ${setName(f.referenceSetId, sets)} list`)
        break
      }
      case 'minVerifiedFollowers': w.push(`${fmtInt(v as number)}+ verified followers`); break
    }
  }
  return { with: w, who }
}

/** Every rule as one part, for counting. */
export function ruleClauses(rules: Rules, sets: ReferenceSet[]): string[] {
  const p = ruleParts(rules, sets)
  return [...p.with, ...p.who]
}

/** "Anyone with 5,000+ followers, a verified account, a profile photo and an
 *  account at least a year old, who is on my ‘Day-one regulars’ list". */
export function rulesSentence(rules: Rules, sets: ReferenceSet[]): string {
  const p = ruleParts(rules, sets)
  if (p.with.length === 0 && p.who.length === 0) return 'Anyone who signs in with X'
  const withPart = p.with.length > 0 ? ` with ${joinAnd(p.with)}` : ''
  const whoPart = p.who.length > 0 ? `${withPart ? ', ' : ' '}${p.who.join(' and ')}` : ''
  return `Anyone${withPart}${whoPart}`
}

/** How many rules a campaign carries (for the short share post). */
export function ruleCount(rules: Rules) {
  return ruleClauses(rules, []).length
}

export function rewardLabel(amount: string | number, symbol: string) {
  const n = Number(amount)
  if (symbol === 'USDC' && Number.isFinite(n)) {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 6 })}`
  }
  return `${amount} ${symbol}`
}

/** The whole offer in one line, for the list, the detail header and the card. */
export function offerSentence(c: Pick<Campaign, 'reward' | 'action' | 'token'>) {
  return `${rewardLabel(c.reward.amount, c.token.symbol)} to ${ACTION_LABEL[c.action.kind]} on @${c.action.roomHandle}`
}

/** The prefilled X post. Compliant by construction: it says what the reward
 *  is for (the Holler / Call in), who qualifies, and that nothing on X is
 *  asked. The link is counted at X's fixed 23 characters. When the full
 *  "who qualifies" sentence would overflow 280, the rules collapse to
 *  "N rules — see link"; the compliance line and the link are never cut. */
export function shareText(args: { reward: string; action: ActionKind; sentence: string; rules: number; url: string }) {
  const lead = `I’m paying ${args.reward} to ${ACTION_LABEL[args.action]} on my stream.`
  const budget = 280 - 23 - 1
  const n = args.rules
  const rulesLine = n === 0 ? 'Anyone who signs in with X can claim it.' : `${n} ${n === 1 ? 'rule' : 'rules'} — see link.`
  const candidates = [
    `${lead} ${args.sentence} can claim it. ${COMPLIANCE_SHORT}`,
    `${lead} ${rulesLine} ${COMPLIANCE_SHORT}`,
    `${lead} ${rulesLine} No follow, reply or repost needed.`,
    `${lead} No follow, reply or repost needed.`,
  ]
  const text = candidates.find((t) => t.length <= budget) || candidates[candidates.length - 1]
  return `${text} ${args.url}`
}

export function xIntentUrl(text: string) {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`
}

export function fmtDate(iso: string | null | undefined, withTime = false) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, withTime
    ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "just now", "3 min ago", "2 h ago", "5 days ago": how long since the
 *  server last saw something. Null when there is no time or it does not parse. */
export function fmtAgo(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return `${d} ${d === 1 ? 'day' : 'days'} ago`
}

/** "5:12 PM" when it happened today, "Oct 22, 5:12 PM" otherwise. Null when
 *  there is no time or it does not parse. */
export function fmtClock(iso: string | null | undefined, now = new Date()) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const today = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return today ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

export function shortRoot(root: string) {
  return root.length > 18 ? `${root.slice(0, 10)}…${root.slice(-6)}` : root
}

/** Budget arithmetic in the token's decimal units. A draft has moved
 *  nothing, so "left" is the planned budget. */
export function budgetFigures(c: Campaign) {
  const planned = Number(c.budget?.amount) || 0
  const funded = Number(c.budget?.funded) || 0
  const released = Number(c.budget?.released) || 0
  const refunded = Number(c.budget?.refunded) || 0
  const total = c.status === 'draft' ? planned : funded || planned
  const left = Math.max(0, total - released - refunded)
  const usedPct = total > 0 ? Math.min(100, Math.round((released / total) * 100)) : 0
  return { planned, funded, released, refunded, total, left, usedPct }
}
