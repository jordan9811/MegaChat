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
 *   sum  — SHA-256 over the record's own canonical contents (seq included)
 *
 * On load the chain is validated:
 *   - bad checksum or a GAP in the middle  → refuse to start. A corrupt
 *     interior means every derived balance after it is unknowable, and
 *     computing pool totals anyway is exactly the failure this guards.
 *   - a torn FINAL line (crash mid-append) → truncate to the last valid seq
 *     and log loudly. That is recoverable: the interrupted write never
 *     returned success to a caller, so no one was told it happened.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export class LedgerCorrupt extends Error {
  constructor(msg, detail) {
    super(msg);
    this.name = 'LedgerCorrupt';
    this.code = 'ledger_corrupt';
    this.detail = detail;
  }
}

/** Canonical serialization for hashing — key order must not affect the sum. */
function canonical(obj) {
  const keys = Object.keys(obj).filter((k) => k !== 'sum').sort();
  return JSON.stringify(obj, keys);
}

export function checksum(record) {
  return createHash('sha256').update(canonical(record)).digest('hex').slice(0, 16);
}

export function createLedger({ filePath, log = console, kind = 'ledger' } = {}) {
  const dir = path.dirname(filePath);
  /** @type {any[]} */
  let rows = [];
  let loaded = false;

  function ensureDir() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Read + validate. Throws LedgerCorrupt on an interior gap or a bad
   * checksum on any line but the last.
   */
  function load() {
    ensureDir();
    rows = [];
    loaded = true;
    if (!fs.existsSync(filePath)) return { recovered: 0 };

    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return { recovered: 0 };

    const lines = raw.split('\n');
    // A trailing newline yields a final empty element — not a torn record.
    const hasTrailingNewline = lines[lines.length - 1] === '';
    if (hasTrailingNewline) lines.pop();

    const good = [];
    let truncateAfterByte = 0;
    let byteCursor = 0;

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

      const sumOk = parseOk && rec && typeof rec.sum === 'string' && checksum(rec) === rec.sum;
      const seqOk = parseOk && rec && rec.seq === good.length + 1;

      if (parseOk && sumOk && seqOk) {
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
        rows = good;
        return { recovered: 1 };
      }

      // Anything else: interior corruption or a sequence gap. Refuse.
      const consequence = kind === 'evidence'
        ? 'Refusing to start: payouts are computed from this evidence, and a verifier reading past this point would count fewer playbacks than actually aired.'
        : 'Refusing to start: every balance derived after this point would be wrong.';
      throw new LedgerCorrupt(
        `Escrow ${kind} is corrupt at line ${i + 1} (expected seq ${good.length + 1}). ` +
        consequence + ' Inspect ' + filePath,
        { line: i + 1, expectedSeq: good.length + 1, parseOk, sumOk, seqOk },
      );
    }

    rows = good;
    return { recovered: 0 };
  }

  function ensureLoaded() {
    if (!loaded) load();
  }

  /** The ONLY writer. Append-mode + fsync, never a rewrite. */
  function append(record) {
    ensureLoaded();
    ensureDir();
    const seq = rows.length + 1;
    const withSeq = { ...record, seq };
    const rec = { ...withSeq, sum: checksum(withSeq) };
    const line = JSON.stringify(rec) + '\n';

    const fd = fs.openSync(filePath, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd); // durability: the row is on disk before we return
    } finally {
      fs.closeSync(fd);
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

  /** Test seam — drops the in-memory view so the next read re-validates. */
  function _reset() {
    loaded = false;
    rows = [];
  }

  return { load, append, all, find, checksum, _reset, get filePath() { return filePath; } };
}
