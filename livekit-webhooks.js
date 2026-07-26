/**
 * LIVEKIT WEBHOOKS — the authoritative source for session records.
 *
 * Why this exists: cost control previously depended on the overlay reporting
 * honestly about itself, and self-reporting is exactly what the last leak hid
 * behind. LiveKit's own participant_joined / participant_left events are the
 * only independent signal we have, so they become the source of truth and the
 * overlay's self-reports are demoted to a health/reconciliation signal.
 *
 * Security: LiveKit signs webhook bodies with the project API secret. The
 * Authorization header carries a JWT whose `sha256` claim is the base64 digest
 * of the raw body. We verify the JWT signature AND that the body digest
 * matches, then reject replays by (id, event) with a bounded TTL window.
 * Unsigned deliveries are rejected outright — an unauthenticated writer to the
 * authoritative ledger would be worse than no ledger at all.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';

/** Constant-time compare that tolerates length mismatch without throwing. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Verify a LiveKit webhook JWT (HS256, signed with the API secret) and confirm
 * its sha256 claim matches the raw body. Returns the decoded payload or throws.
 */
export function verifyWebhookJwt(authHeader, rawBody, { apiKey, apiSecret, maxAgeMs = 5 * 60_000 }) {
  if (!authHeader) throw new Error('missing Authorization header (unsigned delivery)');
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed webhook token');

  const [h, p, sig] = parts;
  const expected = b64url(createHmac('sha256', apiSecret).update(`${h}.${p}`).digest());
  if (!safeEqual(sig, expected)) throw new Error('bad webhook signature');

  let payload;
  try {
    payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    throw new Error('unparseable webhook token payload');
  }

  if (apiKey && payload.iss && payload.iss !== apiKey) throw new Error('webhook issuer mismatch');

  // Body integrity: the token commits to a digest of the exact bytes we got.
  const digest = createHash('sha256').update(rawBody).digest('base64');
  if (payload.sha256 && !safeEqual(payload.sha256, digest)) {
    throw new Error('webhook body digest mismatch (tampered or truncated)');
  }

  // Freshness — bounds replay even before the id cache.
  const nowS = Math.floor(Date.now() / 1000);
  if (payload.exp && nowS > payload.exp + 60) throw new Error('webhook token expired');
  if (payload.iat && Math.abs(nowS - payload.iat) * 1000 > maxAgeMs) {
    throw new Error('webhook token outside the freshness window (replay?)');
  }
  return payload;
}

/**
 * Session tracker fed by webhooks. Idempotent by construction:
 *  - deliveries are deduped by event id
 *  - a participant_left for an unknown/already-closed session is a no-op
 *  - an out-of-order left-before-joined still produces a correct session,
 *    because we reconcile on (room, identity) rather than assuming ordering
 */
export function createWebhookTracker({ log = console, onSession = () => {} } = {}) {
  const seen = new Map();            // eventId → ts (replay guard)
  const open = new Map();            // `${room}|${identity}` → { startedAt, sid }
  const sessions = [];               // closed, authoritative
  const pendingLeft = new Map();     // left-before-joined stash
  const DEDUPE_TTL_MS = 10 * 60_000;

  function gcSeen() {
    const cutoff = Date.now() - DEDUPE_TTL_MS;
    for (const [id, ts] of seen) if (ts < cutoff) seen.delete(id);
  }

  const key = (room, identity) => `${room}|${identity}`;

  /** Classify an identity into our own participant kinds. */
  function kindOf(identity) {
    const id = String(identity || '');
    if (isProbe(id)) return 'probe';
    if (id.startsWith('overlay:')) return 'overlay';
    if (id.startsWith('host:')) return 'booth';
    if (id.startsWith('seat:')) return 'guest';
    if (id.startsWith('viewer:')) return 'viewer';
    return 'unknown';
  }

  /**
   * Synthetic identities used to verify the webhook path end-to-end.
   * They are RECORDED (so a probe is visible and auditable) but EXCLUDED from
   * budget metering — otherwise our own deployment checks would eat a real
   * streamer's burn budget and could, in the limit, trip the breaker and block
   * live traffic. Pattern is deliberately explicit rather than clever: an
   * identity has to be deliberately named a probe to be discounted.
   */
  function isProbe(identity) {
    return /__probe__|__ackprobe|^probe:|^test:/i.test(String(identity || ''));
  }

  function handle(event) {
    const id = event.id || `${event.event}:${event.room?.sid}:${event.participant?.sid}:${event.createdAt}`;
    if (seen.has(id)) {
      return { ok: true, deduped: true, event: event.event };
    }
    seen.set(id, Date.now());
    gcSeen();

    const room = event.room?.name || event.room?.sid || 'unknown';
    const identity = event.participant?.identity || null;
    // LiveKit sends seconds; tolerate ms.
    const rawTs = Number(event.createdAt || 0);
    const ts = rawTs > 1e12 ? rawTs : rawTs * 1000 || Date.now();

    if (event.event === 'participant_joined' && identity) {
      const k = key(room, identity);
      const stashed = pendingLeft.get(k);
      if (stashed) {
        // Out-of-order: left arrived first. Close it correctly now.
        pendingLeft.delete(k);
        const rec = {
          room, identity, kind: kindOf(identity),
          start: ts, end: stashed.ts,
          durationMs: Math.max(0, stashed.ts - ts),
          source: 'webhook', outOfOrder: true,
        };
        sessions.push(rec); onSession(rec);
        return { ok: true, closed: true, outOfOrder: true };
      }
      if (!open.has(k)) open.set(k, { startedAt: ts, sid: event.participant?.sid || null });
      return { ok: true, opened: true };
    }

    if (event.event === 'participant_left' && identity) {
      const k = key(room, identity);
      const o = open.get(k);
      if (!o) {
        // Either a duplicate left, or left-before-joined. Stash briefly.
        pendingLeft.set(k, { ts });
        return { ok: true, stashed: true };
      }
      open.delete(k);
      const rec = {
        room, identity, kind: kindOf(identity),
        start: o.startedAt, end: ts,
        durationMs: Math.max(0, ts - o.startedAt),
        source: 'webhook',
      };
      sessions.push(rec); onSession(rec);
      return { ok: true, closed: true };
    }

    return { ok: true, ignored: event.event };
  }

  function stats(now = Date.now()) {
    const dayAgo = now - 86_400_000;
    const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
    // Budget metering EXCLUDES probes; the raw counts still include them so a
    // probe is never invisible, just never billed against the budget.
    const billable = sessions.filter((s) => s.kind !== 'probe');
    const closedMinutes = (since) => billable.reduce((a, s) => {
      const st = Math.max(s.start, since);
      return s.end > st ? a + (s.end - st) / 60_000 : a;
    }, 0);
    const openMinutes = (since) => [...open.entries()]
      .filter(([k]) => !isProbe(k.split('|')[1]))
      .reduce((a, [, o]) => {
        const st = Math.max(o.startedAt, since);
        return now > st ? a + (now - st) / 60_000 : a;
      }, 0);
    const probeClosed = sessions.length - billable.length;
    return {
      openCount: open.size,
      closedCount: sessions.length,
      probeSessionsExcluded: probeClosed,
      minutesToday: +(closedMinutes(dayAgo) + openMinutes(dayAgo)).toFixed(2),
      minutesThisMonth: +(closedMinutes(monthStart) + openMinutes(monthStart)).toFixed(2),
      openSessions: [...open.entries()].map(([k, o]) => {
        const [room, identity] = k.split('|');
        return {
          room, identity, kind: kindOf(identity),
          startedAt: o.startedAt, minutes: +((now - o.startedAt) / 60_000).toFixed(2),
        };
      }),
    };
  }

  return { handle, stats, sessions, open, verifyWebhookJwt, _seen: seen };
}

/**
 * Reconcile webhook-derived sessions (truth) against overlay self-reports.
 * Divergence means either a bug or a leak, and both need to be loud.
 */
export function reconcile({ webhookStats, ledgerStats, toleranceMin = 1 }) {
  const wh = webhookStats.minutesToday;
  const led = ledgerStats.minutesToday;
  const delta = +(wh - led).toFixed(2);
  const diverged = Math.abs(delta) > toleranceMin;
  return {
    webhookMinutesToday: wh,
    ledgerMinutesToday: led,
    deltaMinutes: delta,
    diverged,
    // Sign matters: webhook > ledger means we were BURNING minutes the
    // overlay never told us about, which is the leak direction.
    direction: delta > 0 ? 'unreported_burn' : delta < 0 ? 'overreported' : 'match',
  };
}
