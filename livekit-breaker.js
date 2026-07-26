/**
 * LIVEKIT BURN CIRCUIT BREAKER.
 *
 * The quota was drained once by a leak nobody could see until the billing
 * wall. Nothing structurally prevented a repeat, and a bad deploy at 2am would
 * do it again. This is the thing that says no.
 *
 * Design rules that matter:
 *  - It reads WEBHOOK-derived consumption, not our own self-reported ledger.
 *    A breaker fed by the same self-report that hid the last leak would fail
 *    in exactly the case it exists for.
 *  - Blocking refuses NEW connections only. Existing sessions are never killed
 *    mid-broadcast — cutting a live guest off air to save minutes is a worse
 *    outcome than the overage.
 *  - The long-session alarm is the one that would have caught the 30-hour
 *    session on day one instead of at month end.
 *  - An operator can override, and the override is logged with who and why.
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const breakerConfig = {
  enabled: process.env.LK_BREAKER !== '0',
  dailyBudgetMin: num(process.env.LK_DAILY_BUDGET_MIN, 400),
  monthlyBudgetMin: num(process.env.LK_MONTHLY_BUDGET_MIN, 4500),
  /** Fraction of budget that trips the loud warning. */
  warnAt: Number(process.env.LK_BREAKER_WARN_AT || 0.75),
  /** Fraction that trips the hard block. Below 1.0 on purpose: stopping
   *  before the provider does keeps the failure ours to explain. */
  blockAt: Number(process.env.LK_BREAKER_BLOCK_AT || 0.95),
  /** Any single session longer than this alarms immediately. */
  longSessionMin: num(process.env.LK_LONG_SESSION_MIN, 60),
  /** How long an operator override lasts. */
  overrideTtlMs: num(process.env.LK_OVERRIDE_TTL_MS, 60 * 60_000),
};

export function createBreaker({ log = console, getUsage, config = breakerConfig } = {}) {
  /** @type {{until:number, by:string, reason:string}|null} */
  let override = null;
  const alarmed = new Set(); // sessions already alarmed, so we warn once each
  let lastState = 'ok';

  function usage() {
    const u = getUsage ? getUsage() : { minutesToday: 0, minutesThisMonth: 0, openSessions: [] };
    return {
      minutesToday: u.minutesToday || 0,
      minutesThisMonth: u.minutesThisMonth || 0,
      openSessions: u.openSessions || [],
    };
  }

  function ratios(u = usage()) {
    return {
      daily: config.dailyBudgetMin > 0 ? u.minutesToday / config.dailyBudgetMin : 0,
      monthly: config.monthlyBudgetMin > 0 ? u.minutesThisMonth / config.monthlyBudgetMin : 0,
    };
  }

  function overrideActive(now = Date.now()) {
    return !!(override && override.until > now);
  }

  /** Current breaker state: 'ok' | 'warn' | 'blocked' (or 'overridden'). */
  function state(now = Date.now()) {
    if (!config.enabled) return 'ok';
    const r = ratios();
    const worst = Math.max(r.daily, r.monthly);
    if (worst >= config.blockAt) return overrideActive(now) ? 'overridden' : 'blocked';
    if (worst >= config.warnAt) return 'warn';
    return 'ok';
  }

  /**
   * The gate every new-connection path must call.
   * Returns { allowed, reason } — reason is OPERATOR-FACING, not a code.
   */
  function checkAllowed(now = Date.now()) {
    const s = state(now);
    const u = usage();
    const r = ratios(u);
    if (s === 'blocked') {
      return {
        allowed: false,
        state: s,
        reason:
          `LiveKit burn budget reached — new connections are paused to protect the quota. ` +
          `Today ${u.minutesToday.toFixed(0)}/${config.dailyBudgetMin} min ` +
          `(${(r.daily * 100).toFixed(0)}%), this month ${u.minutesThisMonth.toFixed(0)}/` +
          `${config.monthlyBudgetMin} min (${(r.monthly * 100).toFixed(0)}%). ` +
          `Live sessions are unaffected. An operator can override in the dashboard.`,
        usage: u,
      };
    }
    return { allowed: true, state: s, usage: u };
  }

  /** Periodic evaluation: state-change logging + per-session long alarms. */
  function evaluate(now = Date.now()) {
    if (!config.enabled) return { state: 'ok', alarms: [] };
    const u = usage();
    const r = ratios(u);
    const s = state(now);
    const alarms = [];

    if (s !== lastState) {
      const line = `[lk-breaker] ${lastState} → ${s} | today ${u.minutesToday.toFixed(1)}/${config.dailyBudgetMin}min (${(r.daily * 100).toFixed(0)}%), month ${u.minutesThisMonth.toFixed(1)}/${config.monthlyBudgetMin}min (${(r.monthly * 100).toFixed(0)}%)`;
      if (s === 'blocked') log.error(`${line} — ⛔ BLOCKING NEW CONNECTIONS (live sessions untouched)`);
      else if (s === 'warn') log.warn(`${line} — ⚠ approaching budget`);
      else log.log(line);
      lastState = s;
    }

    // Long-session alarm — the one that would have caught the 30-hour session.
    for (const sess of u.openSessions) {
      if (sess.minutes >= config.longSessionMin && !alarmed.has(sess.identity + sess.startedAt)) {
        alarmed.add(sess.identity + sess.startedAt);
        const a = {
          type: 'LONG_SESSION',
          room: sess.room, identity: sess.identity, kind: sess.kind,
          startedAt: new Date(sess.startedAt).toISOString(),
          minutes: sess.minutes,
        };
        alarms.push(a);
        log.error(
          `[lk-breaker] ⛔ LONG SESSION ALARM — ${sess.kind} "${sess.identity}" in room "${sess.room}" ` +
          `has been connected ${sess.minutes.toFixed(0)} min (threshold ${config.longSessionMin}), ` +
          `started ${a.startedAt}. This is the alarm that would have caught the 30-hour leak on day one.`,
        );
      }
    }
    return { state: s, ratios: r, usage: u, alarms };
  }

  function setOverride({ by, reason, ttlMs = config.overrideTtlMs }) {
    if (!by || !reason || !String(reason).trim()) {
      throw new Error('An override requires an operator and a reason (both are logged)');
    }
    override = { until: Date.now() + ttlMs, by, reason: String(reason).trim() };
    log.warn(
      `[lk-breaker] OVERRIDE ENGAGED by "${by}" for ${Math.round(ttlMs / 60_000)} min — reason: ${override.reason}. ` +
      'New connections will be permitted above the budget until it expires.',
    );
    return { ...override };
  }

  function clearOverride(by = 'operator') {
    if (override) log.warn(`[lk-breaker] override cleared by "${by}"`);
    override = null;
  }

  function snapshot(now = Date.now()) {
    const u = usage();
    const r = ratios(u);
    return {
      enabled: config.enabled,
      state: state(now),
      usage: u,
      budgets: { dailyMin: config.dailyBudgetMin, monthlyMin: config.monthlyBudgetMin },
      pct: { daily: +(r.daily * 100).toFixed(1), monthly: +(r.monthly * 100).toFixed(1) },
      thresholds: { warnAt: config.warnAt, blockAt: config.blockAt, longSessionMin: config.longSessionMin },
      override: overrideActive(now)
        ? { by: override.by, reason: override.reason, expiresAt: override.until }
        : null,
    };
  }

  return { checkAllowed, evaluate, setOverride, clearOverride, snapshot, state, _ratios: ratios };
}
