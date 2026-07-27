/**
 * VERIFY — mirrored test logic has not DRIFTED from the code it mirrors.
 *
 * Some gates cannot cheaply drive the real thing: _gate-mpp-clientpath.mjs
 * copies `normalizeTempoTx` and `WALLET_ONLY_METHODS` out of
 * web/lib/join-page.ts because exercising the original needs a funded wallet
 * and a live chain. That copy is the payment path, and a stale copy there is
 * the worst kind of green: the gate keeps passing while the shipped code
 * changes underneath it.
 *
 * This does not convert the mirror. It makes drift LOUD — the copy and the
 * original are compared directly, so the day someone edits one and not the
 * other, a test fails instead of quietly meaning nothing.
 *
 * See docs/decisions/mirror-test-audit.md.
 */
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

const src = readFileSync('web/lib/join-page.ts', 'utf8');
const gate = readFileSync('_gate-mpp-clientpath.mjs', 'utf8');

/** Pull a `new Set([...])` literal's members, order-insensitively. */
function setMembers(text, name) {
  const i = text.indexOf(`${name} = new Set([`);
  if (i < 0) return null;
  const body = text.slice(i, text.indexOf('])', i));
  return new Set([...body.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

const srcMethods = setMembers(src, 'WALLET_ONLY_METHODS');
const gateMethods = setMembers(gate, 'WALLET_ONLY_METHODS');

ok('the real WALLET_ONLY_METHODS is still findable in join-page.ts',
  !!srcMethods && srcMethods.size > 0, `${srcMethods?.size} methods`);
ok('the gate still carries its copy', !!gateMethods && gateMethods.size > 0,
  `${gateMethods?.size} methods`);

const missing = [...(srcMethods || [])].filter((m) => !gateMethods?.has(m));
const extra = [...(gateMethods || [])].filter((m) => !srcMethods?.has(m));
ok('WALLET_ONLY_METHODS: the copy MATCHES the original (no drift)',
  missing.length === 0 && extra.length === 0,
  missing.length || extra.length
    ? `missing from gate: [${missing}] | stale in gate: [${extra}] — update _gate-mpp-clientpath.mjs`
    : 'identical');

/** Compare the normalizeTempoTx bodies, whitespace-insensitively. */
function normalizeFn(text) {
  const i = text.indexOf('normalizeTempoTx = (tx) => {');
  if (i < 0) return null;
  let depth = 0, j = text.indexOf('{', i);
  const start = j;
  for (; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) break; }
  }
  return text.slice(start, j + 1).replace(/\s+/g, ' ').trim();
}

const srcFn = normalizeFn(src);
const gateFn = normalizeFn(gate);
ok('normalizeTempoTx is still findable in both', !!srcFn && !!gateFn);
ok('normalizeTempoTx: the copy MATCHES the original (no drift)',
  srcFn === gateFn,
  srcFn === gateFn ? 'identical' : `\n    real: ${srcFn}\n    gate: ${gateFn}`);

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
