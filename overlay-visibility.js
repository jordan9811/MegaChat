/**
 * OVERLAY VISIBILITY — what the streamer's own OBS said about the overlay,
 * while a room was live.
 *
 * WHY APPEND-ONLY. Pass C Part 3 will read these windows to decide whether a
 * paid clip is banked rather than lost, and whether a live seat's seconds are
 * refunded from the moment the overlay went dark. Anything a payout is
 * computed from is evidence in this codebase, not state — the rule
 * bounty-store.js states and bounty-evidence.js implements — so this uses the
 * same seq + checksum chain as the escrow ledger. A torn final record
 * recovers; an interior gap refuses to load, because a hole means every window
 * after it is unknowable and serving confident-but-wrong spans is worse than
 * refusing.
 *
 * WHY TRANSITIONS, NOT POLLS. A poll every few seconds for a four-hour
 * broadcast is thousands of rows that all say the same thing. Only CHANGES are
 * recorded, which is also the shape Part 3 needs: a hidden window has a start
 * and an end. `recordSignal` is idempotent against repetition — handing it the
 * same signal twice in a row appends nothing and returns the open window.
 *
 * WHAT IT IS NOT. Not proof of anything. These samples come from the
 * streamer's own browser talking to their own OBS and can say whatever that
 * browser likes. Broadcast capture is the payout authority; this is
 * corroboration against ACCIDENT, and the confidence tiers in
 * bounty-confidence.js already say what a client-reported signal is worth.
 * Manual-paste streamers have no obs-websocket and emit NOTHING here — the
 * absence of rows is not evidence against them.
 *
 * READ FROM MEMORY. The meter asks `shouldCharge` for every metered seat
 * every second, and each read used to re-read and re-hash the whole file —
 * 31-37 ms a call at 10,000 rows, growing with every transition ever recorded
 * (stores-3). The chain is now validated ONCE, on first use, and indexed by
 * room and by (room, session); `recordSignal` keeps the index current as it
 * appends. This module is the file's only writer, and the server is one
 * process. A chain that fails validation is LATCHED: every later read rethrows
 * the same LedgerCorrupt, so a caller that catches the first error can never
 * be served an empty record, nor append onto a damaged file.
 */
import path from 'path';
import { createLedger } from './bounty-ledger.js';
import { dataDir } from './json-store.js';

/** The signals this store accepts. Anything else is refused rather than
 *  stored — a typo'd signal name that Part 3 never matches would read as
 *  "the overlay was never hidden", which is the expensive direction. */
export const SIGNALS = new Set([
  'overlay_visible',
  'overlay_hidden',
  'overlay_scaled_below_floor',
  'obs_disconnected',
]);

export const HIDDEN_REASONS = new Set(['scene', 'disabled', 'offcanvas', 'covered']);

let ledger = null;
function getLedger() {
  if (!ledger) ledger = createLedger({ filePath: path.join(dataDir(), 'overlay-visibility.jsonl'), kind: 'overlay-visibility' });
  return ledger;
}

/** roomId → its rows, oldest first; `${roomId}\u0000${sessionKey}` → latest row. */
let index = null;
/** The LedgerCorrupt that refused the chain, rethrown on every later read. */
let corrupt = null;

const sessionSlot = (roomId, sessionKey) => `${roomId}\u0000${sessionKey}`;

function indexRow(r) {
  if (r.type !== 'overlay_visibility') return;
  let rows = index.byRoom.get(r.roomId);
  if (!rows) index.byRoom.set(r.roomId, (rows = []));
  rows.push(r);
  if (r.sessionKey != null) index.latestBySession.set(sessionSlot(r.roomId, r.sessionKey), r);
}

function getIndex() {
  if (corrupt) throw corrupt;
  if (index) return index;
  const l = getLedger();
  try {
    l.load(); // validates the whole chain, once
  } catch (e) {
    // Latched here; bounty-ledger.js has already logged the damage, once per
    // file per process — a second line for the same latch was noise (money H13).
    if (e?.code === 'ledger_corrupt') corrupt = e;
    throw e;
  }
  index = { byRoom: new Map(), latestBySession: new Map() };
  for (const r of l.all()) indexRow(r);
  return index;
}

/** Test seam — the gates point DATA_DIR at a scratch dir per run. */
export function _resetForTests() {
  ledger = null;
  index = null;
  corrupt = null;
}

/**
 * Record a signal for a room, if it CHANGED.
 *
 * `sessionKey` ties a run of signals to one broadcast. The airing id is the
 * natural key when the room is following a stream; a room with no airing open
 * passes null and the signals still record against the room, because a
 * streamer who has not connected Twitch still deserves to be told their
 * overlay is hidden.
 *
 * Returns { appended, row, previous } so a caller can tell a change from a
 * repeat without re-reading the chain.
 */
export function recordSignal(roomId, { signal, reason = null, at = Date.now(), detail = null, measurement = null, sessionKey = null }) {
  if (!roomId) throw new Error('recordSignal requires a roomId');
  if (!SIGNALS.has(signal)) throw new Error(`unknown visibility signal: ${signal}`);
  if (reason !== null && !HIDDEN_REASONS.has(reason)) throw new Error(`unknown hidden reason: ${reason}`);

  const previous = latestFor(roomId, sessionKey); // validates the chain on first use
  // A repeat of the same (signal, reason) is not a transition. Poll cadence is
  // the client's business; the chain records what changed.
  if (previous && previous.signal === signal && previous.reason === reason) {
    return { appended: false, row: previous, previous };
  }
  const row = getLedger().append({
    type: 'overlay_visibility',
    roomId: String(roomId),
    sessionKey: sessionKey ? String(sessionKey) : null,
    signal,
    reason,
    at,
    detail: detail ? String(detail).slice(0, 400) : null,
    // The raw numbers the decision was derived from, so a later pass — or a
    // human reading a dispute — can re-derive it rather than trust this row.
    measurement: measurement || null,
  });
  indexRow(row);
  return { appended: true, row, previous };
}

/** Every row for a room, oldest first. */
export function signalsFor(roomId, { sessionKey = null, since = null } = {}) {
  const rows = getIndex().byRoom.get(String(roomId)) || [];
  return rows.filter((r) =>
    (sessionKey == null || r.sessionKey === String(sessionKey))
    && (since == null || r.at >= since));
}

/** The most recent row for a room (or one session of it), or null. */
export function latestFor(roomId, sessionKey = null) {
  const idx = getIndex();
  if (sessionKey != null) return idx.latestBySession.get(sessionSlot(String(roomId), String(sessionKey))) || null;
  const rows = idx.byRoom.get(String(roomId));
  return rows?.length ? rows[rows.length - 1] : null;
}

/**
 * The meter's question, without throwing: `{ known: true, latest }`, or
 * `{ known: false }` when the record cannot be read. Unknown is NOT "no
 * signal" — a manual-paste room's silence means "charge", a damaged record
 * means "we cannot tell", and the meter must not charge on it (DECISIONS D4).
 * The damage itself is logged once, when the chain is first refused.
 */
export function visibilityVerdict(roomId) {
  try {
    return { known: true, latest: latestFor(roomId) };
  } catch (e) {
    return { known: false, error: e?.code || e?.message || 'unreadable' };
  }
}

/** Validate the chain now (boot), throwing LedgerCorrupt on damage. */
export function verifyVisibilityLedgerIntegrity() {
  getIndex();
  return { rows: [...index.byRoom.values()].reduce((n, rows) => n + rows.length, 0) };
}

/**
 * Spans during which the overlay was NOT earning, closed by the next signal.
 *
 * `overlay_hidden` and `overlay_scaled_below_floor` open a window;
 * `overlay_visible` closes it. `obs_disconnected` also CLOSES rather than
 * opens: we stopped being able to look, which is not the same as the overlay
 * being gone, and treating it as a bury would charge a streamer for closing
 * their browser. A window still open at read time has `endedAt: null` — Part 3
 * decides what an unterminated window means, this store does not.
 */
export function hiddenWindows(roomId, { sessionKey = null } = {}) {
  const rows = signalsFor(roomId, { sessionKey });
  const windows = [];
  let open = null;
  for (const r of rows) {
    const isDark = r.signal === 'overlay_hidden' || r.signal === 'overlay_scaled_below_floor';
    if (isDark && !open) {
      open = { signal: r.signal, reason: r.reason, startedAt: r.at, endedAt: null, detail: r.detail };
    } else if (!isDark && open) {
      open.endedAt = r.at;
      open.closedBy = r.signal;
      windows.push(open);
      open = null;
    }
  }
  if (open) windows.push(open);
  return windows;
}
