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
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLedger } from './bounty-ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'overlay-visibility.jsonl');

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
  if (!ledger) ledger = createLedger({ filePath: STORE_PATH, kind: 'overlay-visibility' });
  return ledger;
}

/** Test seam — the gates point DATA_DIR at a scratch dir per run. */
export function _resetForTests() {
  ledger = null;
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

  const l = getLedger();
  l.load();
  const previous = latestFor(roomId, sessionKey);
  // A repeat of the same (signal, reason) is not a transition. Poll cadence is
  // the client's business; the chain records what changed.
  if (previous && previous.signal === signal && previous.reason === reason) {
    return { appended: false, row: previous, previous };
  }
  const row = l.append({
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
  return { appended: true, row, previous };
}

/** Every row for a room, oldest first. */
export function signalsFor(roomId, { sessionKey = null, since = null } = {}) {
  const l = getLedger();
  l.load();
  return l.all().filter((r) =>
    r.type === 'overlay_visibility'
    && r.roomId === String(roomId)
    && (sessionKey == null || r.sessionKey === String(sessionKey))
    && (since == null || r.at >= since));
}

/** The most recent row for a room, or null. */
export function latestFor(roomId, sessionKey = null) {
  const rows = signalsFor(roomId, { sessionKey });
  return rows.length ? rows[rows.length - 1] : null;
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
