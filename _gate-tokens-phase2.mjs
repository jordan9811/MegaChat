/**
 * Phase 2 pluggable token gate — dry-run decimals + config exposure.
 */
import { toAtomic, fromAtomic } from './token-utils.js';
import { applyStreamTick } from './passkey-meter.js';

const fails = [];
function ok(m) { console.log('  ✓', m); }
function fail(m) { fails.push(m); console.error('  ✗', m); }

try {
  const cap = toAtomic('2', 18);
  const tick = toAtomic('0.001', 18);
  const seat = { id: 't', remainingAtomic: cap, spentAtomic: 0n, paymentMode: 'passkey_stream' };
  let n = 0;
  while (applyStreamTick(seat, tick)) n++;
  if (n !== 2000) fail(`18-decimal sim expected 2000 ticks, got ${n}`);
  else ok('18-decimal token dry-run: 2000 ticks drain 2.0 cap');
  if (fromAtomic(tick, 18) !== '0.001') fail('fromAtomic 18 dec');
  else ok('fromAtomic/toAtomic round-trip for 18 decimals');
} catch (e) {
  fail(e.message);
}

try {
  const usdcTick = toAtomic('0.001', 6);
  if (usdcTick !== 1000n) fail('USDC 6-dec default broken');
  else ok('USDC 6-decimal default unchanged');
} catch (e) {
  fail(e.message);
}

if (fails.length) {
  console.error('GATE FAILED');
  fails.forEach((f) => console.error(' -', f));
  process.exit(1);
}
console.log('Phase 2 token gate PASSED (unit). Live: see TOKENS_TEST.md');
