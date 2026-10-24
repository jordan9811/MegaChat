/**
 * LIVE SEAT ESCROW (Pass C Part 3b / 3c).
 *
 * ⚠ REAL MONEY IS DECIDED HERE. This module signs nothing, but server.js
 * installs the real settlement door (setSettlement, at boot), so every
 * platform-mode sweep, buried-seconds refund, clawback and maturity below is
 * an intent that door PAYS from the platform wallet under
 * PLATFORM_SETTLEMENT_KEY, and an escrow-mode seat's figures become the
 * attestation the escrow contract pays by. Only the bounty escrow is still
 * stub-settled. A wrong number here is a wrong payment.
 *
 * ── Why a seat is not a pledge ────────────────────────────────────────────
 * A live seat is a per-second METER. The bounty escrow is DISCRETE-OBJECT
 * shaped: one contribution, one clip, one airing, one release. Forcing a meter
 * into that shape gives either one escrow per tick (thousands of rows that
 * say the same thing) or one escrow per session (which cannot express "the
 * guest was on screen for forty minutes and buried for three"). So a seat gets
 * a ROLLING PENDING BUCKET that ticks accrue into and that visibility signals
 * sweep in chunks.
 *
 * ── The state machine ─────────────────────────────────────────────────────
 *   OPEN      the meter runs; ticks accrue into pending
 *   PAUSED    overlay_hidden — the server-driven meters skip ticks; the guest
 *             is not on the broadcast and the viewer is not charged
 *   CLOSED    the seat ended; pending is swept (obs-websocket rooms) or held
 *             until stream end + tail (manual-paste rooms, 3c)
 *   SETTLING  swept, with a holdback outstanding for the clawback window
 *   SETTLED   holdback matured to the streamer — terminal
 *   CLAWED    holdback returned to the viewer — terminal
 *
 * ── The money rules, each with its reason ─────────────────────────────────
 * SWEEP releases (1 − holdbackFraction) of pending to the streamer at once and
 *   holds the rest. Optimistic release with a holdback is option B of
 *   docs/decisions/post-release-clawback.md, reused here rather than built a
 *   second way: a reversal is then a NON-PAYMENT of the tail, never a debt.
 * BURIED seconds refund to the viewer, backdated to the hidden window's start.
 *   OBS stamps nothing, so that start is the poll receipt; the poll interval is
 *   the uncertainty. The detection lag before it — one poll plus the HLS delay
 *   the audience sees, seatDetectionLagMs — is refunded from the PLATFORM
 *   bucket: the viewer was not on screen, the streamer did not know, and the
 *   platform is the party that could have looked sooner. Logged as cost.
 * SOURCE_UNAVAILABLE claws NOTHING. "We could not look" refunds a whole clip
 *   because a clip either aired or did not; a seat that was on screen for an
 *   hour is not unmade by our failure to check the last five minutes. It
 *   flags for review and the holdback matures on schedule.
 * CLAWBACK takes at most the holdback. Money released optimistically is the
 *   streamer's; the holdback is the only slice still ours to withhold.
 * MANUAL-PASTE rooms emit no visibility signal, so nothing sweeps them
 *   mid-stream. They sweep once at stream end + seatManualTailMs, capped at
 *   seatManualMaxHoldMs from seat open, then release optimistically with the
 *   same holdback and window. The dashboard says why, and what shortens it.
 *
 * Every writer takes an idempotency key; a retried call appends nothing and
 * returns the original row. An illegal state move throws before any write.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { createLedger } from './bounty-ledger.js';
import { StubSettlement } from './bounty-settlement.js';
import { signalsFor, visibilityVerdict } from './overlay-visibility.js';
import { fromAtomic } from './token-utils.js';
import { envNum } from './env-num.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LEDGER_PATH = path.join(DATA_DIR, 'seat-ledger.jsonl');

// envNum: unset or '' is the default (Number('') is 0, which used to read a
// cleared variable as a zero window); a negative or non-number value is the
// default with one warning naming the variable. 0 stays 0 (SEAT_DETECTION_LAG_MS=0 is a gate setting).
const num = (name, d) => envNum(name, d, { min: 0 });
const fraction = (name, d) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return d;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : d;
};

/** The decisions, as numbers. Env names only — see docs/features/live-seats.md. */
export const seatConfig = {
  /** Fraction of each sweep held back until the clawback window closes. */
  holdbackFraction: fraction('SEAT_HOLDBACK_FRACTION', 0.2),
  /** How long a holdback waits for a flag before it matures. Same clock as the bounty dispute window. */
  clawbackWindowMs: num('SEAT_CLAWBACK_WINDOW_MS', 72 * 60 * 60_000),
  /** One visibility poll (5 s) plus the broadcast delay the audience sees (~25 s). Charged to the platform. */
  detectionLagMs: num('SEAT_DETECTION_LAG_MS', 30_000),
  /** Manual-paste rooms: sweep this long after the stream ends… */
  manualTailMs: num('SEAT_MANUAL_TAIL_MS', 10 * 60_000),
  /** …and never later than this after the seat opened. */
  manualMaxHoldMs: num('SEAT_MANUAL_MAX_HOLD_MS', 24 * 60 * 60_000),
  /** Ambient sweep cadence for maturities and manual releases. A 0 would be a 1 ms timer: floor 1 s. */
  sweepMs: envNum('SEAT_SWEEP_MS', 60_000, { min: 1000 }),
};

export const SEAT_STATES = ['OPEN', 'PAUSED', 'CLOSED', 'SETTLING', 'SETTLED', 'CLAWED'];

export const SEAT_TRANSITIONS = {
  OPEN:     ['PAUSED', 'CLOSED'],
  PAUSED:   ['OPEN', 'CLOSED'],
  CLOSED:   ['SETTLING', 'SETTLED'],
  SETTLING: ['SETTLED', 'CLAWED'],
  SETTLED:  [],
  CLAWED:   [],
};

export class IllegalSeatTransition extends Error {
  constructor(from, to) {
    super(`Illegal seat transition: ${from ?? 'none'} → ${to}`);
    this.name = 'IllegalSeatTransition';
    this.code = 'illegal_seat_transition';
    this.from = from;
    this.to = to;
  }
}

export function canTransitionSeat(from, to) {
  if (from == null) return to === 'OPEN';
  return (SEAT_TRANSITIONS[from] || []).includes(to);
}

/**
 * Named causes for the review builder. A seat outcome that pays zero or
 * delays payment is never silent: it lands here with a sentence a reviewer
 * can act on.
 */
export const SEAT_REVIEW_CAUSES = {
  SOURCE_UNAVAILABLE: 'seat verification could not look — nothing is clawed back and the holdback matures on schedule; a person decides whether to re-check',
  CLAWBACK: 'seat holdback returned to the viewer — a chunk released optimistically was found not to have been on screen',
  BURIED: 'guest was not on the broadcast while the overlay was hidden — those seconds refunded to the viewer, the detection lag charged to the platform',
  MANUAL_HOLD: 'no obs-websocket signal for this room — seat money holds until the stream ends plus a tail, then releases optimistically',
};

// ── ledger + settlement ────────────────────────────────────────────────────

let ledger = null;
function L() {
  if (!ledger) ledger = createLedger({ filePath: LEDGER_PATH, kind: 'seat-ledger' });
  return ledger;
}

let settlement = new StubSettlement({ log: { log() {} } });
/**
 * server.js installs the REAL settlement door here at boot; gates install a
 * counting door of their own. Installing a door is also the boot check of the
 * ledger it will pay from (see verifySeatLedgerIntegrity).
 */
export function setSettlement(s) {
  settlement = s;
  if (verifySeatLedgerIntegrity().ok) reissueRefusedIntents();
}
// SESSION 2 — a seat whose money sits in the escrow CONTRACT resolves there,
// not through the door. The server registers a hook so a clawback on such a
// seat becomes an attestation (more hidden units) instead of a door refund.
let escrowHook = null;
export function setEscrowHook(fn) { escrowHook = fn; }

/**
 * Validate the seat ledger now, without throwing. A damaged ledger LATCHES
 * (bounty-ledger.js): every later read and write here throws, the error is
 * logged once, /api/health shows it, and both money doors stop sending
 * (corruptMoneyLedger). Run at boot by setSettlement, so a damaged file is
 * known before the first seat ticks rather than at the first tick.
 */
export function verifySeatLedgerIntegrity() {
  try { L().load(); return { ok: true }; } catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
}

const big = (v) => BigInt(v || 0);

// ── the door ───────────────────────────────────────────────────────────────

/**
 * The door intent a money row of this ledger owes, or null. The one place
 * that maps a seat row to a payment; the refs are deterministic, so the door
 * dedupes a repeat.
 */
function doorIntentFor(seat, r) {
  const id = seat.seatId;
  const amt = (a) => ({ amount: fromAtomic(a, seat.token.decimals), amountAtomic: a.toString(), token: seat.token });
  switch (r.type) {
    case 'SEAT_REFUND_BURIED': {
      const fs = big(r.fromStreamer), fp = big(r.fromPlatform);
      if (seat.mode === 'platform' && fs + fp > 0n) return ['refund', { to: seat.viewer, ...amt(fs + fp), ref: `seat:${id}:buried:${r.from}`, meta: { seatId: id, fromStreamer: fs.toString(), fromPlatform: fp.toString() } }];
      // SESSION 2 — the streamer's part of an escrow seat's bury is attested to
      // the contract (hidden units). The detection LAG is the platform's cost,
      // and the contract has no platform pocket, so that part alone stays a
      // door intent: the viewer is made whole for both, by two payers.
      if (seat.mode === 'escrow' && fp > 0n) return ['refund', { to: seat.viewer, ...amt(fp), ref: `seat:${id}:buried:${r.from}:lag`, meta: { seatId: id, fromPlatform: fp.toString(), mode: 'escrow' } }];
      return null; // 'direct': the row records what a refund WOULD have been
    }
    // Only a platform-mode seat is paid from the platform wallet. An escrow
    // seat is paid by the contract at finalize; a direct seat was paid per tick.
    case 'SEAT_SWEEP': { const a = big(r.released); return a > 0n && seat.mode === 'platform' ? ['release', { to: seat.streamer, ...amt(a), bucket: 'streamer', ref: `seat:${id}:sweep:${r.at}`, meta: { seatId: id } }] : null; }
    case 'SEAT_CLAWBACK': { const a = big(r.amount); return a > 0n && seat.mode === 'platform' ? ['refund', { to: seat.viewer, ...amt(a), ref: `seat:${id}:clawback`, meta: { seatId: id, cause: r.cause } }] : null; }
    case 'SEAT_MATURE': { const a = big(r.amount); return a > 0n && seat.mode === 'platform' ? ['release', { to: seat.streamer, ...amt(a), bucket: 'holdback', ref: `seat:${id}:mature`, meta: { seatId: id } }] : null; }
    default: return null;
  }
}

/**
 * Hand a money row's intent to the door. If the door REFUSES (its ledger, or
 * a money ledger beside it, is latched corrupt), the seat ledger keeps the
 * obligation as a SEAT_DOOR_PENDING row and the seat's own flow carries on —
 * a refused door used to throw out of close() after the sweep row was
 * written, leaving the seat open and the payment recorded nowhere the door
 * would ever see. The next setSettlement (boot) re-issues every such row.
 */
let doorRefusedSaid = false;
function pay(seat, row) {
  const d = doorIntentFor(seat, row);
  if (!d) return null;
  try { return settlement[d[0]](d[1]); }
  catch (e) {
    if (!doorRefusedSaid) { doorRefusedSaid = true; console.error(`[seat-escrow] the settlement door refused ${d[1].ref} (${e.message}) — kept as SEAT_DOOR_PENDING, re-issued when a door is installed`); }
    append(null, { type: 'SEAT_DOOR_PENDING', seatId: seat.seatId, method: d[0], ref: d[1].ref, args: d[1], error: String(e.message).slice(0, 200) },
      { idempotencyKey: `seat:door-pending:${d[1].ref}` });
    return null;
  }
}

/** Boot: every intent the door refused before is handed to it again, once (idempotent on its ref). */
export function reissueRefusedIntents() {
  if (typeof settlement.status !== 'function') return { reissued: 0 };
  let reissued = 0;
  for (const r of L().all()) {
    if (r.type !== 'SEAT_DOOR_PENDING' || settlement.status(r.ref)) continue;
    try { settlement[r.method](r.args); reissued += 1; } catch (e) { console.error(`[seat-escrow] re-issuing ${r.ref} failed: ${e.message}`); return { reissued, failed: true }; }
  }
  if (reissued) console.warn(`[seat-escrow] re-issued ${reissued} intent(s) the door had refused`);
  return { reissued };
}

// ── fold ───────────────────────────────────────────────────────────────────
// This module is the only writer of its ledger, and the ledger only grows, so
// the view is folded ONCE and then advanced by the rows appended since
// (stores-4). Re-folding every row on every tick cost ~13 ms at 100k rows,
// and the ledger gains a row per paid seat-second. A ledger reloaded under us
// (a torn tail truncated, or a test reset) is a new rows array: start over.

let view = null; // { rows, through, seats: Map<seatId, record>, byKey: Map<idempotencyKey, row> }

function openRecord(r) {
  return {
    seatId: r.seatId, roomId: r.roomId, viewer: r.viewer || null, streamer: r.streamer || null,
    token: r.token || { symbol: 'USDC', decimals: 6 }, tickMs: r.tickMs || 1000,
    // 'platform': the door pays from the platform wallet (points/credit, legacy).
    // 'escrow':   the cap is in contracts/MegaChatEscrow.sol; finalize pays.
    // 'direct':   viewer pays the streamer per tick; no escrow, no mediation.
    mode: r.mode || 'platform',
    state: 'OPEN', openedAt: r.at, closedAt: null, pausedAt: null, pauses: [],
    accrued: 0n, refundedFromStreamer: 0n, refundedFromPlatform: 0n,
    // The newest tick time any bury has already refunded (money-2). Derived
    // from the `to` every SEAT_REFUND_BURIED row carries; no migration.
    refundedThrough: -Infinity,
    released: 0n, heldBack: 0n, matured: 0n, clawed: 0n,
    pending: 0n, holdbackOutstanding: 0n,
    lastSweepAt: null, sweeps: 0, ticks: [], flags: [], history: [{ type: 'SEAT_OPEN', at: r.at, from: null, to: 'OPEN' }],
  };
}

function applyRow(seats, r) {
  if (r.type === 'SEAT_OPEN') { seats.set(r.seatId, openRecord(r)); return; }
  const s = seats.get(r.seatId);
  if (!s) return;
  if (r.toState) s.state = r.toState;
  switch (r.type) {
    case 'SEAT_ACCRUE': s.accrued += big(r.amount); s.ticks.push({ at: r.at, amount: r.amount }); break;
    case 'SEAT_PAUSE': s.pausedAt = r.at; s.pauses.push({ from: r.at, to: null, reason: r.reason || null }); break;
    case 'SEAT_RESUME': { const p = s.pauses[s.pauses.length - 1]; if (p && p.to == null) p.to = r.at; s.pausedAt = null; break; }
    case 'SEAT_REFUND_BURIED':
      s.refundedFromStreamer += big(r.fromStreamer); s.refundedFromPlatform += big(r.fromPlatform);
      if (Number.isFinite(r.to) && r.to > s.refundedThrough) s.refundedThrough = r.to;
      break;
    case 'SEAT_SWEEP': s.released += big(r.released); s.heldBack += big(r.heldBack); s.lastSweepAt = r.at; s.sweeps += 1; break;
    case 'SEAT_CLOSE': s.closedAt = r.at; break;
    case 'SEAT_MATURE': s.matured += big(r.amount); break;
    case 'SEAT_CLAWBACK': s.clawed += big(r.amount); break;
    case 'SEAT_FLAG': s.flags.push({ cause: r.cause, at: r.at, detail: r.detail || null }); break;
    default: break;
  }
  s.history.push({ type: r.type, at: r.at, from: r.fromState ?? null, to: r.toState ?? null });
  s.pending = s.accrued - s.refundedFromStreamer - s.released - s.heldBack;
  s.holdbackOutstanding = s.heldBack - s.matured - s.clawed;
}

function sync() {
  const rows = L().all();
  if (!view || view.rows !== rows || rows.length < view.through) {
    view = { rows, through: 0, seats: new Map(), byKey: new Map() };
  }
  for (; view.through < rows.length; view.through++) {
    const r = rows[view.through];
    // The FIRST row with a key is the one a retried writer gets back.
    if (r.idempotencyKey && !view.byKey.has(r.idempotencyKey)) view.byKey.set(r.idempotencyKey, r);
    applyRow(view.seats, r);
  }
  return view;
}

// Callers get a snapshot of the scalars (state, balances) as of the call, as
// a full re-fold used to give them; the tick/pause/flag/history arrays are
// shared and only ever grow.
const snapshot = (s) => ({ ...s });

export function seatRecord(seatId) {
  const s = sync().seats.get(seatId);
  return s ? snapshot(s) : null;
}

export function listSeats(filter = {}) {
  const out = [];
  for (const s of sync().seats.values()) {
    if (filter.roomId && s.roomId !== filter.roomId) continue;
    if (filter.state && s.state !== filter.state) continue;
    out.push(snapshot(s));
  }
  return out;
}

// ── the one writer ─────────────────────────────────────────────────────────

function append(rec, row, { to = null, idempotencyKey } = {}) {
  if (!idempotencyKey) throw new Error('seat ledger rows require an idempotencyKey');
  const dup = sync().byKey.get(idempotencyKey);
  if (dup) return { row: dup, deduped: true };
  if (to) {
    const from = rec?.state ?? null;
    // Deliberately BEFORE any write: an illegal move leaves zero trace.
    if (!canTransitionSeat(from, to)) throw new IllegalSeatTransition(from, to);
  }
  const r = L().append({
    ...row,
    seatId: rec?.seatId ?? row.seatId,
    fromState: to ? (rec?.state ?? null) : null,
    toState: to,
    idempotencyKey,
    at: row.at ?? Date.now(),
  });
  return { row: r, deduped: false };
}

/**
 * TEST SEAM. The validated writer with a state move, exposed so the gate can
 * drive a seat into every state and prove every illegal move throws and
 * writes nothing. Same function the module uses; nothing bypasses it.
 */
export function _transitionForTests(seatId, to, { idempotencyKey } = {}) {
  const rec = seatRecord(seatId);
  return append(rec, { type: `SEAT_${to}`, seatId, at: Date.now(), reason: 'test seam' },
    { to, idempotencyKey: idempotencyKey || `seam:${seatId}:${to}:${Math.random()}` });
}

// ── lifecycle ──────────────────────────────────────────────────────────────

/** A metered seat opened. Free and whitelisted seats never come here. */
export function open({ seatId, roomId, viewer = null, streamer = null, token = null, tickMs = 1000, mode = 'platform', at = Date.now() }) {
  // The token now travels with the seat — address included — because the
  // settlement door needs it to move the money this ledger says is owed.
  // `mode` says WHERE the money is (see fold): it decides which of this
  // ledger's rows become door intents and which are accounting only.
  if (!seatId || !roomId) throw new Error('open requires seatId and roomId');
  if (!['platform', 'escrow', 'direct'].includes(mode)) throw new Error(`unknown seat money mode: ${mode}`);
  return append(null, { type: 'SEAT_OPEN', seatId, roomId, viewer, streamer, token, tickMs, mode, at },
    { to: 'OPEN', idempotencyKey: `seat:open:${seatId}` });
}

/**
 * A tick was pulled. Recorded whatever the state — a tick that slipped in
 * while PAUSED is money that moved and must be refunded, not forgotten — but
 * never after CLOSE, which is a caller bug worth surfacing.
 */
export function accrue(seatId, amountAtomic, { at = Date.now() } = {}) {
  const rec = seatRecord(seatId);
  if (!rec) return null;
  if (rec.state === 'CLOSED' || rec.state === 'SETTLING' || rec.state === 'SETTLED' || rec.state === 'CLAWED') {
    throw new Error(`seat ${seatId} is ${rec.state} — a tick after close is a meter bug`);
  }
  return append(rec, { type: 'SEAT_ACCRUE', amount: big(amountAtomic).toString(), at },
    { idempotencyKey: `seat:accrue:${seatId}:${at}` });
}

/**
 * Should the meter charge this room's seats right now? Derived from the
 * visibility store, not from seat state, so a seat that opens during a bury
 * starts unpaid. No signal at all means "we cannot tell" — charge, because
 * a manual-paste streamer whose overlay is fine must not stop earning.
 * A damaged visibility chain is different: we cannot tell either way, and
 * the meter does not charge on it (D4). It does not throw either, so one
 * damaged chain cannot abort tickAllMeters for every seat after it.
 */
export function shouldCharge(roomId) {
  const v = visibilityVerdict(roomId);
  if (!v.known) return false;
  return !(v.latest && v.latest.signal === 'overlay_hidden');
}

/**
 * Has this room produced any visibility signal since `since`? (obs-websocket
 * vs manual-paste). A chain that cannot be read counts as no signal: the seat
 * then HOLDS its money until stream end + tail, the conservative path, rather
 * than releasing on a signal we cannot see.
 */
export function isSignalled(roomId, since = 0) {
  try {
    return signalsFor(roomId, { since }).some((r) =>
      r.signal === 'overlay_visible' || r.signal === 'overlay_hidden' || r.signal === 'overlay_scaled_below_floor');
  } catch { return false; }
}

/**
 * The room's visibility changed.
 *   overlay_hidden  → every OPEN seat PAUSES
 *   overlay_visible → every PAUSED seat RESUMES, its buried seconds refund,
 *                     and its pending sweeps (one chunk)
 *   anything else   → nothing. A scaled overlay still shows the guest;
 *                     obs_disconnected is blindness, not a bury.
 */
export function onVisibility(roomId, signal, { at = Date.now(), reason = null } = {}) {
  const out = { paused: [], resumed: [], refunds: [], sweeps: [] };
  if (signal === 'overlay_hidden') {
    for (const s of listSeats({ roomId, state: 'OPEN' })) {
      const r = append(s, { type: 'SEAT_PAUSE', at, reason }, { to: 'PAUSED', idempotencyKey: `seat:pause:${s.seatId}:${at}` });
      if (!r.deduped) out.paused.push(s.seatId);
    }
    return out;
  }
  if (signal === 'overlay_visible') {
    for (const s of listSeats({ roomId, state: 'PAUSED' })) {
      const from = s.pausedAt;
      const r = append(s, { type: 'SEAT_RESUME', at }, { to: 'OPEN', idempotencyKey: `seat:resume:${s.seatId}:${at}` });
      if (r.deduped) continue;
      out.resumed.push(s.seatId);
      const refund = refundBuried(s.seatId, from, at, { at });
      if (refund && !refund.deduped) out.refunds.push({ seatId: s.seatId, ...refund.split });
      const sw = sweep(s.seatId, { at, reason: 'overlay back — chunk' });
      if (sw && !sw.deduped) out.sweeps.push({ seatId: s.seatId, released: sw.released, heldBack: sw.heldBack });
    }
  }
  return out;
}

/**
 * The seconds the guest was not on the broadcast go back to the viewer.
 *
 * Split in two, on purpose: ticks inside [from, to] come out of the
 * STREAMER's pending (they should not exist if the pause worked; an in-flight
 * tick can land), and ticks inside [from − lag, from) come out of the
 * PLATFORM — the bury had already begun, nobody had detected it yet, and that
 * is the platform's cost to carry. The viewer is made whole for both.
 *
 * EACH TICK IS REFUNDED AT MOST ONCE (money-2). Two pauses less than the lag
 * apart have overlapping windows; every tick at or before the newest `to` an
 * earlier bury covered was already refunded (or, before that bury's window,
 * was on screen), so it is skipped. Hide/show toggling once refunded the same
 * ticks again on every flip, out of the platform wallet: 7.75x what the viewer
 * paid at one flip a second. On top of that, a seat's lifetime refunds never
 * exceed what it accrued; if that clamp ever bites, the seat is flagged.
 */
export function refundBuried(seatId, from, to, { at = Date.now() } = {}) {
  const rec = seatRecord(seatId);
  if (!rec || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const lag = seatConfig.detectionLagMs;
  let fromStreamer = 0n;
  let fromPlatform = 0n;
  for (const t of rec.ticks) {
    if (t.at <= rec.refundedThrough) continue;
    if (t.at >= from && t.at <= to) fromStreamer += big(t.amount);
    else if (t.at >= from - lag && t.at < from) fromPlatform += big(t.amount);
  }
  // Never refund more than was paid. The platform's share goes first: it is
  // the part a double count would have come out of.
  const room = rec.accrued - rec.refundedFromStreamer - rec.refundedFromPlatform;
  let clamped = null;
  if (fromStreamer + fromPlatform > room) {
    clamped = { wanted: (fromStreamer + fromPlatform).toString(), allowed: (room > 0n ? room : 0n).toString() };
    let over = fromStreamer + fromPlatform - (room > 0n ? room : 0n);
    const cut = over < fromPlatform ? over : fromPlatform;
    fromPlatform -= cut; over -= cut;
    fromStreamer -= over < fromStreamer ? over : fromStreamer;
  }
  const total = fromStreamer + fromPlatform;
  const r = append(rec, {
    type: 'SEAT_REFUND_BURIED', at,
    from, to, seconds: Math.round((to - from) / 1000), lagMs: lag,
    fromStreamer: fromStreamer.toString(), fromPlatform: fromPlatform.toString(),
    ...(clamped ? { clamped } : {}),
  }, { idempotencyKey: `seat:refund-buried:${seatId}:${from}` });
  if (r.deduped) return { ...r, split: null };
  if (clamped) flag(seatId, 'BURIED', { at, detail: `refund clamped: ${clamped.wanted} wanted, ${clamped.allowed} left of what the seat paid` });
  pay(rec, r.row);
  return { ...r, split: { fromStreamer: fromStreamer.toString(), fromPlatform: fromPlatform.toString(), total: total.toString() } };
}

/**
 * One chunk: release (1 − holdback) of pending to the streamer, hold the
 * rest. Nothing happens on a pending of zero or less — a negative pending
 * (a bury refund larger than what was still unswept) carries forward and is
 * netted from the holdback at maturity.
 */
export function sweep(seatId, { at = Date.now(), reason = 'sweep' } = {}) {
  const rec = seatRecord(seatId);
  if (!rec) return null;
  if (rec.pending <= 0n) return null;
  const bp = BigInt(Math.round(seatConfig.holdbackFraction * 10_000));
  const heldBack = (rec.pending * bp) / 10_000n;
  const released = rec.pending - heldBack;
  const r = append(rec, {
    type: 'SEAT_SWEEP', at, reason,
    released: released.toString(), heldBack: heldBack.toString(), pendingBefore: rec.pending.toString(),
  }, { idempotencyKey: `seat:sweep:${seatId}:${at}` });
  if (r.deduped) return { ...r, released: null, heldBack: null };
  pay(rec, r.row);
  return { ...r, released: released.toString(), heldBack: heldBack.toString() };
}

/**
 * The seat ended. An obs-websocket room sweeps now and moves to SETTLING
 * (holdback outstanding) or SETTLED. A manual-paste room stays CLOSED: its
 * sweep waits for stream end + tail (sweepAll), because nothing ever told us
 * the guest was on screen and nothing will.
 */
export function close(seatId, { at = Date.now(), reason = 'seat ended' } = {}) {
  const rec = seatRecord(seatId);
  if (!rec) return null;
  if (rec.state !== 'OPEN' && rec.state !== 'PAUSED') return { deduped: true, state: rec.state };
  // A seat that ends while PAUSED is refunded for the bury up to now first.
  if (rec.state === 'PAUSED') refundBuried(seatId, rec.pausedAt, at, { at });
  const c = append(rec, { type: 'SEAT_CLOSE', at, reason }, { to: 'CLOSED', idempotencyKey: `seat:close:${seatId}` });
  if (c.deduped) return { ...c, state: 'CLOSED' };
  if (!isSignalled(rec.roomId, rec.openedAt - seatConfig.detectionLagMs)) {
    return { ...c, state: 'CLOSED', manualHold: true };
  }
  return settleAfterSweep(seatId, { at, reason: 'seat closed — final chunk' });
}

function settleAfterSweep(seatId, { at, reason }) {
  sweep(seatId, { at, reason });
  const after = seatRecord(seatId);
  if (after.holdbackOutstanding > 0n) {
    const r = append(after, { type: 'SEAT_SETTLING', at, holdbackOutstanding: after.holdbackOutstanding.toString(), maturesAt: at + seatConfig.clawbackWindowMs },
      { to: 'SETTLING', idempotencyKey: `seat:settling:${seatId}` });
    return { ...r, state: 'SETTLING', maturesAt: at + seatConfig.clawbackWindowMs };
  }
  const r = append(after, { type: 'SEAT_SETTLED', at, reason: 'nothing held back' }, { to: 'SETTLED', idempotencyKey: `seat:settled:${seatId}` });
  return { ...r, state: 'SETTLED' };
}

/** A named cause for review. Money-neutral by itself. */
export function flag(seatId, cause, { at = Date.now(), detail = null } = {}) {
  if (!SEAT_REVIEW_CAUSES[cause]) throw new Error(`unknown seat review cause: ${cause}`);
  const rec = seatRecord(seatId);
  if (!rec) return null;
  return append(rec, { type: 'SEAT_FLAG', at, cause, text: SEAT_REVIEW_CAUSES[cause], detail },
    { idempotencyKey: `seat:flag:${seatId}:${cause}:${at}` });
}

/**
 * Verification did not clear. Takes AT MOST the outstanding holdback back to
 * the viewer and closes the seat as CLAWED. Only SETTLING seats have a
 * holdback to claw.
 */
export function clawback(seatId, { at = Date.now(), cause = 'CLAWBACK', detail = null } = {}) {
  const rec = seatRecord(seatId);
  if (!rec) return null;
  if (rec.state !== 'SETTLING') throw new IllegalSeatTransition(rec.state, 'CLAWED');
  const amount = rec.holdbackOutstanding > 0n ? rec.holdbackOutstanding : 0n;
  flag(seatId, cause, { at, detail });
  const r = append(seatRecord(seatId), { type: 'SEAT_CLAWBACK', at, amount: amount.toString(), cause, detail },
    { to: 'CLAWED', idempotencyKey: `seat:clawback:${seatId}` });
  if (r.deduped) return { ...r, amount: null };
  if (amount > 0n && rec.mode === 'platform') pay(rec, r.row);
  else if (amount > 0n && rec.mode === 'escrow' && escrowHook) escrowHook('clawback', seatId, seatRecord(seatId), amount);
  return { ...r, amount: amount.toString() };
}

/**
 * The clawback window closed with no failure: the holdback goes to the
 * streamer. A SOURCE_UNAVAILABLE flag does not block this — see the header.
 * A negative pending carried forward nets off here, and any shortfall past
 * the holdback is the platform's, logged.
 */
export function mature(seatId, { at = Date.now() } = {}) {
  const rec = seatRecord(seatId);
  if (!rec || rec.state !== 'SETTLING') return null;
  const since = rec.history.filter((h) => h.to === 'SETTLING').pop()?.at ?? rec.closedAt ?? rec.openedAt;
  if (at < since + seatConfig.clawbackWindowMs) return null;
  const blocking = rec.flags.filter((f) => f.cause === 'CLAWBACK');
  if (blocking.length) return null;
  const carry = rec.pending < 0n ? rec.pending : 0n;
  let amount = rec.holdbackOutstanding + carry;
  const platformShortfall = amount < 0n ? -amount : 0n;
  if (amount < 0n) amount = 0n;
  const r = append(rec, { type: 'SEAT_MATURE', at, amount: amount.toString(), carried: carry.toString(), platformShortfall: platformShortfall.toString() },
    { to: 'SETTLED', idempotencyKey: `seat:mature:${seatId}` });
  if (r.deduped) return { ...r, amount: null };
  pay(rec, r.row);
  return { ...r, amount: amount.toString(), platformShortfall: platformShortfall.toString() };
}

/**
 * The ambient sweep. Two jobs:
 *   1. manual-paste seats (CLOSED, never signalled): sweep once stream end +
 *      tail has passed, or the hold cap from seat open — whichever first;
 *   2. SETTLING seats whose clawback window closed: mature.
 * `streamEndedAt(roomId)` is injected by the server (airings know); null
 * means "still live or unknown", and only the cap applies.
 */
export function sweepAll({ now = Date.now(), streamEndedAt = () => null } = {}) {
  const out = { manualReleased: [], matured: [] };
  for (const s of listSeats()) {
    if (s.state === 'CLOSED') {
      const ended = streamEndedAt(s.roomId);
      const tailDue = ended != null && now >= ended + seatConfig.manualTailMs;
      const capDue = now >= s.openedAt + seatConfig.manualMaxHoldMs;
      const signalledNow = isSignalled(s.roomId, s.openedAt - seatConfig.detectionLagMs);
      if (signalledNow || tailDue || capDue) {
        const r = settleAfterSweep(s.seatId, { at: now, reason: signalledNow ? 'signal arrived after close' : tailDue ? 'manual-paste room — stream ended plus tail' : 'manual-paste room — hold cap reached' });
        out.manualReleased.push({ seatId: s.seatId, state: r.state, tailDue, capDue });
      }
      continue;
    }
    if (s.state === 'SETTLING') {
      const m = mature(s.seatId, { at: now });
      if (m && !m.deduped) out.matured.push({ seatId: s.seatId, amount: m.amount });
    }
  }
  return out;
}

// ── read surfaces ──────────────────────────────────────────────────────────

/** What the streamer's dashboard shows for a room. */
export function summaryFor(roomId, { now = Date.now() } = {}) {
  const seats = listSeats({ roomId });
  const dec = seats[0]?.token?.decimals ?? 6;
  const sum = (k) => seats.reduce((a, s) => a + s[k], 0n);
  const pending = seats.reduce((a, s) => a + (s.pending > 0n ? s.pending : 0n), 0n);
  const holdback = sum('holdbackOutstanding');
  const signalled = seats.some((s) => isSignalled(roomId, s.openedAt - seatConfig.detectionLagMs));
  const manualHeld = seats.filter((s) => s.state === 'CLOSED');
  const manualHoldUntil = manualHeld.length ? Math.min(...manualHeld.map((s) => s.openedAt + seatConfig.manualMaxHoldMs)) : null;
  const nextMaturity = seats.filter((s) => s.state === 'SETTLING')
    .map((s) => (s.history.filter((h) => h.to === 'SETTLING').pop()?.at ?? s.closedAt ?? now) + seatConfig.clawbackWindowMs);
  return {
    roomId,
    seats: seats.length,
    signalled,
    pending: fromAtomic(pending, dec),
    released: fromAtomic(sum('released'), dec),
    holdbackOutstanding: fromAtomic(holdback, dec),
    matured: fromAtomic(sum('matured'), dec),
    clawed: fromAtomic(sum('clawed'), dec),
    refundedToViewers: fromAtomic(sum('refundedFromStreamer') + sum('refundedFromPlatform'), dec),
    platformCost: fromAtomic(sum('refundedFromPlatform'), dec),
    manualHeldSeats: manualHeld.length,
    manualHoldUntil,
    nextMaturityAt: nextMaturity.length ? Math.min(...nextMaturity) : null,
    holdbackFraction: seatConfig.holdbackFraction,
    clawbackWindowMs: seatConfig.clawbackWindowMs,
    manualTailMs: seatConfig.manualTailMs,
    manualMaxHoldMs: seatConfig.manualMaxHoldMs,
  };
}

/** Review-shaped items: every flag and clawback, newest first. */
export function reviewItems() {
  const items = [];
  for (const s of listSeats()) {
    for (const f of s.flags) {
      items.push({ kind: 'seat', seatId: s.seatId, roomId: s.roomId, cause: f.cause, reason: SEAT_REVIEW_CAUSES[f.cause], detail: f.detail, at: f.at, state: s.state });
    }
  }
  return items.sort((a, b) => b.at - a.at);
}
