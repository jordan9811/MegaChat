/**
 * JSON STORES — the one way a whole-document store is written, and read.
 *
 * WHY THIS EXISTS (stores-2). Rooms, accounts, the guest whitelist, the bounty
 * board and the airings all wrote in place with `fs.writeFileSync` and read ANY
 * failure as "empty". A torn write — ENOSPC on a growing file, an OOM kill, a
 * host crash before writeback — left half a document; the next load called it
 * empty and the next save made the loss permanent. For rooms.json that save
 * happened at boot, before a human could look.
 *
 * WRITING. A temp file in the SAME directory (rename is atomic only within one
 * filesystem), fsync, then rename over the target: a crash leaves the old
 * document or the new one, never half of either. There is no retry on
 * EPERM/EBUSY — on the dev box OneDrive holds files open, and a write that
 * fails loudly beats one retried blindly (CLAUDE.md).
 *
 * READING. A missing file is a genuine first boot: start empty. Anything else
 * that is not a JSON document — zero bytes (what a torn write leaves),
 * unparsable, the wrong shape, unreadable — REFUSES the store (DECISIONS D3):
 * reads get the empty document, frozen; every write throws StoreRefused; the
 * file is left exactly where and as it was, for a human; it is logged once,
 * loudly. Boot continues and that one feature errors until the file is
 * repaired and the process restarts. The refusal is latched for the life of
 * the process, so a store never flips between "refused" and "empty" under a
 * running server.
 *
 * DEBOUNCED SAVES (DECISIONS D9). `saveSoon()` coalesces a burst of changes
 * into one write at most `debounceMs` later. Only the stores whose owner
 * accepted that a hard kill may lose the last second use it (airing moments,
 * bounty code rotations); everything else writes through on every change.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Where every store lives: DATA_DIR (the volume in production), else
 *  <repo>/data. Resolved per call, so a process that sets DATA_DIR after an
 *  import still writes where it asked (stores-14). */
export function dataDir() {
  return process.env.DATA_DIR || path.join(REPO_DIR, 'data');
}

export class StoreRefused extends Error {
  constructor(name, file, why) {
    super(`The ${name} store refuses writes: ${file} could not be read (${why}). `
      + 'Nothing was changed. Repair or move the file aside, then restart.');
    this.name = 'StoreRefused';
    this.code = 'store_refused';
    this.file = file;
  }
}

/**
 * Write `value` as JSON to `file` atomically: temp + fsync + rename, in the
 * same directory. Throws on failure and leaves the previous file intact.
 */
export function writeJsonAtomic(file, value, { pretty = false } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, JSON.stringify(value, null, pretty ? 2 : undefined));
    fs.fsyncSync(fd); // the bytes are on disk before the name points at them
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already failing */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw e;
  }
  // The rename itself is durable only once the directory entry is. Linux can
  // fsync a directory; Windows cannot open one for that, and it is not where
  // production runs.
  if (process.platform !== 'win32') {
    try {
      const d = fs.openSync(dir, 'r');
      try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
    } catch { /* best effort: the document itself is already safe */ }
  }
}

/**
 * What is on disk at `file`, without deciding what to do about it.
 * @returns {{ state: 'missing' } | { state: 'ok', data: any }
 *   | { state: 'empty' | 'corrupt' | 'unreadable', why: string }}
 */
export function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', why: e.message };
  }
  if (!raw.trim()) return { state: 'empty', why: `${Buffer.byteLength(raw)} bytes, no document — a torn write` };
  try {
    return { state: 'ok', data: JSON.parse(raw) };
  } catch (e) {
    return { state: 'corrupt', why: `${Buffer.byteLength(raw)} bytes, not JSON: ${e.message}` };
  }
}

/** Copy an unreadable file aside (`<file>.corrupt-<iso>`) and return the copy's
 *  path. For OBSERVABILITY files that are better restarted than frozen; a store
 *  of record refuses instead (createJsonStore). */
export function quarantineCopy(file) {
  const to = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, to);
  return to;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

// Debounced stores with a write still pending. Flushed at exit so a clean
// `process.exit()` (every gate ends with one) loses nothing.
const pending = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => flushPendingWrites({ atExit: true }));
}

/** Write every held change now. A signal does not run 'exit' hooks, so a
 *  shutdown handler calls this before exiting. Returns how many were written. */
export function flushPendingWrites({ atExit = false } = {}) {
  let n = 0;
  for (const s of [...pending]) if (s.flush({ atExit })) n++;
  return n;
}

/**
 * A whole-document JSON store.
 *
 * @param {object} o
 * @param {string | (() => string)} o.file  resolved at first load and pinned:
 *        the document is always written back where it was read from
 * @param {string} o.name                    for logs and StoreRefused
 * @param {() => object} o.empty             a fresh empty document
 * @param {(doc: object) => object} [o.normalize]  fill in missing fields; may
 *        throw to call a parsed document the wrong shape (refused, like a parse error)
 * @param {boolean} [o.pretty]               indent on disk (stores a human edits)
 * @param {boolean} [o.writeIfMissing]       write the empty document on a first
 *        boot, so the file exists from then on
 * @param {number}  [o.debounceMs]           how long saveSoon() may hold a write
 * @param {{ error: Function, warn: Function }} [o.log]
 */
export function createJsonStore({ file, name, empty, normalize = (d) => d, pretty = false, writeIfMissing = false, debounceMs = 1000, log = console }) {
  let doc = null;
  let at = null;        // the file this document was read from
  let refused = null;   // { why } once the file on disk could not be read
  let timer = null;
  let dirty = false;

  const resolveFile = () => (typeof file === 'function' ? file() : file);

  function load() {
    if (doc) return doc;
    at = resolveFile();
    const r = readJsonFile(at);
    if (r.state === 'missing') {
      doc = normalize(empty());
      if (writeIfMissing) {
        try { writeJsonAtomic(at, doc, { pretty }); } catch (e) { log.warn(`[${name}] could not create ${at}: ${e.message}`); }
      }
      return doc;
    }
    if (r.state === 'ok') {
      try {
        if (!isPlainObject(r.data)) throw new Error('not a JSON object');
        doc = normalize(r.data);
        return doc;
      } catch (e) {
        r.state = 'corrupt';
        r.why = `wrong shape: ${e.message}`;
      }
    }
    refused = { state: r.state, why: r.why };
    log.error(`[${name}] ⚠ REFUSING WRITES: ${at} is ${r.state} (${r.why}). `
      + 'Serving an empty view and leaving the file untouched — repair or move it aside, then restart.');
    doc = deepFreeze(normalize(empty()));
    return doc;
  }

  /** Throws StoreRefused when the file on disk could not be read. Call it
   *  BEFORE changing the document, so a refused write never leaves the
   *  in-memory view ahead of the disk. */
  function assertWritable() {
    load();
    if (refused) throw new StoreRefused(name, at, refused.why);
  }

  function write() {
    clearTimeout(timer);
    timer = null;
    writeJsonAtomic(at, doc, { pretty });
    // Only once it is on disk: a failed write stays pending, and the next
    // save or the exit hook tries again.
    dirty = false;
    pending.delete(api);
  }

  const api = {
    /** The live document (frozen and empty when refused). */
    data: load,
    assertWritable,
    /** Why writes are refused, or null. */
    refusal: () => (load(), refused ? { ...refused, file: at } : null),
    /** Write now. Also writes anything saveSoon() was holding. */
    save() {
      assertWritable();
      write();
    },
    /** Write within debounceMs, coalescing every change until then (D9). */
    saveSoon() {
      assertWritable();
      dirty = true;
      pending.add(api);
      installExitHook();
      if (!timer) {
        timer = setTimeout(() => api.flush(), debounceMs);
        timer.unref?.();
      }
    },
    /** Write a held change now. Never throws: it runs from a timer or at exit. */
    flush({ atExit = false } = {}) {
      if (!dirty || refused) return false;
      // At exit, a directory a gate already removed is not resurrected.
      if (atExit && !fs.existsSync(path.dirname(at))) return false;
      try {
        write();
        return true;
      } catch (e) {
        log.warn(`[${name}] could not write ${at}: ${e.message}`);
        return false;
      }
    },
    /** Test seam: write anything held, then forget the document so the next
     *  read comes from disk (DATA_DIR may have moved). */
    reset() {
      api.flush();
      clearTimeout(timer);
      timer = null;
      dirty = false;
      pending.delete(api);
      doc = null;
      at = null;
      refused = null;
    },
  };
  return api;
}
