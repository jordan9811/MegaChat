/**
 * CREATOR BOUNTY — the escrow ledger, genuinely append-only.
 *
 * Why this is its own module now: pools are DERIVED by folding this ledger, so
 * a torn write does not lose one row — it silently changes every balance
 * computed afterwards. Rewriting the whole JSON file on every save (what Run A
 * did) is a money-integrity bug wearing a durability label. This must be
 * correct before settlement is ever real.
 *
 * Format: JSON Lines. One record per line, `fs.appendFileSync` with an fsync,
 * never a whole-file rewrite on the write path.
 *
 * Each record carries:
 *   seq  — 1-based, strictly consecutive
 *   sum  — SHA-256 over the record's own canonical contents (seq included).
 *          v1 (no `sumV`) hashes the TOP-LEVEL fields only: JSON.stringify's
 *          key whitelist applies at every depth, so a nested field (an
 *          intent's token address) is outside it. v2 (`sumV: 2`) hashes the
 *          whole record with keys sorted at every depth. This build READS
 *          both and still WRITES v1: a v2 row would make the previous build
 *          refuse the whole ledger, so the writer flips one deploy later,
 *          once this reader is the rollback floor (OPEN-ISSUES).
 *   It is unkeyed: it catches damage (bit-rot, a careless hand edit, a torn
 *   write), not a deliberate forgery. There is no previous-row hash, so
 *   dropping the final complete rows leaves a valid-looking ledger.
 *
 * On load the rows are validated:
 *   - bad checksum or a GAP in the middle  → the ledger LATCHES corrupt.
 *     A corrupt interior means every derived balance after it is
 *     unknowable, so from then on every read and every append throws the
 *     same LedgerCorrupt, until a person repairs the file. It never serves
 *     an empty view and never writes seq 1 onto the damaged file (verify-1:
 *     an empty view made the settlement door forget a ref it had paid and
 *     pay it again). The process keeps running; the money doors check
 *     `corruptMoneyLedger` and stop sending (D4, DECISIONS 2026-10-24), and
 *     `ledgerHealth()` is what /api/health reports.
 *   - a torn FINAL line (crash mid-append) → truncate to the last valid seq
 *     and log loudly. That is recoverable: the interrupted write never
 *     returned success to a caller, so no one was told it happened.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

/** The ledgers whose damage stops money moving: the two doors' own and the seat ledger they pay from. */
export const MONEY_LEDGER_KINDS = new Set(['settlement', 'seat-ledger', 'escrow-chain']);

// Every ledger file this process has opened → { kind, error }. Keyed by file,
// not by instance, so two instances over one file (a door and a boot check)
// share one state and log a latch once.
const opened = new Map();

/** What /api/health shows: one entry per ledger file this process opened. Names and positions only. */
export function ledgerHealth() {
  return [...opened.entries()].map(([file, s]) => ({
    kind: s.kind, file: path.basename(file), ok: !s.error,
    ...(s.error ? { corruptAtLine: s.error.detail?.line ?? null, expectedSeq: s.error.detail?.expectedSeq ?? null } : {}),
  }));
}

/**
 * The latched error of a money ledger in `dir`, or null. Scoped to one data
 * directory: in production there is one, and a gate's scratch directories
 * must not stop each other's doors.
 */
export function corruptMoneyLedger(dir) {
  const want = path.resolve(dir);
  for (const [file, s] of opened) {
    if (s.error && MONEY_LEDGER_KINDS.has(s.kind) && path.dirname(file) === want) return s.error;
  }
  return null;
}

export class LedgerCorrupt extends Error {
  constructor(msg, detail) {
    super(msg);
    this.name = 'LedgerCorrupt';
    this.code = 'ledger_corrupt';
    this.detail = detail;
  }
}

/** v1 canonical form: top-level keys sorted (and, as a side effect of the whitelist, only those names at depth). */
function canonical(obj) {
  const keys = Object.keys(obj).filter((k) => k !== 'sum').sort();
  return JSON.stringify(obj, keys);
}

export function checksum(record) {
  return createHash('sha256').update(canonical(record)).digest('hex').slice(0, 16);
}

// v2 canonical form: every field at every depth, keys sorted at every depth.
// A replacer FUNCTION, because a replacer array is a whitelist at all depths.
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sortedDeep = (_k, v) => (isPlain(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
export function checksumV2(record) {
  const { sum, ...rest } = record;
  return createHash('sha256').update(JSON.stringify(rest, sortedDeep)).digest('hex').slice(0, 16);
}

/**
 * Per-row verdict. No `sumV` → v1; `sumV: 2` → v2; anything else is damage.
 * Monotonic: once a v2 row is seen, a later v1 row is damage too, so a v2
 * row cannot be downgraded to the weaker rule by stripping its marker.
 */
function sumOkFor(rec, sawV2) {
  if (typeof rec.sum !== 'string') return false;
  if (rec.sumV == null) return !sawV2 && checksum(rec) === rec.sum;
  if (rec.sumV === 2) return checksumV2(rec) === rec.sum;
  return false;
}

export function createLedger({ filePath, log = console, kind = 'ledger' } = {}) {
  const dir = path.dirname(filePath);
  const key = path.resolve(filePath);
  /** @type {any[]} */
  let rows = [];
  let loaded = false;
  /** The latch: the LedgerCorrupt every read and append rethrows once set. */
  let corrupt = null;

  function ensureDir() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function latch(err) {
    corrupt = err;
    const prev = opened.get(key);
    // Logged once per file per process, however many instances read it.
    if (!prev?.error) log.error?.(`[ledger] ${kind} LATCHED CORRUPT — ${err.message}`);
    opened.set(key, { kind, error: err });
  }

  /**
   * Read + validate. Throws LedgerCorrupt on an interior gap or a bad
   * checksum on any line but the last, and latches: the instance serves
   * nothing and writes nothing until `_reset()` and a clean load.
   */
  function load() {
    ensureDir();
    // Validate into a local; only a clean result replaces the view.
    const good = [];
    const done = (recovered) => {
      rows = good;
      loaded = true;
      corrupt = null;
      opened.set(key, { kind, error: null });
      return { recovered };
    };
    if (!fs.existsSync(filePath)) return done(0);

    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return done(0);

    const lines = raw.split('\n');
    // A trailing newline yields a final empty element — not a torn record.
    const hasTrailingNewline = lines[lines.length - 1] === '';
    if (hasTrailingNewline) lines.pop();

    let truncateAfterByte = 0;
    let byteCursor = 0;
    let sawV2 = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // + '\n'
      const isLast = i === lines.length - 1;

      let rec = null;
      let parseOk = true;
      try {
        rec = JSON.parse(line);
      } catch {
        parseOk = false;
      }

      const sumOk = parseOk && isPlain(rec) && sumOkFor(rec, sawV2);
      const seqOk = parseOk && rec && rec.seq === good.length + 1;

      if (parseOk && sumOk && seqOk) {
        if (rec.sumV === 2) sawV2 = true;
        good.push(rec);
        byteCursor += lineBytes;
        truncateAfterByte = byteCursor;
        continue;
      }

      // Only a torn FINAL line (and only when the file didn't end cleanly) is
      // recoverable — an interrupted append never reported success upstream.
      if (isLast && !hasTrailingNewline) {
        log.warn(
          `[bounty-${kind}] torn final record at seq ${good.length + 1} — truncating to ${good.length} valid record(s). ` +
          'This is the crash-mid-append case and is safe: the interrupted write never returned success.',
        );
        try {
          fs.truncateSync(filePath, truncateAfterByte);
        } catch (e) {
          log.error(`[bounty-ledger] could not truncate: ${e.message}`);
        }
        return done(1);
      }

      // Anything else: interior corruption or a sequence gap. Latch and refuse.
      const consequence = kind === 'evidence'
        ? 'Refusing to read it: payouts are computed from this evidence, and a verifier reading past this point would count fewer playbacks than actually aired.'
        : 'Refusing to read or write it: every balance derived after this point would be wrong.';
      const err = new LedgerCorrupt(
        `Escrow ${kind} is corrupt at line ${i + 1} (expected seq ${good.length + 1}). ` +
        consequence + ' Inspect ' + filePath,
        { line: i + 1, expectedSeq: good.length + 1, parseOk, sumOk, seqOk },
      );
      latch(err);
      throw err;
    }

    return done(0);
  }

  function ensureLoaded() {
    if (corrupt) throw corrupt;
    if (!loaded) load();
  }

  /**
   * The ONLY writer. Append-mode + fsync, never a rewrite. A short or failed
   * write is cut back to the size the file had before it, so a partial line
   * can never sit in the interior under a later row; if even that fails the
   * ledger latches, because the next append would bury it.
   */
  function append(record) {
    ensureLoaded();
    ensureDir();
    const seq = rows.length + 1;
    const withSeq = { ...record, seq };
    const rec = { ...withSeq, sum: checksum(withSeq) };
    const buf = Buffer.from(JSON.stringify(rec) + '\n', 'utf8');

    const fd = fs.openSync(filePath, 'a');
    let before = null;
    let failure = null;
    try {
      before = fs.fstatSync(fd).size;
      let written;
      try { written = fs.writeSync(fd, buf); } catch (e) { written = e; }
      if (written === buf.length) fs.fsyncSync(fd); // durability: the row is on disk before we return
      else failure = written instanceof Error ? written.message : `short write: ${written} of ${buf.length} bytes`;
    } finally {
      fs.closeSync(fd);
    }
    if (failure) {
      // By path, after the close: Windows refuses to truncate an append-mode descriptor.
      try { fs.truncateSync(filePath, before); } catch (e) {
        latch(new LedgerCorrupt(`Escrow ${kind}: a failed append could not be cut back (${e.message}); the file may end in a partial row. Inspect ${filePath}`, { line: seq, expectedSeq: seq }));
      }
      throw Object.assign(new Error(`[ledger] ${kind}: append of seq ${seq} failed (${failure}); nothing was recorded`), { code: 'ledger_write_failed' });
    }
    rows.push(rec);
    return rec;
  }

  function all() {
    ensureLoaded();
    return rows;
  }

  function find(pred) {
    ensureLoaded();
    return rows.find(pred) || null;
  }

  /** Test seam — drops the in-memory view and the latch so the next read re-validates. */
  function _reset() {
    loaded = false;
    corrupt = null;
    rows = [];
    opened.delete(key);
  }

  return {
    load, append, all, find, checksum, _reset,
    /** The latched LedgerCorrupt, or null. Does not read the file. */
    get corrupt() { return corrupt; },
    get filePath() { return filePath; },
  };
}
