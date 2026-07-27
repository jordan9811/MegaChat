/**
 * OPS ALERTS — push, not pull.
 *
 * The long-session alarm worked perfectly during the incident. It fired into
 * stdout, which needs a Railway login to read, so a dashboard test event burned
 * 37.5% of a day's budget over 150 minutes and was found by chance. Exposing
 * the history on /api/livekit/burn was an improvement but it is still something
 * a human has to remember to go and look at. An alarm nobody looks at is a log
 * line with extra steps.
 *
 * Design rules:
 *  - NO-OP CLEANLY when unconfigured. No URL means no alerts and no errors;
 *    the app must behave identically to today.
 *  - NEVER THROW into a caller. An alerting failure must not break metering,
 *    a broadcast, or a payout. Failures are counted and reported, not raised.
 *  - RATE LIMIT per condition, not globally. A flapping breaker must not spam,
 *    but a genuinely new alarm must not be swallowed because something else
 *    was noisy.
 *  - CARRY WHAT IS NEEDED TO ACT. Room, identity, duration, budget percentage.
 *    An alert that says "something is wrong" costs more than it saves.
 */

const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000;

/** Discord and Slack both take a plain JSON POST but disagree on the field. */
function shapePayload(url, { title, lines, severity }) {
  const icon = severity === 'critical' ? '🚨' : severity === 'warn' ? '⚠️' : 'ℹ️';
  const text = `${icon} **${title}**\n${lines.map((l) => `• ${l}`).join('\n')}`;
  if (/hooks\.slack\.com/i.test(url)) return { text };
  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) return { content: text.slice(0, 1900) };
  // Generic endpoint: give it structure rather than a formatted blob.
  return { title, severity, lines, text };
}

export function createAlerter({
  url = process.env.OPS_ALERT_WEBHOOK || '',
  log = console,
  minIntervalMs = Number(process.env.OPS_ALERT_MIN_INTERVAL_MS) || DEFAULT_MIN_INTERVAL_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const lastSentByKey = new Map();
  const suppressedByKey = new Map();
  const stats = { sent: 0, suppressed: 0, failed: 0, lastError: null, lastSentAt: null };

  const enabled = !!url;
  if (!enabled) {
    log.log('[alerts] OPS_ALERT_WEBHOOK not set — alarms stay in logs only');
  } else {
    // Never log the URL itself; a webhook URL is a credential.
    log.log(`[alerts] push alerts enabled (${/slack/i.test(url) ? 'slack' : /discord/i.test(url) ? 'discord' : 'generic'}, min interval ${Math.round(minIntervalMs / 1000)}s)`);
  }

  /**
   * @param {string} key   rate-limit bucket — one per CONDITION, e.g.
   *                       `long-session:mc-r1|overlay:r1`, not per event.
   */
  async function send(key, { title, lines, severity = 'warn' }) {
    if (!enabled) return { skipped: 'not_configured' };

    const t = now();
    const last = lastSentByKey.get(key) || 0;
    if (t - last < minIntervalMs) {
      suppressedByKey.set(key, (suppressedByKey.get(key) || 0) + 1);
      stats.suppressed++;
      return { skipped: 'rate_limited', nextEligibleInMs: minIntervalMs - (t - last) };
    }

    // A resend after suppression says how much was swallowed, so the reader
    // can tell "it happened once" from "it has been screaming for an hour".
    const held = suppressedByKey.get(key) || 0;
    const body = shapePayload(url, {
      title, severity,
      lines: held ? [...lines, `(${held} further occurrence(s) suppressed since the last alert)`] : lines,
    });

    lastSentByKey.set(key, t);
    suppressedByKey.delete(key);

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      stats.sent++;
      stats.lastSentAt = t;
      return { sent: true };
    } catch (e) {
      // Do NOT rethrow. Metering and broadcasts outrank alerting.
      stats.failed++;
      stats.lastError = e.message;
      log.warn(`[alerts] delivery failed (${e.message}) — the condition is still in the logs`);
      return { failed: true, error: e.message };
    }
  }

  return {
    enabled,
    send,
    stats: () => ({ ...stats, enabled, minIntervalMs }),

    /** Budget crossed a warn/block threshold. */
    budget({ state, pctDaily, pctMonthly, minutesToday, openCount }) {
      return send(`budget:${state}`, {
        severity: state === 'blocking' ? 'critical' : 'warn',
        title: state === 'blocking'
          ? 'LiveKit budget exhausted — NEW CONNECTIONS BLOCKED'
          : 'LiveKit budget warning',
        lines: [
          `Daily budget used: ${pctDaily}%`,
          `Monthly budget used: ${pctMonthly}%`,
          `Minutes today: ${minutesToday}`,
          `Sessions open right now: ${openCount}`,
          state === 'blocking'
            ? 'Live sessions are NOT being cut. New tokens are refused until the budget resets or an operator overrides.'
            : 'No action needed yet. This is the early warning.',
        ],
      });
    },

    /** A session has been open far longer than anything legitimate. */
    longSession({ room, identity, kind, minutes, pctDaily }) {
      return send(`long-session:${room}|${identity}`, {
        severity: 'critical',
        title: 'LiveKit session running abnormally long',
        lines: [
          `Room: ${room}`,
          `Participant: ${identity} (${kind})`,
          `Open for: ${minutes} minutes`,
          `Daily budget used: ${pctDaily}%`,
          'This is the shape of the leak that burned the free tier. Check whether it is a real broadcast.',
        ],
      });
    },

    /** Storage for fan recordings is filling up. */
    clipStorage({ pctUsed, clips, bytes, maxBytes }) {
      return send('clip-storage', {
        severity: pctUsed >= 90 ? 'critical' : 'warn',
        title: 'Bounty clip storage filling up',
        lines: [
          `Used: ${pctUsed}% (${(bytes / 1e6).toFixed(0)}MB of ${(maxBytes / 1e6).toFixed(0)}MB)`,
          `Clips held: ${clips}`,
          'At 100% new fan recordings are REFUSED rather than truncated — fans cannot contribute.',
        ],
      });
    },
  };
}

export default createAlerter;
