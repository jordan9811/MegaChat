/**
 * LAZY CONNECT — server-side activity state machine + session ledger.
 *
 * The server is the authority on "should the overlay hold a LiveKit
 * connection right now". The overlay never decides for itself; it subscribes
 * to a cheap signal (existing app WebSocket, polling fallback) and obeys.
 *
 * State per room:
 *   idle    → nobody wants a connection. Overlay is disconnected. $0.
 *   waking  → someone opened the join sheet (earliest credible intent).
 *             Overlay connects NOW so the handshake finishes inside the
 *             payment flow, which is slower than the handshake.
 *   live    → at least one seat is granted/on camera.
 *   grace   → last seat vacated; still connected, timer running. Any new
 *             intent cancels the timer (no thrash between joiners).
 *
 * Ledger: every connect/disconnect is recorded so the NEXT leak is caught on
 * day one instead of at the billing wall. Records are append-only JSON in
 * DATA_DIR (ephemeral on Railway without a volume — acceptable, the dashboard
 * reads the live in-memory set plus whatever the current boot accumulated).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lazyConfig } from './livekit-lazy.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LEDGER_PATH = path.join(DATA_DIR, 'livekit-sessions.json');

/** Rolling in-memory ledger; flushed to disk best-effort. */
const sessions = [];
const MAX_LEDGER = 5000;

function persist() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(sessions.slice(-MAX_LEDGER)), 'utf8');
  } catch {
    /* ledger is observability, never worth crashing a broadcast over */
  }
}

function loadLedger() {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    if (Array.isArray(raw)) sessions.push(...raw);
  } catch {
    /* corrupt ledger is not fatal */
  }
}
loadLedger();

export function createActivityManager({ log = console, broadcastToRoom, hasOverlay } = {}) {
  /** roomId → { state, seats:Set, prewarms:Map<token,expiry>, graceTimer, overlay:{...} } */
  const rooms = new Map();

  const room = (id) => {
    const key = id || 'default';
    if (!rooms.has(key)) {
      rooms.set(key, {
        state: 'idle',
        seats: new Set(),
        prewarms: new Map(),
        graceTimer: null,
        overlay: { lastBeat: 0, lkState: 'idle', identity: null },
      });
    }
    return rooms.get(key);
  };

  // ── ledger ────────────────────────────────────────────────────────────────

  /** Open a session record. kind: 'overlay' | 'booth' | 'guest'. */
  function sessionStart(roomId, identity, kind) {
    const rec = {
      id: `${identity}@${Date.now().toString(36)}`,
      roomId: roomId || 'default',
      identity,
      kind,
      start: Date.now(),
      end: null,
      durationMs: null,
    };
    sessions.push(rec);
    if (sessions.length > MAX_LEDGER) sessions.splice(0, sessions.length - MAX_LEDGER);
    persist();
    log.log(`[lk-session] OPEN  ${kind} ${identity} room=${rec.roomId}`);
    return rec.id;
  }

  function sessionEnd(sessionId) {
    const rec = sessions.find((s) => s.id === sessionId && !s.end);
    if (!rec) return;
    rec.end = Date.now();
    rec.durationMs = rec.end - rec.start;
    persist();
    const mins = (rec.durationMs / 60_000).toFixed(1);
    log.log(`[lk-session] CLOSE ${rec.kind} ${rec.identity} room=${rec.roomId} ${mins}min`);
    if (rec.durationMs > lazyConfig.longSessionWarnMs) {
      log.warn(
        `[lk-session] ⚠ LONG SESSION: ${rec.kind} ${rec.identity} in ${rec.roomId} ran ${mins} minutes ` +
        `(threshold ${(lazyConfig.longSessionWarnMs / 60_000).toFixed(0)}min). This is what burned the free tier — investigate.`,
      );
    }
  }

  /** Sweep for still-open sessions past the warn threshold. */
  function checkLongSessions() {
    const now = Date.now();
    for (const s of sessions) {
      if (s.end || s.warned) continue;
      if (now - s.start > lazyConfig.longSessionWarnMs) {
        s.warned = true;
        log.warn(
          `[lk-session] ⚠ STILL OPEN ${((now - s.start) / 60_000).toFixed(0)}min: ` +
          `${s.kind} ${s.identity} in ${s.roomId}`,
        );
      }
    }
  }
  const sweeper = setInterval(checkLongSessions, 60_000);
  if (sweeper.unref) sweeper.unref();

  /**
   * Abandon sweeper. Without this an abandoned hold only gets noticed when
   * something else happens to ask — which, for a room whose only visitor just
   * closed their tab, is nobody. The whole point of the cap is that it fires
   * with no further input from the person who left.
   */
  const abandonSweeper = setInterval(() => {
    for (const [roomId, r] of rooms) {
      const reaped = reapPrewarms(r, roomId);
      if (reaped.length) settle(roomId, 'abandon-cap');
    }
  }, Math.max(5_000, Math.floor(lazyConfig.abandonMs / 6)));
  if (abandonSweeper.unref) abandonSweeper.unref();

  /**
   * @param {number} [sinceFloor] clamp the "today" window to at least this
   *   timestamp. Callers reconciling against the webhook tracker must pass its
   *   `observingSince`: this ledger is persisted and survives restarts, the
   *   webhook tracker does not, so an unclamped comparison is between two
   *   different spans of time.
   */
  function ledgerStats(sinceFloor = 0) {
    const now = Date.now();
    const dayAgo = Math.max(now - 86_400_000, sinceFloor || 0);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const minutesSince = (since) =>
      sessions.reduce((acc, s) => {
        const start = Math.max(s.start, since);
        const end = s.end || now;
        return end > start ? acc + (end - start) / 60_000 : acc;
      }, 0);
    return {
      open: sessions.filter((s) => !s.end).map((s) => ({
        roomId: s.roomId, identity: s.identity, kind: s.kind,
        minutes: +((now - s.start) / 60_000).toFixed(1),
        long: now - s.start > lazyConfig.longSessionWarnMs,
      })),
      minutesToday: +minutesSince(dayAgo).toFixed(1),
      minutesThisMonth: +minutesSince(monthStart).toFixed(1),
      longSessionThresholdMin: lazyConfig.longSessionWarnMs / 60_000,
      windowStart: sinceFloor || null,
    };
  }

  // ── state machine ─────────────────────────────────────────────────────────

  function push(roomId, state, reason) {
    if (!broadcastToRoom) return;
    broadcastToRoom(roomId, { type: 'lk_activity', state, reason, ts: Date.now() });
  }

  /**
   * Drop holds that have either been abandoned (no progress for abandonMs) or
   * hit the absolute TTL backstop. Returns what it reaped, for logging.
   */
  function reapPrewarms(r, roomId) {
    const now = Date.now();
    const reaped = [];
    for (const [tok, hold] of r.prewarms) {
      if (tok === '__broadcast__') continue; // not a guest hold
      // Legacy numeric holds (pre-abandon-cap) — treat as TTL-only.
      const h = typeof hold === 'number' ? { ttlAt: hold, abandonAt: Infinity } : hold;
      if (h.abandonAt <= now) {
        r.prewarms.delete(tok);
        reaped.push({ tok, why: 'abandoned', stage: h.stage });
        log.log(`[lk-activity] ${roomId}: prewarm ${tok} ABANDONED at stage "${h.stage}" — released at the ${lazyConfig.abandonMs}ms cap, not the ${lazyConfig.prewarmTtlMs}ms TTL`);
      } else if (h.ttlAt <= now) {
        r.prewarms.delete(tok);
        reaped.push({ tok, why: 'ttl' });
        log.warn(`[lk-activity] ${roomId}: prewarm ${tok} hit the TTL backstop — the abandon cap should normally have caught this first`);
      }
    }
    return reaped;
  }

  function wants(r, roomId) {
    // Anything that justifies holding a connection.
    if (r.seats.size > 0) return true;
    reapPrewarms(r, roomId);
    return r.prewarms.size > 0;
  }

  function settle(roomId, reason) {
    const r = room(roomId);
    if (!lazyConfig.enabled) return; // flag off: overlay stays always-connected
    if (wants(r, roomId)) {
      if (r.graceTimer) { clearTimeout(r.graceTimer); r.graceTimer = null; }
      if (r.state !== 'live') {
        r.state = 'live';
        push(roomId, 'wake', reason);
        log.log(`[lk-activity] ${roomId}: → WAKE (${reason})`);
      }
      return;
    }
    // nothing wants a connection — start (or keep) the grace timer
    if (r.state === 'idle' || r.graceTimer) return;
    r.graceTimer = setTimeout(() => {
      r.graceTimer = null;
      if (wants(r, roomId)) return; // someone arrived during grace
      r.state = 'idle';
      push(roomId, 'sleep', 'grace-expired');
      log.log(`[lk-activity] ${roomId}: → SLEEP (grace expired)`);
    }, lazyConfig.graceMs);
    if (r.graceTimer.unref) r.graceTimer.unref();
    log.log(`[lk-activity] ${roomId}: grace started (${lazyConfig.graceMs}ms, ${reason})`);
  }

  return {
    /** Join sheet opened — earliest credible intent. Returns a prewarm token. */
    prewarm(roomId) {
      const r = room(roomId);
      const token = Math.random().toString(36).slice(2, 10);
      // Two clocks per hold: the ABANDON cap (short, reset by progress) and
      // the TTL backstop (long, absolute). Whichever fires first wins.
      r.prewarms.set(token, {
        ttlAt: Date.now() + lazyConfig.prewarmTtlMs,
        abandonAt: Date.now() + lazyConfig.abandonMs,
        stage: 'sheet-open',
        lastProgressAt: Date.now(),
      });
      settle(roomId, 'prewarm');
      return token;
    },
    /**
     * Client reports forward motion in the join flow — restarts the abandon
     * clock. A slow human in a wallet dialog keeps their hold; a closed tab
     * stops reporting and loses it at the cap.
     */
    prewarmProgress(roomId, token, stage) {
      const r = room(roomId);
      const hold = r.prewarms.get(token);
      if (!hold) return false;
      if (stage && !lazyConfig.progressStages.includes(stage)) return false;
      hold.abandonAt = Date.now() + lazyConfig.abandonMs;
      hold.lastProgressAt = Date.now();
      if (stage) hold.stage = stage;
      return true;
    },
    /** Guest abandoned the sheet without buying. */
    cancelPrewarm(roomId, token) {
      const r = room(roomId);
      if (token) r.prewarms.delete(token);
      settle(roomId, 'prewarm-cancelled');
    },
    /** A seat was granted (paid) — hard commitment. */
    seatOccupied(roomId, seatId) {
      room(roomId).seats.add(seatId);
      settle(roomId, 'seat-occupied');
    },
    /** Seat ended. Grace timer starts if it was the last one. */
    seatVacated(roomId, seatId) {
      room(roomId).seats.delete(seatId);
      settle(roomId, 'seat-vacated');
    },
    /** Streamer broadcast state — only meaningful in scope:'broadcast' rooms. */
    setBroadcasting(roomId, on) {
      const r = room(roomId);
      if (on) r.prewarms.set('__broadcast__', Number.MAX_SAFE_INTEGER);
      else r.prewarms.delete('__broadcast__');
      settle(roomId, on ? 'broadcast-start' : 'broadcast-stop');
    },

    /**
     * Overlay heartbeat — proves the browser source is alive AND drives the
     * session ledger off reported LiveKit state transitions. The overlay stays
     * dumb (it just reports what it is doing); the ledger is derived here so
     * "connected minutes" is measured, not assumed.
     */
    beat(roomId, lkState, identity) {
      const r = room(roomId);
      r.overlay.lastBeat = Date.now();
      if (identity) r.overlay.identity = identity;
      if (lkState && lkState !== r.overlay.lkState) {
        const was = r.overlay.lkState;
        r.overlay.lkState = lkState;
        // 'live' means an actual LiveKit connection exists and is billing.
        if (lkState === 'live' && !r.overlay.sessionId) {
          r.overlay.sessionId = sessionStart(roomId, identity || 'overlay:?', 'overlay');
        } else if (lkState !== 'live' && r.overlay.sessionId) {
          sessionEnd(r.overlay.sessionId);
          r.overlay.sessionId = null;
        }
        log.log(`[lk-activity] ${roomId}: overlay ${was} → ${lkState}`);
      }
    },
    /** Overlay page went away (pagehide / WS close) — close any open record. */
    overlayGone(roomId) {
      const r = room(roomId);
      if (r.overlay.sessionId) {
        sessionEnd(r.overlay.sessionId);
        r.overlay.sessionId = null;
      }
      r.overlay.lkState = 'idle';
      r.overlay.lastBeat = 0;
    },
    /** Health for the booth dashboard + paid-join guard. */
    overlayHealth(roomId) {
      const r = room(roomId);
      const connected = hasOverlay ? hasOverlay(roomId) : false;
      const age = r.overlay.lastBeat ? Date.now() - r.overlay.lastBeat : Infinity;
      const stale = age > lazyConfig.heartbeatStaleMs;
      return {
        present: connected,
        healthy: connected && !stale,
        lkState: r.overlay.lkState,
        activityState: r.state,
        lastBeatMsAgo: Number.isFinite(age) ? age : null,
        seats: r.seats.size,
        pendingPrewarms: r.prewarms.size,
      };
    },

    /** Current desired state, for the polling fallback. */
    desired(roomId) {
      const r = room(roomId);
      if (!lazyConfig.enabled) return 'wake';
      return wants(r, roomId) || r.graceTimer ? 'wake' : 'sleep';
    },

    sessionStart,
    sessionEnd,
    ledgerStats,
  };
}
