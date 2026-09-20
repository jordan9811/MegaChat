/**
 * letter-store.js — MegaChats that survive a restart.
 *
 * WHY THIS EXISTS. Letters lived in a `Map` with their video in RAM, and
 * `letters.js` said so in its own header: "letters live in memory only, never
 * on disk." That was right while a MegaChat was a one-shot that queued and
 * aired within seconds. It stops being right the moment a human is asked to
 * review a pile: a deploy or a crash mid-show silently dropped every clip
 * waiting for a decision, and every one of those clips is money somebody paid.
 *
 * WHAT IS ON DISK. Metadata in `letters/meta.json`, one video per letter in
 * `letters/media/<id>`. Never the AI's sampled frames (base64 stills, useful
 * for seconds, large forever) and never the media inside the metadata file.
 *
 * WHAT IS NOT DURABLE. The byte budget is a DISK budget now, and the same cap
 * as before. A letter whose media file has gone missing is dropped on load
 * rather than resurrected as a playable clip with nothing to play.
 *
 * THE MONEY RULE. This module never refunds, never signs and never decides.
 * It reports what it found; `letters.js` decides what that means, and every
 * refund still leaves through the settlement door (Gate H, Tier 1).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Metadata keys that are persisted. Anything else is runtime-only. */
const PERSISTED = [
  'id', 'roomId', 'username', 'payer', 'price', 'durationS', 'mime',
  'flyIn', 'flyOut', 'status', 'paidAt', 'uploadedAt', 'flaggedReason',
  'bounty', 'approvedAt', 'airedAt', 'heldSince',
];

export function createLetterStore({
  dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'),
  maxBytes = 120 * 1024 * 1024,
  log = console,
} = {}) {
  const root = path.join(dataDir, 'letters');
  const mediaDir = path.join(root, 'media');
  const metaPath = path.join(root, 'meta.json');

  function ensure() {
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
  }

  const mediaPathFor = (id) => path.join(mediaDir, String(id).replace(/[^A-Za-z0-9_-]/g, ''));

  function mediaSize(id) {
    try { return fs.statSync(mediaPathFor(id)).size; } catch { return 0; }
  }

  /** Bytes currently on disk across every stored media file. */
  function totalBytes() {
    ensure();
    let n = 0;
    for (const f of fs.readdirSync(mediaDir)) {
      try { n += fs.statSync(path.join(mediaDir, f)).size; } catch { /* vanished */ }
    }
    return n;
  }

  function writeMedia(id, buffer) {
    ensure();
    fs.writeFileSync(mediaPathFor(id), buffer);
  }

  function readMedia(id) {
    try { return fs.readFileSync(mediaPathFor(id)); } catch { return null; }
  }

  function hasMedia(id) {
    try { return fs.statSync(mediaPathFor(id)).size > 0; } catch { return false; }
  }

  function deleteMedia(id) {
    try { fs.unlinkSync(mediaPathFor(id)); } catch { /* already gone */ }
  }

  /** Persist the metadata of every letter worth remembering. */
  function saveMeta(letters) {
    ensure();
    const rows = [];
    for (const l of letters) {
      if (!l || l.status === 'done' || l.status === 'refunding') continue;
      const row = {};
      for (const k of PERSISTED) if (l[k] !== undefined) row[k] = l[k];
      rows.push(row);
    }
    const tmp = `${metaPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), letters: rows }, null, 2));
    fs.renameSync(tmp, metaPath); // atomic: a torn meta.json loses every pending clip
  }

  /**
   * What was on disk when the process started, already reconciled:
   *
   *   · `restored`  letters whose media is present (or which never needed any)
   *   · `orphaned`  metadata whose media file has gone — the caller refunds
   *   · `strays`    media files no metadata claims — deleted here
   *
   * `playing` is rewritten to a resting state by the caller, not here: whether
   * an interrupted clip should air again is a product decision, not a storage
   * one.
   */
  function load() {
    ensure();
    let rows = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      rows = Array.isArray(parsed.letters) ? parsed.letters : [];
    } catch { rows = []; }

    const restored = [], orphaned = [];
    const claimed = new Set();
    for (const row of rows) {
      if (!row || !row.id || !row.roomId) continue;
      claimed.add(String(row.id));
      const needsMedia = row.status !== 'awaiting_upload';
      if (needsMedia && !hasMedia(row.id)) { orphaned.push(row); continue; }
      restored.push(row);
    }

    let strays = 0;
    for (const f of fs.readdirSync(mediaDir)) {
      if (claimed.has(f)) continue;
      try { fs.unlinkSync(path.join(mediaDir, f)); strays += 1; } catch { /* in use */ }
    }
    if (restored.length || orphaned.length || strays) {
      log.log?.(`[letter-store] restored ${restored.length} MegaChat(s), ${orphaned.length} lost their media, ${strays} stray file(s) removed`);
    }
    return { restored, orphaned, strays };
  }

  return {
    root, mediaDir, metaPath, maxBytes,
    mediaPathFor, mediaSize, totalBytes,
    writeMedia, readMedia, hasMedia, deleteMedia,
    saveMeta, load,
  };
}
