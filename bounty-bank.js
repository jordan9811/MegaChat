/**
 * CREATOR BOUNTY — BANKING (Pass C Part 3a).
 *
 * A fan paid for a clip to air. It aired while the overlay was hidden — the
 * streamer had switched scenes, or a BRB card was on top — so nobody saw it
 * and the verifier could not have read it. Before this module that clip was
 * simply LOST: the playback did not verify, the pledge sat HELD until its
 * expiry sweep refunded it, and the streamer earned nothing for a clip they
 * did press play on. This banks it instead, and replays it when the overlay
 * comes back.
 *
 * ── The state machine ─────────────────────────────────────────────────────
 *   QUEUED    the clip is banked; a hidden window covered its playback
 *   DRAINING  the overlay is back and the clip has been handed to the play
 *             queue; the replay has not started yet
 *   REPLAYED  the replay opened a NEW playback window (fresh nonce)
 *   AIRED     verification found a payable airing — terminal; the drain must
 *             never replay a clip that has already paid
 *   EXPIRED   the stream ended with the clip still banked — refunded, terminal
 *
 * A REPLAYED clip whose replay is ALSO buried goes back to QUEUED, at most
 * bankMaxReplays times; after that the bank stops and the normal path (the
 * review queue) takes over. A DRAINING clip goes back to QUEUED when the play
 * queue would not take it.
 *
 * ── Where the record lives, and why ───────────────────────────────────────
 * Every transition is a row in the ESCROW LEDGER (type BANK), idempotency
 * keyed, and the state is FOLDED from those rows — never stored. That is the
 * same discipline pools use, and it buys three things at once: the bank is
 * evidence (an expiry REFUNDS money, and anything a payout is computed from is
 * evidence), every writer is replay-safe by construction (a retried call with
 * the same key appends nothing), and there is no second store to diverge.
 * BANK rows carry amount 0 so getPool() folds straight past them.
 *
 * ── What this deliberately does not do ────────────────────────────────────
 *   - It never pays. AIRED is a fact about verification; release() does the
 *     paying, once per pledge (payablePlaybacks in bounty-escrow.js).
 *   - It never banks a LIVE SEAT. Seats are a meter, not a discrete object —
 *     see seat-escrow.js.
 *   - It never banks on overlay_scaled_below_floor. A scaled overlay was ON
 *     screen; the clip probably aired and we probably could not read it,
 *     which is a review cause, not a replay.
 *   - It never banks a plain letter or a rehearsal playback. Only a clip with
 *     a contribution behind it is a pledge.
 */
import { bountyConfig } from './bounty-claim.config.js';
import * as store from './bounty-store.js';
import * as clips from './bounty-clips.js';
import * as escrow from './bounty-escrow.js';
import { hiddenWindows, latestFor } from './overlay-visibility.js';

export const BANK_STATES = ['QUEUED', 'DRAINING', 'REPLAYED', 'AIRED', 'EXPIRED'];

/** The only legal movement. `null` (no record yet) may only become QUEUED. */
export const BANK_TRANSITIONS = {
  QUEUED:   ['DRAINING', 'EXPIRED', 'AIRED'],
  DRAINING: ['REPLAYED', 'QUEUED', 'EXPIRED', 'AIRED'],
  REPLAYED: ['QUEUED', 'AIRED'],
  AIRED:    [],
  EXPIRED:  [],
};

export class IllegalBankTransition extends Error {
  constructor(from, to) {
    super(`Illegal bank transition: ${from ?? 'none'} → ${to}`);
    this.name = 'IllegalBankTransition';
    this.code = 'illegal_bank_transition';
    this.from = from;
    this.to = to;
  }
}

export function canTransitionBank(from, to) {
  if (from == null) return to === 'QUEUED';
  return (BANK_TRANSITIONS[from] || []).includes(to);
}

// ── fold ───────────────────────────────────────────────────────────────────

/** Every bank record, folded from BANK ledger rows. */
export function bankRecords(filter = {}) {
  const rows = store.listLedger({ type: 'BANK' });
  const byContribution = new Map();
  for (const r of rows) {
    const id = r.meta?.contributionId;
    if (!id) continue;
    let rec = byContribution.get(id);
    if (!rec) {
      rec = {
        contributionId: id,
        clipId: r.meta.clipId || null,
        handleKey: r.handleKey,
        roomId: r.meta.roomId || null,
        airSessionId: r.airSessionId || null,
        state: null,
        bankedAt: null,
        lastQueuedAt: null,
        lastDrainAt: null,
        replays: 0,
        buriedPlaybacks: [],
        replayPlaybackId: null,
        history: [],
      };
      byContribution.set(id, rec);
    }
    // Event time is the caller's clock (meta.at), not the append clock: the
    // expiry and drain clocks must read the same time the decision was made
    // with, and a harness that replays a broadcast must be able to say when.
    const at = r.meta?.at ?? r.at;
    rec.state = r.toState;
    rec.history.push({ from: r.fromState, to: r.toState, at, reason: r.reason });
    if (r.meta.roomId) rec.roomId = r.meta.roomId;
    if (r.airSessionId) rec.airSessionId = r.airSessionId;
    if (r.toState === 'QUEUED') {
      rec.bankedAt = rec.bankedAt ?? at;
      rec.lastQueuedAt = at;
      if (r.meta.playbackId) {
        rec.buriedPlaybacks.push({ playbackId: r.meta.playbackId, hiddenWindow: r.meta.hiddenWindow || null, coverage: r.meta.coverage ?? null });
      }
    }
    if (r.toState === 'DRAINING') rec.lastDrainAt = at;
    if (r.toState === 'REPLAYED') { rec.replays += 1; rec.replayPlaybackId = r.meta.playbackId || null; }
  }
  let out = [...byContribution.values()];
  if (filter.state) out = out.filter((r) => r.state === filter.state);
  if (filter.roomId) out = out.filter((r) => r.roomId === filter.roomId);
  if (filter.handleKey) out = out.filter((r) => r.handleKey === filter.handleKey);
  if (filter.airSessionId) out = out.filter((r) => r.airSessionId === filter.airSessionId);
  return out;
}

export function bankRecord(contributionId) {
  return bankRecords().find((r) => r.contributionId === contributionId) || null;
}

/** Counts by state plus the records, for a status surface. */
export function bankSummary(handleKey) {
  const recs = bankRecords({ handleKey });
  const byState = {};
  for (const s of BANK_STATES) byState[s] = 0;
  for (const r of recs) byState[r.state] = (byState[r.state] || 0) + 1;
  return { byState, records: recs };
}

// ── writers ────────────────────────────────────────────────────────────────

/** The pledge behind a clip id, or null for a letter / rehearsal id. */
function unitFor(clipId) {
  const clip = clipId ? clips.getClipRecord(clipId) : null;
  return clip?.contributionId ? { contributionId: clip.contributionId, clip } : null;
}

const ids = (rec) => ({
  contributionId: rec.contributionId, clipId: rec.clipId, handleKey: rec.handleKey,
  airSessionId: rec.airSessionId, roomId: rec.roomId,
});

/**
 * The one writer. Validates the move BEFORE touching the ledger — an illegal
 * move throws and leaves no trace — and returns the existing row on a replay.
 */
function write(rec, to, { contributionId, clipId, handleKey, airSessionId, roomId, actor = 'system', reason = null, idempotencyKey, meta = {}, now = Date.now() }) {
  const from = rec?.state ?? null;
  if (!canTransitionBank(from, to)) throw new IllegalBankTransition(from, to);
  if (!idempotencyKey) throw new Error('bank transitions require an idempotencyKey');
  const { row, deduped } = store.appendLedger({
    handleKey, airSessionId,
    type: 'BANK', fromState: from, toState: to,
    amount: '0', bucket: 'contributor', actor, reason, idempotencyKey,
    meta: { contributionId, clipId, roomId, at: now, ...meta },
  });
  return { row, deduped, state: deduped ? from : to };
}

/**
 * Was this playback BURIED? The overlay_hidden window that covered at least
 * bankCoverFraction of it, or null. Only `overlay_hidden` counts —
 * `overlay_scaled_below_floor` means the overlay was on screen.
 */
export function buryWindowFor(roomId, win, { now = Date.now(), sessionKey = null } = {}) {
  if (!roomId || !win) return null;
  const end = win.endsAt ?? now;
  const span = Math.max(0, end - win.startedAt);
  if (!span) return null;
  for (const w of hiddenWindows(roomId, { sessionKey })) {
    if (w.signal !== 'overlay_hidden') continue;
    const overlap = Math.min(w.endedAt ?? now, end) - Math.max(w.startedAt, win.startedAt);
    if (overlap >= bountyConfig.bankCoverFraction * span) {
      return { ...w, overlapMs: overlap, coverage: +(overlap / span).toFixed(3) };
    }
  }
  return null;
}

/**
 * Bank a playback if a hidden window covered it. Returns the transition, an
 * `{ already: true }` record when it was already queued, or null when there
 * is nothing to bank (not a pledge, not held, not buried, already terminal,
 * or out of replays).
 */
export function queueBuried(airSessionId, playbackId, { now = Date.now(), actor = 'system', why = 'playback buried' } = {}) {
  const s = store.getAirSession(airSessionId);
  if (!s) return null;
  const win = (s.playbackWindows || []).find((w) => w.playbackId === playbackId);
  if (!win) return null;
  const unit = unitFor(win.clipId);
  if (!unit) return null;
  const c = store.getContribution(unit.contributionId);
  if (!c || c.status !== 'HELD') return null;
  const bury = buryWindowFor(s.roomId, win, { now });
  if (!bury) return null;

  const rec = bankRecord(unit.contributionId);
  if (rec && (rec.state === 'AIRED' || rec.state === 'EXPIRED')) return null;
  if (rec && rec.state === 'QUEUED') return { ...rec, already: true };
  if (rec && rec.replays >= bountyConfig.bankMaxReplays) return null;

  return write(rec, 'QUEUED', {
    contributionId: unit.contributionId, clipId: win.clipId, handleKey: c.handleKey,
    airSessionId, roomId: s.roomId, actor,
    reason: `${why}: overlay hidden (${bury.reason}) covered ${Math.round(bury.coverage * 100)}% of playback ${playbackId}`,
    idempotencyKey: `bank:queue:${unit.contributionId}:${playbackId}`,
    now,
    meta: {
      playbackId,
      hiddenWindow: { startedAt: bury.startedAt, endedAt: bury.endedAt, reason: bury.reason },
      coverage: bury.coverage,
      durationS: win.durationS,
    },
  });
}

/** Hook: a playback window closed. */
export function onPlaybackEnded(airSessionId, playbackId, opts = {}) {
  return queueBuried(airSessionId, playbackId, { ...opts, why: 'playback buried' });
}

/**
 * Hook: a playback window opened. If it is the replay of a DRAINING clip, the
 * bank records the NEW playback id — the fresh nonce is startClipPlayback's
 * own guarantee (gate K); this only records which window is the replay.
 */
export function onPlaybackStarted(airSessionId, playbackId, clipId, { actor = 'system', now = Date.now() } = {}) {
  const unit = unitFor(clipId);
  if (!unit) return null;
  const rec = bankRecord(unit.contributionId);
  if (!rec || rec.state !== 'DRAINING') return null;
  const s = store.getAirSession(airSessionId);
  return write(rec, 'REPLAYED', {
    ...ids(rec), clipId, airSessionId, roomId: s?.roomId || rec.roomId, actor,
    reason: `replay started as playback ${playbackId} (fresh nonce)`,
    idempotencyKey: `bank:replayed:${unit.contributionId}:${playbackId}`,
    now, meta: { playbackId },
  });
}

/**
 * Hook: a verification came back.
 *   - a VERIFIED playback of a banked pledge marks it AIRED, so the drain
 *     never replays a clip that has paid — one payable airing per pledge;
 *   - a NOT_SHOWN playback (sampled, never hit) with a matching hidden window
 *     is banked.
 */
export function onVerification(airSessionId, v, { now = Date.now(), actor = 'verifier' } = {}) {
  const s = store.getAirSession(airSessionId);
  const out = { queued: [], aired: [] };
  if (!s) return out;
  for (const c of v?.clipVerdicts || []) {
    const unit = unitFor(c.clipId);
    if (!unit) continue;
    const rec = bankRecord(unit.contributionId);
    if (c.verified) {
      if (rec && rec.state !== 'AIRED' && rec.state !== 'EXPIRED') {
        const r = write(rec, 'AIRED', {
          ...ids(rec), airSessionId, roomId: s.roomId, actor,
          reason: `verification found playback ${c.playbackId} aired — one payable airing per pledge, no replay`,
          idempotencyKey: `bank:aired:${unit.contributionId}`,
          now, meta: { playbackId: c.playbackId },
        });
        if (!r.deduped) out.aired.push(unit.contributionId);
      }
      continue;
    }
    if ((c.samples || 0) > 0 && (c.hits || 0) === 0) {
      const r = queueBuried(airSessionId, c.playbackId, { now, actor, why: 'verification NOT_SHOWN' });
      if (r && !r.already && !r.deduped) out.queued.push(unit.contributionId);
    }
  }
  return out;
}

/**
 * TEST SEAM. The validated writer, exposed so the gate can put a record into
 * every state and prove every illegal move throws and writes nothing. It is
 * the same function the module uses — there is no unvalidated path.
 */
export function _transitionForTests(contributionId, to, { clipId = 'seed', handleKey = 'twitch:seed', roomId = 'seed-room', airSessionId = null, idempotencyKey } = {}) {
  const rec = bankRecord(contributionId);
  return write(rec, to, {
    contributionId, clipId: rec?.clipId ?? clipId, handleKey: rec?.handleKey ?? handleKey,
    airSessionId: rec?.airSessionId ?? airSessionId, roomId: rec?.roomId ?? roomId,
    actor: 'gate', reason: 'test seam', idempotencyKey: idempotencyKey || `seam:${contributionId}:${to}:${Math.random()}`,
  });
}

// ── drain ──────────────────────────────────────────────────────────────────

let replayer = null;
/**
 * How a banked clip gets back on air. Wired by the server to the letters
 * queue (enqueueStoredClip); gates wire a fake. Contract:
 *   replayer({ roomId, clipId, contributionId, durationS, airSessionId })
 *     → { ok: boolean, reason?: string }
 */
export function setReplayer(fn) { replayer = fn; }

/**
 * Replay at a PACED rate, only while the overlay is back.
 *
 * Per room: at most one QUEUED → DRAINING per bankDrainIntervalMs, oldest
 * first, and only when the room's latest signal is overlay_visible and the
 * air session is still OPEN. A clip the play queue will not take goes back
 * to QUEUED and the interval still applies, so a refusing queue cannot spin.
 */
export function drain({ now = Date.now(), actor = 'system' } = {}) {
  const started = [];
  const byRoom = new Map();
  for (const r of bankRecords({ state: 'QUEUED' })) {
    if (!byRoom.has(r.roomId)) byRoom.set(r.roomId, []);
    byRoom.get(r.roomId).push(r);
  }
  for (const [roomId, queued] of byRoom) {
    const latest = latestFor(roomId);
    if (!latest || latest.signal !== 'overlay_visible') continue;
    const lastDrain = Math.max(0, ...bankRecords({ roomId }).map((r) => r.lastDrainAt || 0));
    if (now - lastDrain < bountyConfig.bankDrainIntervalMs) continue;
    const next = queued.sort((a, b) => (a.lastQueuedAt || 0) - (b.lastQueuedAt || 0))[0];
    const s = store.getAirSession(next.airSessionId);
    if (!s || s.status !== 'OPEN') continue; // nowhere to replay to — expiry takes it
    const clip = clips.getClipRecord(next.clipId);
    if (!clip || clip.purgedAt) continue;
    const n = next.replays + 1;
    const d = write(next, 'DRAINING', {
      ...ids(next), actor,
      reason: `overlay back — replay ${n} of ${bountyConfig.bankMaxReplays}`,
      idempotencyKey: `bank:drain:${next.contributionId}:${n}`,
      now, meta: { attempt: n },
    });
    if (d.deduped) continue;
    let accepted = false;
    let why = 'no replayer wired';
    if (replayer) {
      try {
        const r = replayer({ roomId, clipId: next.clipId, contributionId: next.contributionId, durationS: clip.durationS, airSessionId: next.airSessionId });
        accepted = !!(r && r.ok !== false);
        why = r?.reason || null;
      } catch (e) {
        why = e?.message || String(e);
      }
    }
    if (!accepted) {
      write(bankRecord(next.contributionId), 'QUEUED', {
        ...ids(next), actor,
        reason: `replay not accepted: ${why} — back in the queue`,
        idempotencyKey: `bank:requeue:${next.contributionId}:${n}`,
        now, meta: { attempt: n, playbackId: null },
      });
      continue;
    }
    started.push({ contributionId: next.contributionId, clipId: next.clipId, roomId, attempt: n });
  }
  return started;
}

/** Hook: a room's visibility changed. Only `overlay_visible` drains. */
export function onSignal(roomId, signal, opts = {}) {
  if (signal !== 'overlay_visible') return [];
  return drain(opts);
}

// ── expiry ─────────────────────────────────────────────────────────────────

/**
 * A banked clip that never got its replay REFUNDS. Two clocks, either one
 * expires it: the air session has been CLOSED for bankTailMs, or the clip has
 * been banked for bankMaxHoldMs. The refund goes through the one refund path
 * with the enumerated reason, so it is idempotent per contribution and the
 * recording goes back with the money.
 */
export function sweepExpired({ now = Date.now(), actor = 'system', settlement } = {}) {
  const out = [];
  for (const rec of bankRecords()) {
    if (rec.state !== 'QUEUED' && rec.state !== 'DRAINING') continue;
    const s = store.getAirSession(rec.airSessionId);
    const closedAt = s?.status === 'CLOSED' ? (s.endedAt || null) : null;
    const tailDue = closedAt != null && now >= closedAt + bountyConfig.bankTailMs;
    const capDue = rec.bankedAt != null && now >= rec.bankedAt + bountyConfig.bankMaxHoldMs;
    if (!tailDue && !capDue) continue;
    const w = write(rec, 'EXPIRED', {
      ...ids(rec), actor,
      reason: tailDue
        ? `stream ended ${Math.round((now - closedAt) / 60000)} min ago with the clip still banked`
        : `banked ${Math.round((now - rec.bankedAt) / 3600000)} h ago — hold cap reached`,
      idempotencyKey: `bank:expired:${rec.contributionId}`,
      now, meta: { tailDue, capDue },
    });
    if (w.deduped) continue;
    const c = store.getContribution(rec.contributionId);
    let refunded = [];
    if (c && c.status === 'HELD') {
      refunded = escrow.refund({
        handleKey: c.handleKey, reason: 'BANKED_CLIP_EXPIRED', actor,
        contributionIds: [c.id], reference: `bank:${rec.contributionId}`, settlement,
      });
    }
    out.push({ contributionId: rec.contributionId, clipId: rec.clipId, handleKey: rec.handleKey, airSessionId: rec.airSessionId, refunded: refunded.length, tailDue, capDue });
  }
  return out;
}

/** The ambient sweep: expire what is due, then drain what can drain. */
export function sweep(opts = {}) {
  return { expired: sweepExpired(opts), drained: drain(opts) };
}
