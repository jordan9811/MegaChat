// ─── Demo money: the Holler demo room's play money (owner, 2026-11-09) ───────
//
// In the demo room (handle 'demo', config isDemo) watching earns DEMO MONEY:
// seat credit (reward-credits.js) that the viewer spends right there on a
// Call in and a Holler. It is never real: it is not a USDC balance, it is
// never settled, never transferred, never exchangeable and never shown as
// withdrawable. Nothing here, or anywhere that reads it, touches settlement.js
// or a chain. Internal code calls it credit; a viewer only ever sees "demo
// money, not real".
//
// WHO HOLDS IT. Signed-in viewers only (a per-viewer cap is no cap when a
// wallet costs nothing), keyed the way seat credit is keyed: (room, wallet).
// The wallet is not the account's payout wallet, because demo money is paid
// to no one: it is a fixed placeholder address derived from the account id
// (demoWalletFor), which no key controls and which the server alone names.
//
// THE HOUSE BUDGET (anti-sybil and anti-bot). However many accounts watch,
// the house issues at most DEMO_CREDIT_HOURLY in any rolling hour and
// DEMO_CREDIT_DAILY in any rolling day, in total (defaults 200 and 1000, in
// dollars of demo money). Every grant is an EARN row in the rewards ledger
// (data/rewards-ledger.jsonl) marked house:'demo', so the budget is folded
// from that ledger on boot and survives a restart. When it is spent, earning
// pauses with a reason the page shows in words, and resumes when the window
// rolls past the old grants.
import { createHash } from 'crypto';
import { toAtomic } from './token-utils.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Demo money counts in dollars at USDC's 6 decimals. */
export const DEMO_DECIMALS = 6;

/** The one demo room: the seeded room at /demo. A room that only stores isDemo is not it. */
export function isDemoRoom(cfg) {
  return !!cfg && cfg.isDemo === true && cfg.handle === 'demo';
}

/** The placeholder wallet that holds an account's demo money. No key controls it. */
export function demoWalletFor(accountId) {
  if (!accountId) return null;
  return '0x' + createHash('sha256').update(`holler-demo-money:${accountId}`).digest('hex').slice(0, 40);
}

/** The house limits, in atomic units. Env names only: DEMO_CREDIT_HOURLY, DEMO_CREDIT_DAILY. */
export function demoBudgetLimits(env = process.env) {
  const read = (v, d) => {
    try {
      const a = toAtomic(String(v == null || v === '' ? d : v), DEMO_DECIMALS);
      return a >= 0n ? a : toAtomic(d, DEMO_DECIMALS);
    } catch { return toAtomic(d, DEMO_DECIMALS); }
  };
  return { hourly: read(env.DEMO_CREDIT_HOURLY, '200'), daily: read(env.DEMO_CREDIT_DAILY, '1000') };
}

/**
 * The rolling house budget over the demo grants.
 * @param {object} o
 * @param {() => Array} o.rows — every ledger row (only EARN rows with house 'demo' count)
 * @param {object} [o.env]
 */
export function createDemoBudget({ rows, env = process.env } = {}) {
  const limits = demoBudgetLimits(env);
  let grants = null; // [{ at, atomic }] oldest first, the last day only

  function load(now) {
    if (grants) return;
    grants = [];
    for (const r of rows()) {
      if (r.type !== 'EARN' || r.house !== 'demo') continue;
      const at = Number(r.at) || 0;
      if (now - at < DAY_MS) grants.push({ at, atomic: BigInt(r.amountAtomic || 0) });
    }
    grants.sort((a, b) => a.at - b.at);
  }

  function sums(now) {
    load(now);
    while (grants.length && now - grants[0].at >= DAY_MS) grants.shift();
    let hour = 0n, day = 0n;
    for (const g of grants) {
      day += g.atomic;
      if (now - g.at < HOUR_MS) hour += g.atomic;
    }
    return { hour, day };
  }

  return {
    limits,
    /** What may still be issued now, and why not when nothing may: 'demo_budget_day' or 'demo_budget_hour'. */
    state(now = Date.now()) {
      const { hour, day } = sums(now);
      const hourLeft = limits.hourly > hour ? limits.hourly - hour : 0n;
      const dayLeft = limits.daily > day ? limits.daily - day : 0n;
      const left = hourLeft < dayLeft ? hourLeft : dayLeft;
      const blocked = dayLeft <= 0n ? 'demo_budget_day' : hourLeft <= 0n ? 'demo_budget_hour' : null;
      return { issuedHour: hour, issuedDay: day, left, blocked };
    },
    /** A grant just written to the ledger. */
    note(atomic, at = Date.now()) {
      load(at);
      grants.push({ at, atomic: BigInt(atomic) });
    },
  };
}
