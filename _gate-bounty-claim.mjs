/**
 * GATE — creator bounty (Run A).
 *
 * Covers every item in the prompt's "verification before you call it done",
 * plus the rule that matters most on a mainnet app: NO REAL SETTLEMENT PATH.
 *
 *  A. Escrow — every illegal transition in the table throws AND writes nothing.
 *  B. Escrow — double release with the same idempotency key releases once.
 *  C. Watermark — codes rotate, expire, and never collide across two
 *     concurrent air sessions.
 *  D. Badge — below threshold stops code rendering and records the violation.
 *  E. Verifier — pass / fail / partial / ambiguous fixtures each produce the
 *     expected verified-minutes and confidence.
 *  F. Refund — an unclaimed handle past expiry refunds contributors in the ledger.
 *  G. Flag off — no routes respond, no surfaces render, existing behavior identical.
 *  H. Source audit — no real settlement/transfer call anywhere in the feature.
 */
import { spawn } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRATCH = `${process.env.TEMP || '/tmp'}/mc-bounty-gate-${Date.now()}`;

// ── A–F: in-process against the real modules ───────────────────────────────
process.env.BOUNTY_CLAIM = '1';
process.env.DATA_DIR = SCRATCH;

const store = await import('./bounty-store.js');
const escrow = await import('./bounty-escrow.js');
const watermark = await import('./bounty-watermark.js');
const verifier = await import('./bounty-verifier.js');
const { StubSettlement } = await import('./bounty-settlement.js');
const { bountyConfig } = await import('./bounty-claim.config.js');
const quietSettlement = new StubSettlement({ log: { log() {} } });

// ── A. every illegal transition throws and writes nothing ──────────────────
{
  escrow.reserve({ platform: 'twitch', handle: 'illegaltest' });
  const key = store.handleKey('twitch', 'illegaltest');
  const states = escrow.STATES;
  let checked = 0, allThrew = true, allClean = true;

  for (const from of states) {
    // Force the record into `from` directly (bypassing the machine) so every
    // origin state can be exercised, including terminals.
    store.updateReservedHandle(key, { claimStatus: from });
    const legal = new Set(escrow.ALLOWED_TRANSITIONS[from] || []);
    for (const to of states) {
      if (legal.has(to)) continue; // legal moves are not this test
      checked++;
      const before = store.listLedger().length;
      let threw = false;
      try {
        escrow.transition({ handleKey: key, to, actor: 'gate' });
      } catch (e) {
        threw = e.code === 'illegal_transition';
      }
      if (!threw) allThrew = false;
      if (store.listLedger().length !== before) allClean = false;
      // state must be untouched
      if (store.getReservedHandleByKey(key).claimStatus !== from) allClean = false;
    }
  }
  ok('A. every illegal transition throws IllegalTransition', allThrew, `${checked} combinations`);
  ok('A. illegal transitions write NOTHING (ledger + state untouched)', allClean);
}

// ── B. double release with the same idempotency key releases once ──────────
{
  escrow.reserve({ platform: 'twitch', handle: 'idemtest' });
  const key = store.handleKey('twitch', 'idemtest');
  escrow.contribute({ platform: 'twitch', handle: 'idemtest', contributor: '0xa', amount: '100' });
  for (const to of ['RESERVED', 'CLAIM_PENDING', 'CLAIM_VERIFIED', 'AWAITING_AIRTIME', 'VERIFYING']) {
    escrow.transition({ handleKey: key, to, actor: 'gate' });
  }
  const r1 = escrow.release({
    handleKey: key, claimId: 'c', airSessionId: 'a', verifiedMinutes: 2,
    confidence: 0.9, idempotencyKey: 'dup-key', settlement: quietSettlement,
  });
  const r2 = escrow.release({
    handleKey: key, claimId: 'c', airSessionId: 'a', verifiedMinutes: 2,
    confidence: 0.9, idempotencyKey: 'dup-key', settlement: quietSettlement,
  });
  const pool = store.getPool(key);
  ok('B. first release pays', r1.released > 0, `${r1.released}`);
  ok('B. replay with the same idempotency key is deduped and pays 0', r2.deduped && !r2.released);
  ok('B. pool reflects exactly ONE release', pool.releasedContributor === r1.released,
    `released=${pool.releasedContributor}`);
  ok('B. platform match is a SEPARATE bucket, never blended',
    pool.releasedPlatformMatch > 0 && pool.releasedPlatformMatch !== pool.releasedContributor,
    `match=${pool.releasedPlatformMatch}`);
}

// ── C. watermark rotation / expiry / no cross-session collision ────────────
{
  store.reserveHandle({ platform: 'twitch', handle: 'wm', ttlMs: 1e9 });
  const claim = store.createClaim({ handleKey: 'twitch:wm', claimant: 'u', ttlMs: 1e9 });
  const s1 = store.createAirSession({ claimId: claim.id, platform: 'twitch' });
  const s2 = store.createAirSession({ claimId: claim.id, platform: 'twitch' });
  const t0 = Date.now();
  const c1 = [], c2 = [];
  for (let i = 0; i < 8; i++) {
    c1.push(watermark.issueCode(s1.id, { now: t0 + i * bountyConfig.codeRotateMs }).code);
    c2.push(watermark.issueCode(s2.id, { now: t0 + i * bountyConfig.codeRotateMs }).code);
  }
  ok('C. codes rotate (all distinct within a session)', new Set(c1).size === c1.length);
  ok('C. NO collision across two concurrent air sessions',
    c1.filter((c) => c2.includes(c)).length === 0);
  ok('C. sessions carry distinct namespaces',
    c1[0].split('-')[0] !== c2[0].split('-')[0], `${c1[0]} vs ${c2[0]}`);
  const active = watermark.activeCode(s1.id, { now: t0 + 7 * bountyConfig.codeRotateMs + 1000 });
  ok('C. the current code is active inside its validity window', !!active);
  const expired = watermark.activeCode(s1.id, { now: t0 + 8 * bountyConfig.codeRotateMs + bountyConfig.codeValidityMs + 5000 });
  ok('C. codes expire once past their validity window', expired === null);

  // ── D. badge below threshold halts codes + records the violation ─────────
  watermark.reportBadgeTooSmall(s1.id, { ratio: 0.005, height: 6 });
  const issued = watermark.issueCode(s1.id, { now: t0 + 9 * bountyConfig.codeRotateMs });
  const after = store.getAirSession(s1.id);
  ok('D. badge too small STOPS code issuance (detection is the payout trigger)', issued === null);
  ok('D. violation recorded as BADGE_TOO_SMALL',
    after.violations.some((v) => v.type === 'BADGE_TOO_SMALL'));
  ok('D. activeCode also withheld while in violation', watermark.activeCode(s1.id) === null);
  watermark.clearBadgeViolation(s1.id);
  ok('D. clearing the violation resumes issuance',
    watermark.issueCode(s1.id, { now: t0 + 10 * bountyConfig.codeRotateMs }) !== null);
}

// ── E. verifier fixtures: pass / fail / partial / ambiguous ────────────────
{
  const mkSession = (minutes) => {
    store.reserveHandle({ platform: 'twitch', handle: 'vf', ttlMs: 1e9 });
    const c = store.createClaim({ handleKey: 'twitch:vf', claimant: 'u', ttlMs: 1e9 });
    const s = store.createAirSession({ claimId: c.id, platform: 'twitch' });
    const t0 = Date.now() - minutes * 60_000;
    store.updateAirSession(s.id, { startedAt: t0, endedAt: t0 + minutes * 60_000 });
    for (let i = 0; i < 10; i++) watermark.issueCode(s.id, { now: t0 + i * 60_000 });
    return s.id;
  };
  const run = async (fixtureFile) => {
    const fx = JSON.parse(readFileSync(`fixtures/${fixtureFile}`, 'utf8'));
    const id = mkSession(10);
    return verifier.verifyAirSession(id, {
      frameSource: new verifier.MockFrameSource(fx),
      codeChecker: new verifier.MockCodeChecker(fx),
    });
  };
  const p = await run('bounty-pass.json');
  ok('E. PASS fixture verifies the full session', p.result === 'PASS' && p.verifiedMinutes === 10,
    `${p.result} ${p.verifiedMinutes}m conf=${p.confidence}`);
  const f = await run('bounty-fail.json');
  ok('E. FAIL fixture verifies zero minutes', f.result === 'FAIL' && f.verifiedMinutes === 0,
    `${f.result} ${f.verifiedMinutes}m`);
  const pa = await run('bounty-partial.json');
  ok('E. PARTIAL fixture is PROPORTIONAL (3/10 samples → ~3 of 10 min)',
    pa.result === 'PARTIAL' && pa.verifiedMinutes > 2.5 && pa.verifiedMinutes < 3.5,
    `${pa.result} ${pa.verifiedMinutes}m`);
  const am = await run('bounty-ambiguous.json');
  ok('E. AMBIGUOUS fixture is distinct from FAIL and under the confidence floor',
    am.result === 'AMBIGUOUS' && am.confidence < bountyConfig.minConfidence,
    `${am.result} conf=${am.confidence}`);
  // and an ambiguous result must not pay
  store.reserveHandle({ platform: 'twitch', handle: 'ambpay', ttlMs: 1e9 });
  const k = store.handleKey('twitch', 'ambpay');
  escrow.contribute({ platform: 'twitch', handle: 'ambpay', contributor: '0x', amount: '50' });
  for (const to of ['RESERVED', 'CLAIM_PENDING', 'CLAIM_VERIFIED', 'AWAITING_AIRTIME', 'VERIFYING']) {
    escrow.transition({ handleKey: k, to, actor: 'gate' });
  }
  const skipped = escrow.release({
    handleKey: k, claimId: 'c', airSessionId: 'a', verifiedMinutes: am.verifiedMinutes,
    confidence: am.confidence, idempotencyKey: 'amb-1', settlement: quietSettlement,
  });
  ok('E. an AMBIGUOUS verification does NOT release funds',
    skipped.released === 0 && skipped.skipped === 'low_confidence');
}

// ── F. refund an unclaimed handle past expiry ──────────────────────────────
{
  escrow.reserve({ platform: 'twitch', handle: 'refundme' });
  const key = store.handleKey('twitch', 'refundme');
  escrow.contribute({ platform: 'twitch', handle: 'refundme', contributor: '0xc1', amount: '25' });
  escrow.contribute({ platform: 'twitch', handle: 'refundme', contributor: '0xc2', amount: '15' });
  const rows = escrow.refundExpired({ handleKey: key, actor: 'gate', settlement: quietSettlement });
  const pool = store.getPool(key);
  const ledger = store.listLedger({ handleKey: key });
  ok('F. every held contribution is refunded in the ledger', rows.length === 2);
  ok('F. refunded total matches contributions', pool.refunded === 40, `${pool.refunded}`);
  ok('F. handle ends REFUNDED', store.getReservedHandleByKey(key).claimStatus === 'REFUNDED');
  ok('F. refund rows carry the contributor for Run B settlement',
    ledger.filter((r) => r.type === 'REFUND').every((r) => r.meta?.contributor));
  // idempotent: refunding twice must not double-refund
  const again = escrow.refundExpired({ handleKey: key, actor: 'gate', settlement: quietSettlement });
  ok('F. refunding again is idempotent (no double refund)',
    store.getPool(key).refunded === 40, `still ${store.getPool(key).refunded}`);
}

// ── H. source audit: no real settlement/transfer anywhere ──────────────────
{
  const files = readdirSync('.').filter((f) => /^bounty-.*\.(js|mjs)$/.test(f));
  const banned = /\b(sendTransaction|writeContract|transferFrom|\.transfer\(|signTransaction|privateKeyToAccount|walletClient)\b/;
  const offenders = files.filter((f) => banned.test(readFileSync(f, 'utf8')));
  ok('H. NO real transfer/settlement call in any bounty module', offenders.length === 0,
    offenders.join(',') || `${files.length} files scanned`);
  const settlementSrc = readFileSync('bounty-settlement.js', 'utf8');
  ok('H. settlement module is stub-only and says so',
    /NO FUNDS MOVE/i.test(settlementSrc) && /TODO\(run-b\)/.test(settlementSrc));
}

console.log(`\n  [server-side subtotal] ${pass} pass, ${fail} fail`);

// ── G. flag OFF: no routes, no surfaces ────────────────────────────────────
const launch = (port, env) => spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(port), DATA_DIR: `${SCRATCH}-http`, ...env },
  stdio: 'ignore', cwd: process.cwd(),
});

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
});

const off = launch(3250, { BOUNTY_CLAIM: '0' });
await sleep(9000);
try {
  const codes = await Promise.all(
    ['/api/bounty/pools', '/api/bounty/config', '/api/bounty/admin/sessions']
      .map((p) => fetch(`http://localhost:3250${p}`).then((r) => r.status).catch(() => 0)),
  );
  ok('G. flag off: every bounty route 404s (nothing mounted)',
    codes.every((c) => c === 404), codes.join(','));
  const health = await fetch('http://localhost:3250/api/health').then((r) => r.status);
  ok('G. flag off: the rest of the app is unaffected', health === 200);

  const page = await browser.newPage();
  await page.goto('http://localhost:3250/bounty', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1200);
  const txt = await page.evaluate(() => document.body.innerText);
  ok('G. flag off: /bounty renders no bounty surface (no board, no claim CTA)',
    !/This is me|Creator bounties waiting|Claim this handle/i.test(txt) && /Not available yet/i.test(txt));
  await page.close();
} finally { off.kill(); }

// flag ON: routes live + page renders the board
const on = launch(3251, { BOUNTY_CLAIM: '1' });
await sleep(9000);
try {
  const cfg = await fetch('http://localhost:3251/api/bounty/config').then((r) => r.json());
  ok('G. flag on: config route reports enabled', cfg.enabled === true);
  await fetch('http://localhost:3251/api/bounty/contribute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'twitch', handle: 'gateshow', contributor: '0x', amount: '80', letterRef: 'L' }),
  });
  const page = await browser.newPage();
  await page.goto('http://localhost:3251/bounty', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  const txt = await page.evaluate(() => document.body.innerText);
  ok('G. flag on: the board renders the real pool', /gateshow/i.test(txt), txt.slice(0, 80).replace(/\n/g, ' '));
  ok('G. flag on: the preview build states no funds move', /no funds move/i.test(txt));
  await page.close();
} finally { on.kill(); }

await browser.close();
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
