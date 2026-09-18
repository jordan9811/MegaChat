/**
 * GATE H, TIER 3 — the scanner for client-signed and operator-run transfer
 * call sites. Shared by the gate (which diffs against the pinned map) and by
 * anyone updating the pin deliberately (`node _gate-money.pins.mjs` prints
 * the current map).
 *
 * WHAT A HIT IS. A line, outside a comment, containing one of the JSON-RPC
 * methods a wallet signs with, or a viem/bundler/SDK call that signs. String
 * mentions inside a gate's own request filter count too: the pin is about the
 * SET of places that touch these names, and a gate that starts matching a new
 * method is exactly the kind of change that should be looked at.
 *
 * WHAT IT SCANS. The browser sources (web/lib, web/components, web/app, src,
 * public), the operator scripts (scripts/), and every root `_*.mjs` gate or
 * verifier other than the money gate itself. Not the server modules — those are Tier 1, mediated by
 * settlement.js — and not node_modules or build output.
 */
import fs from 'fs';
import path from 'path';

export const TIER3_RE = /eth_sendTransaction|eth_signTransaction|eth_sendRawTransaction|sendUserOperation\(|\.writeContract\(|\.sendTransaction\(|\.signTransaction\(|session\.settle\(/g;

const SKIP_DIRS = /^(node_modules|\.next|\.git|\.codex-worktrees|dist)$/;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.test(e.name)) walk(p, out); }
    else if (/\.(ts|tsx|mjs|js|html)$/.test(e.name)) out.push(p);
  }
}

/** Count hits per file, comments excluded. `text` overrides let the gate feed a synthetic offender. */
export function countTier3({ root = '.', extraFiles = {} } = {}) {
  const files = [];
  for (const d of ['web/lib', 'web/components', 'web/app', 'src', 'public', 'scripts']) walk(path.join(root, d), files);
  // Every root gate and verifier except the money gate and this scanner:
  // their regexes name every signing method on purpose.
  for (const f of fs.readdirSync(root)) if (/^_.*\.mjs$/.test(f) && f !== '_gate-money.pins.mjs' && f !== '_gate-money.mjs') files.push(path.join(root, f));
  const texts = new Map(files.map((f) => [f.split(path.sep).join('/').replace(/^\.\//, ''), fs.readFileSync(f, 'utf8')]));
  for (const [name, text] of Object.entries(extraFiles)) texts.set(name, text);
  const out = {};
  for (const [name, text] of texts) {
    let n = 0;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      const m = line.match(TIER3_RE);
      if (m) n += m.length;
    }
    if (n) out[name] = n;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('_gate-money.pins.mjs')) {
  console.log(JSON.stringify(countTier3(), null, 2));
}
