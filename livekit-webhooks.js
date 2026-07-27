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

import fs from 'fs';
import path from 'path';
import { createHash, createHmac, timingSafeEqual } from 'crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DEFAULT_STATE_PATH = path.join(DATA_DIR, 'livekit-webhook-state.json');

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
export function createWebhookTracker({
  log = console,
  onSession = () => {},
  /** Pass null to opt out of persistence (tests that want a clean tracker). */
  statePath = DEFAULT_STATE_PATH,
  /**
   * Optional async () => Set<`${room}|${identity}`> of who LiveKit says is
   * ACTUALLY connected right now. Supplied by the server from RoomService.
   * Without it, boot reconciliation falls back to the conservative policy.
   */
  liveParticipants = null,
} = {}) {
  const seen = new Map();            // eventId → ts (replay guard)
  const open = new Map();            // `${room}|${identity}` → { startedAt, sid }
  const sessions = [];               // closed, authoritative
  const pendingLeft = new Map();     // left-before-joined stash
  const DEDUPE_TTL_MS = 10 * 60_000;
  const MAX_SESSIONS = 5000;

  /**
   * When this tracker started observing.
   *
   * This USED to be `Date.now()` at construction, which meant the breaker's
   * view of the day's burn reset on every deploy — so the daily cap could be
   * walked past simply by deploying, and a leak spanning a restart was
   * invisible to the one thing built to catch it. It is now restored from
   * disk, so the observation window is continuous across boots.
   */
  let observingSince = Date.now();
  let lastPersistedAt = 0;
  let bootReconcile = { ran: false, policy: null, resumed: 0, closed: 0, confirmed: 0, note: null };

  function snapshotState() {
    return {
      observingSince,
      lastPersistedAt: Date.now(),
      open: [...open.entries()].map(([k, o]) => ({ k, ...o })),
      sessions: sessions.slice(-MAX_SESSIONS),
    };
  }

  function persist() {
    if (!statePath) return;
    try {
      const dir = path.dirname(statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(snapshotState()), 'utf8');
    } catch {
      /* metering state is observability; never crash a broadcast over it */
    }
  }

  function restore() {
    if (!statePath || !fs.existsSync(statePath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return null;
      if (Number.isFinite(raw.observingSince)) observingSince = raw.observingSince;
      lastPersistedAt = Number(raw.lastPersistedAt) || 0;
      if (Array.isArray(raw.sessions)) sessions.push(...raw.sessions);
      const resumed = [];
      for (const o of raw.open || []) {
        if (!o?.k) continue;
        // Marked UNCONFIRMED: we know this participant was connected when we
        // died, we do not know whether they are still connected now.
        open.set(o.k, { startedAt: o.startedAt, sid: o.sid || null, unconfirmed: true });
        resumed.push(o.k);
      }
      return { resumed, sessions: raw.sessions?.length || 0 };
    } catch (e) {
      log.error(`[lk-webhook] could not restore metering state: ${e.message}`);
      return null;
    }
  }

  function gcSeen() {
    const cutoff = Date.now() - DEDUPE_TTL_MS;
    for (const [id, ts] of seen) if (ts < cutoff) seen.delete(id);
  }

  /**
   * BOOT RECONCILIATION POLICY for sessions that were open when we died.
   *
   * The problem: we know participant X was connected at shutdown. We do not
   * know whether they left during the downtime, because the participant_left
   * webhook for that departure arrived while nothing was listening. It is
   * gone; webhooks are not replayable.
   *
   * Policy, in order of preference:
   *
   *  1. ASK LIVEKIT. If a `liveParticipants` probe is available we use
   *     RoomService as the authority — that is the whole philosophy of this
   *     module, and it applies just as much at boot. Still connected → confirm
   *     and keep accruing. Not connected → close at `lastPersistedAt`, the
   *     last moment we can honestly attest they were there.
   *
   *  2. NO PROBE → KEEP OPEN, and say so loudly. This deliberately risks
   *     OVER-counting. The breaker exists to stop overspending; under-counting
   *     burn is the failure that defeats it, while over-counting at worst
   *     blocks new tokens early — visible, explainable, and overridable by an
   *     operator. Given a choice between a false alarm and a missed leak, this
   *     module takes the false alarm every time.
   *
   * Closing at `lastPersistedAt` rather than "now" matters: it never invents
   * minutes across a downtime window we were not observing.
   */
  async function reconcileOnBoot() {
    const unconfirmed = [...open.entries()].filter(([, o]) => o.unconfirmed);
    bootReconcile = {
      ran: true, policy: null, resumed: unconfirmed.length,
      closed: 0, confirmed: 0, note: null,
    };
    if (!unconfirmed.length) {
      bootReconcile.policy = 'nothing-to-reconcile';
      return bootReconcile;
    }

    if (typeof liveParticipants !== 'function') {
      bootReconcile.policy = 'keep-open-conservative';
      bootReconcile.note =
        `${unconfirmed.length} session(s) were open at shutdown and cannot be confirmed `
        + '(no RoomService probe wired). Keeping them OPEN and continuing to meter them. '
        + 'This may OVER-count; that is the deliberate direction, because under-counting '
        + 'is what makes a circuit breaker useless.';
      log.warn(`[lk-webhook] boot: ${bootReconcile.note}`);
      return bootReconcile;
    }

    try {
      const live = await liveParticipants();
      const liveSet = live instanceof Set ? live : new Set(live || []);
      const endAt = lastPersistedAt || Date.now();
      for (const [k, o] of unconfirmed) {
        if (liveSet.has(k)) {
          open.set(k, { ...o, unconfirmed: false, resumedAt: Date.now() });
          bootReconcile.confirmed++;
          continue;
        }
        const [room, ...rest] = k.split('|');
        const identity = rest.join('|');
        open.delete(k);
        const rec = {
          room, identity, kind: kindOf(identity),
          start: o.startedAt, end: endAt,
          durationMs: Math.max(0, endAt - o.startedAt),
          source: 'webhook', closedBy: 'boot-reconcile',
        };
        sessions.push(rec); onSession(rec);
        bootReconcile.closed++;
      }
      bootReconcile.policy = 'roomservice-authoritative';
      bootReconcile.note =
        `confirmed ${bootReconcile.confirmed} still-connected, closed ${bootReconcile.closed} `
        + `that left during downtime (ended at last-known-alive, not now)`;
      log.log(`[lk-webhook] boot reconcile: ${bootReconcile.note}`);
      persist();
    } catch (e) {
      bootReconcile.policy = 'keep-open-conservative';
      bootReconcile.note = `RoomService probe failed (${e.message}) — keeping sessions open rather than guessing them closed`;
      log.warn(`[lk-webhook] boot: ${bootReconcile.note}`);
    }
    return bootReconcile;
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
    return 'foreign';
  }

  /** Overlays doubled up on one room — see stats().duplicateOverlays. */
  function duplicateOverlays() {
    const byRoom = new Map();
    for (const [k, o] of open) {
      const [room, ...rest] = k.split('|');
      const identity = rest.join('|');
      if (!identity.startsWith('overlay:')) continue;
      if (!byRoom.has(room)) byRoom.set(room, []);
      byRoom.get(room).push({ identity, startedAt: o.startedAt });
    }
    return [...byRoom.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([room, list]) => ({
        room,
        count: list.length,
        // Everything past the first is avoidable spend.
        wastedParticipants: list.length - 1,
        identities: list.map((x) => x.identity),
        extraMinutes: +(list.slice(1).reduce(
          (a, x) => a + (Date.now() - x.startedAt) / 60_000, 0,
        ).toFixed(2)),
      }));
  }

  /** Not billable: our own probes, and anything not minted by this server. */
  function isBillable(identity) {
    return !isProbe(identity) && !isForeign(identity);
  }

  /**
   * Synthetic identities used to verify the webhook path end-to-end.
   * RECORDED (so a probe is visible and auditable) but EXCLUDED from budget
   * metering — otherwise our own deployment checks would eat a real streamer's
   * burn budget and could, in the limit, trip the breaker and block live
   * traffic. Deliberately explicit: an identity has to be named a probe.
   */
  function isProbe(identity) {
    return /__probe__|__ackprobe|^probe:|^test:/i.test(String(identity || ''));
  }

  /**
   * Is this participant one of OURS at all?
   *
   * Every token this server mints carries a known prefix — `overlay:`,
   * `host:`, `seat:`, `viewer:` (see server.js /api/livekit/token). So an
   * identity with no known prefix cannot be a MegaChat participant. That is an
   * invariant of our own system, not a guess about anyone else's test data,
   * which is why it is the primary rule here.
   *
   * It catches LiveKit dashboard test fires (observed live: room "Demo Room",
   * identity "John Doe" — a 150-minute phantom that ate 37.5% of the daily
   * burn budget before being noticed) and would equally catch any other
   * foreign participant in the project.
   *
   * NOTE, stated rather than hidden: LiveKit's webhook payload carries no
   * field that explicitly marks a dashboard test delivery. I checked the
   * received data and there is no `test`/`source` flag to key on. So this is a
   * heuristic — but a heuristic about OUR namespace, which is far stronger
   * than pattern-matching their placeholder strings. The literal
   * "Demo Room"/"John Doe" values are matched only as a secondary label for
   * reporting, never as the exclusion rule.
   */
  /**
   * The whitelist FAILS OPEN, and that is the inverse of the bug it fixed.
   *
   * Excluding unprefixed identities stopped a LiveKit dashboard test from
   * eating 37.5% of a day's budget. But it also means any identity type we
   * add later that does not match one of these four prefixes is silently
   * unmetered and invisible to the breaker — a leak the leak-detector cannot
   * see. We cannot safely meter what we do not recognise (that was the
   * original bug), so instead every unrecognised prefix is COUNTED and
   * LOGGED LOUDLY, once per distinct identity, so a new participant type
   * announces itself the first time it appears rather than never.
   */
  const KNOWN_PREFIXES = ['overlay:', 'host:', 'seat:', 'viewer:'];
  const unknownPrefixes = new Map(); // prefix → { count, firstSeenAt, example }

  function noteUnknownPrefix(identity, room) {
    const id = String(identity || '');
    const prefix = id.includes(':') ? `${id.split(':')[0]}:` : '(no prefix)';
    const seen = unknownPrefixes.get(prefix);
    if (seen) { seen.count++; return; }
    unknownPrefixes.set(prefix, { count: 1, firstSeenAt: Date.now(), example: id, room });
    // Dashboard tests are a known, explained case — do not cry wolf for them.
    if (foreignLabel(room, id) === 'livekit_dashboard_test') {
      log.warn(`[lk-webhook] ignoring a LiveKit dashboard test participant (${id} in ${room}) — not billed`);
      return;
    }
    log.error(
      `[lk-webhook] ⚠ UNRECOGNISED IDENTITY PREFIX "${prefix}" (e.g. "${id}" in room "${room}"). `
      + `It is NOT being counted against the burn budget because this server did not mint it. `
      + `If MegaChat now issues this identity type, add it to KNOWN_PREFIXES in livekit-webhooks.js `
      + `or its minutes will stay invisible to the circuit breaker.`,
    );
  }

  function isForeign(identity) {
    const id = String(identity || '');
    return !KNOWN_PREFIXES.some((p) => id.startsWith(p));
  }

  /** Cosmetic label so reports can say WHY something was discounted. */
  function foreignLabel(room, identity) {
    if (/^demo room$/i.test(String(room || '')) || /^john doe$/i.test(String(identity || ''))) {
      return 'livekit_dashboard_test';
    }
    return 'foreign_participant';
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
      // Announce a participant type we do not recognise the FIRST time it
      // appears — otherwise its minutes are invisible to the breaker forever.
      if (isForeign(identity) && !isProbe(identity)) noteUnknownPrefix(identity, room);
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
        sessions.push(rec); onSession(rec); persist();
        return { ok: true, closed: true, outOfOrder: true };
      }
      if (!open.has(k)) {
        open.set(k, { startedAt: ts, sid: event.participant?.sid || null });
        persist();
      }
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
      sessions.push(rec); onSession(rec); persist();
      return { ok: true, closed: true };
    }

    return { ok: true, ignored: event.event };
  }

  function stats(now = Date.now()) {
    const dayAgo = now - 86_400_000;
    const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
    // Budget metering EXCLUDES probes; the raw counts still include them so a
    // probe is never invisible, just never billed against the budget.
    const billable = sessions.filter((s) => isBillable(s.identity));
    const closedMinutes = (since) => billable.reduce((a, s) => {
      const st = Math.max(s.start, since);
      return s.end > st ? a + (s.end - st) / 60_000 : a;
    }, 0);
    const openMinutes = (since) => [...open.entries()]
      .filter(([k]) => isBillable(k.split('|').slice(1).join('|')))
      .reduce((a, [, o]) => {
        const st = Math.max(o.startedAt, since);
        return now > st ? a + (now - st) / 60_000 : a;
      }, 0);
    const excludedClosed = sessions.length - billable.length;
    return {
      openCount: open.size,
      closedCount: sessions.length,
      observingSince,
      observedMinutes: +((now - observingSince) / 60_000).toFixed(2),
      // Survives restarts now, so this window is real elapsed observation
      // rather than "time since the last deploy".
      persisted: !!statePath,
      bootReconcile,
      excludedSessions: excludedClosed,
      // Unmetered-by-design identities that we could not classify. Non-empty
      // here means something is burning minutes the breaker cannot see.
      unknownPrefixes: [...unknownPrefixes.entries()].map(([prefix, v]) => ({ prefix, ...v })),
      // Two overlays on one room is legal (they no longer evict each other)
      // but it is two BILLED participants for one broadcast.
      duplicateOverlays: duplicateOverlays(),
      probeSessionsExcluded: excludedClosed, // retained name for compatibility
      minutesToday: +(closedMinutes(dayAgo) + openMinutes(dayAgo)).toFixed(2),
      minutesThisMonth: +(closedMinutes(monthStart) + openMinutes(monthStart)).toFixed(2),
      openSessions: [...open.entries()].map(([k, o]) => {
        const [room, identity] = k.split('|');
        const billable = isBillable(identity);
        return {
          room, identity, kind: kindOf(identity),
          startedAt: o.startedAt, minutes: +((now - o.startedAt) / 60_000).toFixed(2),
          billable,
          ...(billable ? {} : { excludedAs: isProbe(identity) ? 'probe' : foreignLabel(room, identity) }),
        };
      }),
    };
  }

  /**
   * Purge sessions that are not ours (dashboard tests, foreign participants).
   * Returns what it removed so the action is reportable rather than silent.
   */
  function purgeForeign() {
    // (persists at the end — a purge that vanishes on restart is not a purge)
    const removed = [];
    for (const [k, o] of [...open.entries()]) {
      const identity = k.split('|').slice(1).join('|');
      const room = k.split('|')[0];
      if (!isBillable(identity)) {
        open.delete(k);
        removed.push({
          room, identity, kind: kindOf(identity),
          openMinutes: +((Date.now() - o.startedAt) / 60_000).toFixed(2),
          reason: isProbe(identity) ? 'probe' : foreignLabel(room, identity),
        });
      }
    }
    if (removed.length) persist();
    return removed;
  }

  // Restore BEFORE returning so the very first stats() call already reflects
  // what the previous boot knew. Reconciliation is async and runs after.
  const restored = restore();
  if (restored) {
    log.log(`[lk-webhook] restored metering state: ${restored.sessions} closed session(s), `
      + `${restored.resumed.length} still open, observing since `
      + `${new Date(observingSince).toISOString()}`);
  }

  return {
    handle, stats, sessions, open, verifyWebhookJwt,
    purgeForeign, isBillable, isForeign, kindOf, _seen: seen,
    reconcileOnBoot,
    bootReconcile: () => bootReconcile,
    /** Test seam — forces a write without waiting for an event. */
    _persist: persist,
  };
}

/**
 * Reconcile webhook-derived sessions (truth) against overlay self-reports.
 * Divergence means either a bug or a leak, and both need to be loud.
 *
 * The two sides do NOT have the same memory, and pretending they do produces
 * a permanent false alarm: the activity ledger is persisted to disk and spans
 * a rolling 24h, while this tracker is in-memory and starts empty at every
 * boot. Straight subtraction therefore reports "overreported" after every
 * single deploy, for up to 24h, with nothing actually wrong. So the comparison
 * is clamped to the window both sides cover, and while that window is still
 * too short to mean anything we say so instead of guessing.
 *
 * `ledgerStats` must be computed over the same floor — pass
 * `webhookStats.observingSince` into the activity manager's ledgerStats().
 */
export function reconcile({ webhookStats, ledgerStats, toleranceMin = 1, minWindowMin = 5 }) {
  const wh = webhookStats.minutesToday;
  const led = ledgerStats.minutesToday;
  const delta = +(wh - led).toFixed(2);
  const observed = webhookStats.observedMinutes ?? null;
  const comparable = ledgerStats.windowStart != null
    && ledgerStats.windowStart === webhookStats.observingSince;
  const tooEarly = observed != null && observed < minWindowMin;
  return {
    webhookMinutesToday: wh,
    ledgerMinutesToday: led,
    deltaMinutes: delta,
    // Only a comparison over a shared window can be called a divergence.
    comparableWindow: comparable,
    windowMinutes: observed,
    diverged: comparable && !tooEarly && Math.abs(delta) > toleranceMin,
    // Sign matters: webhook > ledger means we were BURNING minutes the
    // overlay never told us about, which is the leak direction.
    direction: delta > 0 ? 'unreported_burn' : delta < 0 ? 'overreported' : 'match',
    note: !comparable
      ? 'ledger window not clamped to the webhook observation start — delta is not meaningful'
      : tooEarly
        ? `only ${observed}min observed since boot (need ${minWindowMin}min) — delta not yet meaningful`
        : null,
  };
}
