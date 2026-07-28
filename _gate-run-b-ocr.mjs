/**
 * GATE — OcrCodeChecker vs the synthetic corpus.
 *
 * Reads every labeled frame the corpus generator produced from the REAL
 * overlay page and platform-grade re-encodes, runs the deterministic checker,
 * and prints the detection-rate table per condition. Assertions encode the
 * floors the mechanic needs:
 *
 *  - present-1080p/720p: ≥90% found (the primary verification resolutions)
 *  - absent: ZERO false positives (a false positive PAYS someone)
 *  - occluded: never found (60% of the matrix is hidden)
 *  - too-small: whatever is read must measure UNDER the pixel floor — the
 *    anti-shrink contract — and must never count as a clean find
 *  - 480p + high-motion: measured and REPORTED, not asserted — their rates
 *    become the documented minimum-quality constraint, not a silent failure
 *
 * Zero external calls. Requires `node _corpus-run-b.mjs` to have run.
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { OcrCodeChecker, fileToGray } from './bounty-ocr.js';
import { bountyConfig } from './bounty-claim.config.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

const OUT = path.resolve('corpus');
if (!existsSync(path.join(OUT, 'labels.json'))) {
  console.error('corpus missing — run: node _corpus-run-b.mjs');
  process.exit(1);
}
const { code, labels } = JSON.parse(readFileSync(path.join(OUT, 'labels.json'), 'utf8'));
const checker = new OcrCodeChecker();

const byCondition = new Map();
for (const l of labels) {
  const frame = fileToGray(path.join(OUT, l.file));
  const res = await checker.check(frame, code);
  if (!byCondition.has(l.condition)) byCondition.set(l.condition, []);
  byCondition.get(l.condition).push({ ...l, ...res });
}

console.log('\n── DETECTION RATES ─────────────────────────────────────────────');
console.log('condition       frames   found   rate    med.conf   med.pxH');
const stats = {};
for (const [cond, rows] of byCondition) {
  const found = rows.filter((r) => r.found).length;
  const med = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)] ?? 0;
  const conf = med(rows.map((r) => r.confidence));
  const pxh = med(rows.map((r) => r.pixelHeight));
  stats[cond] = { n: rows.length, found, rate: found / rows.length, conf, pxh };
  console.log(
    `${cond.padEnd(15)} ${String(rows.length).padStart(5)}   ${String(found).padStart(5)}   `
    + `${(100 * found / rows.length).toFixed(0).padStart(3)}%   ${String(conf).padStart(8)}   ${String(pxh).padStart(7)}`);
}
console.log('────────────────────────────────────────────────────────────────\n');

ok('present-1080p detects ≥90%', stats['present-1080p'].rate >= 0.9,
  `${(stats['present-1080p'].rate * 100).toFixed(0)}%`);
ok('present-720p detects ≥90%', stats['present-720p'].rate >= 0.9,
  `${(stats['present-720p'].rate * 100).toFixed(0)}%`);
ok('ABSENT frames produce ZERO false positives (a false positive pays someone)',
  stats.absent.found === 0, `${stats.absent.found} false positives`);
ok('OCCLUDED (60% hidden) is never read as found', stats.occluded.found === 0,
  `${stats.occluded.found} found`);

const smallRows = byCondition.get('too-small');
const smallFoundClean = smallRows.filter((r) => r.found && r.pixelHeight >= bountyConfig.minCodePixelHeight);
ok('TOO-SMALL never yields a find at/above the pixel floor (anti-shrink holds)',
  smallFoundClean.length === 0,
  `${smallFoundClean.length} clean finds; floor=${bountyConfig.minCodePixelHeight}px, median measured=${stats['too-small'].pxh}px`);
ok('...and measured pixelHeight on legible frames sits ABOVE the floor at 1080p',
  stats['present-1080p'].pxh >= bountyConfig.minCodePixelHeight,
  `${stats['present-1080p'].pxh}px vs floor ${bountyConfig.minCodePixelHeight}px`);

// Reported, not asserted: these two numbers become the documented constraint.
console.log(`  [report] 480p rate: ${(stats['present-480p'].rate * 100).toFixed(0)}% `
  + `(median ${stats['present-480p'].pxh}px vs ${bountyConfig.minCodePixelHeight}px floor)`);
console.log(`  [report] high-motion rate: ${(stats['high-motion'].rate * 100).toFixed(0)}%`);

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
