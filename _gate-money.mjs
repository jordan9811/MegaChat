/**
 * GATE H — every transfer is accounted for.
 *
 * Until 2026-09-17 "Gate H" scanned the sixteen `bounty-*.js` modules and
 * nothing else, so every "Gate H green" in this project's history meant
 * exactly one thing: the bounty feature is inert. It said nothing about the
 * money that actually moves — the per-tick seat pull, seat and MegaChat
 * refunds, reward payouts, the MPP channel settle, or anything a viewer signs
 * in their own wallet. That assertion still has value and is kept below as
 * the LEGACY section, under its real name.
 *
 * The new Gate H has three tiers, and each tier states what it proves:
 *
 *   TIER 1 — server-side, signed by a key the app holds. PROVES that every
 *            transfer-shaped call in the server modules lives in one file,
 *            settlement.js, and that that file executes only against a
 *            recorded intent, idempotently. Discrimination: a transfer added
 *            to any other module fails the scan; the door refuses a transfer
 *            with no ref.
 *   TIER 2 — autonomous. The MPP SDK settles channels on a schedule it is
 *            handed, with no call site in our source. PROVES only that the
 *            schedule is configured in the one file meant to configure it.
 *            It cannot see the settle happen.
 *   TIER 3 — client-signed and operator-run. PROVES NOTHING ABOUT BEHAVIOUR.
 *            A viewer's session-cap approve, the channel open, a dust-spending
 *            gate's own transfers — none of these pass through a server door,
 *            because the server does not hold the key. What this tier does is
 *            pin the SET of call sites so nobody adds a new one quietly: the
 *            per-file count of transfer-shaped names is diffed against a map
 *            committed here, and a new site — or a new file — fails the gate
 *            until someone updates the pin on purpose.
 *
 * Every discrimination claim below is proven the same way: the scanner is run
 * over a synthetic offender and must fail on it.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { countTier3 } from './_gate-money.pins.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n── Gate H: every transfer is accounted for ─────────────────');

// ── LEGACY: the bounty feature is inert ────────────────────────────────────
{
  const files = readdirSync('.').filter((f) => /^bounty-.*\.(js|mjs)$/.test(f));
  const banned = /\b(sendTransaction|writeContract|transferFrom|\.transfer\(|signTransaction|privateKeyToAccount|walletClient)\b/;
  const offenders = files.filter((f) => banned.test(strip(readFileSync(f, 'utf8'))));
  ok('LEGACY. no transfer-shaped call in any bounty module — the bounty feature is inert',
    offenders.length === 0, offenders.join(',') || `${files.length} modules`);
  const stub = readFileSync('bounty-settlement.js', 'utf8');
  ok('LEGACY. bounty settlement is still the stub, and says so', /NO FUNDS MOVE/i.test(stub) && /TODO\(run-b\)/.test(stub));
}

// ── TIER 1: one door ───────────────────────────────────────────────────────
const TIER1_RE = /\.writeContract\(|\.sendTransaction\(|\.signTransaction\(|\.sendUserOperation\(|session\.settle\(|functionName:\s*['"]transfer(From)?['"]/;
// Session 2: two doors, each accounted for. settlement.js moves platform-wallet
// money against recorded intents; escrow-chain.js moves seat money into and out
// of contracts/MegaChatEscrow.sol against its own ledger. Nothing else may.
const TIER1_ALLOWED = new Set(['settlement.js', 'escrow-chain.js']);
function tier1Offenders(texts) {
  return Object.entries(texts).filter(([name, text]) => !TIER1_ALLOWED.has(name) && TIER1_RE.test(strip(text))).map(([n]) => n);
}
const serverModules = Object.fromEntries(
  readdirSync('.').filter((f) => /^[a-z][a-z0-9-]*\.(js|mjs)$/.test(f) && !f.startsWith('_')).map((f) => [f, readFileSync(f, 'utf8')]),
);
{
  const offenders = tier1Offenders(serverModules);
  ok('T1. every server-side transfer-shaped call lives in settlement.js or escrow-chain.js',
    offenders.length === 0, offenders.join(', ') || `${Object.keys(serverModules).length} modules scanned`);
  const door = strip(serverModules['settlement.js'] || '');
  ok('T1. ...and settlement.js actually contains them (the door is not empty)',
    /\.writeContract\(/.test(door) && /session\.settle\(/.test(door) && /functionName:\s*'transferFrom'/.test(door) && /functionName:\s*'transfer'/.test(door));
  const escrowDoor = strip(serverModules['escrow-chain.js'] || '');
  ok('T1. ...and escrow-chain.js contains the escrow writes, through ONE function, with the fee token explicit',
    (escrowDoor.match(/\.writeContract\(/g) || []).length === 1 && /feeToken: fee/.test(escrowDoor) && /functionName, args, feeToken/.test(escrowDoor));
  ok('T1. server.js itself never signs: it asks a door', !TIER1_RE.test(strip(serverModules['server.js'] || '')));
  // Discrimination: a transfer added anywhere else fails the scan.
  const synthetic = { ...serverModules, 'rooms-store.js': serverModules['rooms-store.js'] + "\nexport async function leak(w){ return w.writeContract({ functionName: 'transfer' }); }\n" };
  ok('T1. DISCRIMINATES: a writeContract added to another module is flagged',
    tier1Offenders(synthetic).includes('rooms-store.js'));
  const comment = { ...serverModules, 'rooms-store.js': serverModules['rooms-store.js'] + "\n// a comment mentioning .writeContract( is not a call\n" };
  ok('T1. ...and a mention inside a comment is not', tier1Offenders(comment).length === 0);
}

// ── TIER 1: the door's own contract, against a fake chain ──────────────────
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-gate-money-'));
const { createSettlement } = await import('./settlement.js');
const TOKEN = { address: '0x20c000000000000000000000b9537d11c60e8b50', decimals: 6, symbol: 'USDC.e' };
const PLATFORM = '0xBda93161Cca91A8e7953Ee5AF8807e9752Fcb55E';
const VIEWER = '0x00000000000000000000000000000000000000a1';
const STREAMER = '0x00000000000000000000000000000000000000b2';

/** A chain that counts. `receiptMode` decides what a receipt lookup answers. */
function fakeChain({ signers = ['pull', 'platform', 'rewardPool'], receiptMode = 'success' } = {}) {
  let seq = 0;
  const chain = {
    transfers: [], pulls: [], settles: [], receiptMode,
    has(slot) { return signers.includes(slot); },
    async transferFrom(a) { chain.pulls.push(a); return `0xpull${++seq}`; },
    async transfer(a) { if (!signers.includes(a.signer)) throw new Error(`no ${a.signer} signer`); chain.transfers.push(a); return `0xsend${++seq}`; },
    async settleChannel(a) { chain.settles.push(a); return `0xsettle${++seq}`; },
    async receipt(txHash) {
      if (chain.receiptMode === 'none') return null;
      if (chain.receiptMode === 'reverted') return { status: 'reverted' };
      return { status: 'success', blockNumber: '1' };
    },
  };
  return chain;
}
const dirFor = (n) => { const d = path.join(SCRATCH, n); return d; };

{
  const chain = fakeChain();
  const door = createSettlement({ dataDir: dirFor('a'), chain, platformAddress: PLATFORM, log: { log() {}, warn() {} } });

  let threw = null;
  try { door.enqueue({ kind: 'release', token: TOKEN, to: STREAMER, amountAtomic: '5' }); } catch (e) { threw = e; }
  ok('T1. the door REFUSES a transfer with no ref — nothing moves without an intent to account for it', !!threw, threw?.message);
  threw = null;
  try { await door.pull({ from: VIEWER, to: PLATFORM, token: TOKEN, amountAtomic: '1' }); } catch (e) { threw = e; }
  ok('T1. ...and a pull with no ref', !!threw);

  const r1 = door.release({ to: STREAMER, amountAtomic: '480000', token: TOKEN, ref: 'seat:s1:sweep:1', bucket: 'streamer' });
  const r2 = door.release({ to: STREAMER, amountAtomic: '480000', token: TOKEN, ref: 'seat:s1:sweep:1', bucket: 'streamer' });
  ok('T1. IDEMPOTENT ON REF: the same intent enqueued twice is one intent', !r1.deduped && r2.deduped && door.pending().length === 1);

  const f1 = await door.flush();
  const f2 = await door.flush();
  ok('T1. RUN TWICE, TRANSFERS ONCE: flush, flush → one on-chain transfer', chain.transfers.length === 1 && f1.sent.length === 1 && f2.sent.length === 0,
    `transfers=${chain.transfers.length}`);
  ok('T1. ...marked DONE by receipt', door.status('seat:s1:sweep:1').status === 'DONE');
  ok("T1. AMOUNTS FROM THE LEDGER: the chain received exactly the intent's amount, not a balance read",
    chain.transfers[0].amountAtomic === 480000n && chain.transfers[0].to === STREAMER);

  const p1 = await door.pull({ from: VIEWER, to: PLATFORM, token: TOKEN, amountAtomic: '1000', ref: 'seat:s1:tick:1' });
  const p2 = await door.pull({ from: VIEWER, to: PLATFORM, token: TOKEN, amountAtomic: '1000', ref: 'seat:s1:tick:1' });
  ok('T1. a tick pull is idempotent on its ref: two calls, one transferFrom', !p1.deduped && p2.deduped && chain.pulls.length === 1);

  const ret = door.release({ to: PLATFORM, amountAtomic: '100', token: TOKEN, ref: 'seat:s2:sweep:1' });
  const ret2 = door.release({ to: null, amountAtomic: '100', token: TOKEN, ref: 'seat:s3:sweep:1' });
  ok('T1. a payee that IS the platform wallet, or no payee, is RETAINED — nothing moves', ret.retained && ret2.retained && (await door.flush()).sent.length === 0);
  const pts = door.refund({ to: VIEWER, amountAtomic: '5', token: { symbol: 'PTS', decimals: 0, address: null }, ref: 'seat:p1:buried:1' });
  ok('T1. E43: an intent in off-chain credit or points (no token address) is RETAINED — the platform wallet holds nothing for it',
    pts.retained && (await door.flush()).sent.length === 0 && door.status('seat:p1:buried:1').status === 'RETAINED');

  const s1 = await door.settleChannel({ channelId: 'ch1', ref: 'channel:ch1:settle', store: {}, walletClient: {}, account: {}, feeToken: TOKEN.address });
  const s2 = await door.settleChannel({ channelId: 'ch1', ref: 'channel:ch1:settle', store: {}, walletClient: {}, account: {}, feeToken: TOKEN.address });
  ok('T1. a channel settle is idempotent on its ref', !s1.deduped && s2.deduped && chain.settles.length === 1);
}

// ── TIER 1: killed mid-run, restarted — REPLAY SAFETY ──────────────────────
{
  const chain = fakeChain({ receiptMode: 'none' }); // the receipt never arrives before the "crash"
  const dir = dirFor('b');
  const door = createSettlement({ dataDir: dir, chain, platformAddress: PLATFORM, log: { log() {}, warn() {} } });
  door.refund({ to: VIEWER, amountAtomic: '320000', token: TOKEN, ref: 'seat:s1:buried:100' });
  const f = await door.flush();
  ok('R. the send goes out and is recorded SENT with its hash', f.sent.length === 1 && door.status('seat:s1:buried:100').status === 'SENT');
  // "Crash": a NEW door over the SAME ledger file, same chain (its receipt now answers).
  chain.receiptMode = 'success';
  const restarted = createSettlement({ dataDir: dir, chain, platformAddress: PLATFORM, log: { log() {}, warn() {} } });
  const f2 = await restarted.flush();
  ok('R. after a restart the SENT intent is reconciled by receipt, NOT re-sent',
    chain.transfers.length === 1 && f2.reconciled === 1 && restarted.status('seat:s1:buried:100').status === 'DONE',
    `transfers=${chain.transfers.length} reconciled=${f2.reconciled}`);
  const f3 = await restarted.flush();
  ok('R. and a further flush moves nothing', f3.sent.length === 0 && chain.transfers.length === 1);

  // A reverted receipt is terminal, never resent.
  const chain2 = fakeChain({ receiptMode: 'reverted' });
  const door2 = createSettlement({ dataDir: dirFor('c'), chain: chain2, platformAddress: PLATFORM, log: { log() {}, warn() {} } });
  door2.refund({ to: VIEWER, amountAtomic: '1', token: TOKEN, ref: 'x:1' });
  await door2.flush(); await door2.flush();
  ok('R. a REVERTED send is FAILED and never retried by automation', door2.status('x:1').status === 'FAILED' && chain2.transfers.length === 1);

  // The ledger is the same append-only primitive as the escrow: a torn last
  // line recovers, an interior gap refuses (bounty-ledger.js, gate J) — so a
  // half-written SENT row cannot be misread as DONE.
  ok('R. the intent ledger is the escrow ledger primitive (seq + checksum chain)',
    readFileSync(path.join(dir, 'settlement.jsonl'), 'utf8').split('\n').filter(Boolean).every((l) => { const r = JSON.parse(l); return typeof r.seq === 'number' && typeof r.sum === 'string'; }));
}

// ── TIER 1: no payout key → PENDING, then the key lands ────────────────────
{
  const dir = dirFor('d');
  const noKey = fakeChain({ signers: ['pull'] });
  const door = createSettlement({ dataDir: dir, chain: noKey, platformAddress: PLATFORM, log: { log() {}, warn() {} } });
  door.release({ to: STREAMER, amountAtomic: '10', token: TOKEN, ref: 'seat:s9:sweep:1' });
  const f = await door.flush();
  ok('K. with no payout signer an intent is recorded and stays PENDING — recorded, not lost',
    f.skipped === 1 && noKey.transfers.length === 0 && door.status('seat:s9:sweep:1').status === 'PENDING');
  const withKey = fakeChain();
  const later = createSettlement({ dataDir: dir, chain: withKey, platformAddress: PLATFORM, log: { log() {}, warn() {} } });
  const f2 = await later.flush();
  ok('K. the first flush after the key lands pays it, once', f2.sent.length === 1 && withKey.transfers.length === 1 && later.status('seat:s9:sweep:1').status === 'DONE');
}

// ── TIER 1: the seat escrow's money reaches the door as intents ────────────
{
  process.env.DATA_DIR = dirFor('e');
  const seat = await import('./seat-escrow.js');
  const chain = fakeChain();
  const door = createSettlement({ dataDir: dirFor('e'), chain, platformAddress: PLATFORM, log: { log() {}, warn() {} } });
  seat.setSettlement(door);
  const t0 = 1_000_000;
  seat.open({ seatId: 'S', roomId: 'R', viewer: VIEWER, streamer: STREAMER, token: TOKEN, at: t0 });
  for (let i = 1; i <= 60; i++) seat.accrue('S', 10_000n, { at: t0 + i * 1000 });
  seat.close('S', { at: t0 + 100_000 });
  // The escrow has no signal for room R, so close() holds (manual-paste rule);
  // sweep it the way the ambient sweeper does at stream end + tail.
  seat.sweepAll({ now: t0 + 100_000 + seat.seatConfig.manualTailMs + 1, streamEndedAt: () => t0 + 100_000 });
  const rec = seat.seatRecord('S');
  const sweep = door.intentsFor('seat:S:sweep');
  ok("E. a seat sweep is an intent at the door for exactly the ledger's released figure",
    sweep.length === 1 && sweep[0].amountAtomic === rec.released.toString() && sweep[0].to === STREAMER,
    `released=${rec.released} intent=${sweep[0]?.amountAtomic}`);
  const f = await door.flush();
  ok('E. ...which the door pays once', f.sent.length === 1 && chain.transfers[0].amountAtomic === rec.released);
  seat.mature('S', { at: t0 + 100_000 + seat.seatConfig.manualTailMs + seat.seatConfig.clawbackWindowMs + 2 });
  const mature = door.intentsFor('seat:S:mature');
  ok("E. the holdback matures as its own intent for the ledger's holdback figure", mature.length === 1 && mature[0].amountAtomic === rec.holdbackOutstanding.toString());
}

// ── TIER 2: the autonomous schedule is configured in one place ─────────────
function tier2Offenders(texts) {
  return Object.entries(texts).filter(([n, t]) => /settlementSchedule\s*:/.test(strip(t)) && n !== 'meter-mpp.js').map(([n]) => n);
}
{
  const here = Object.entries(serverModules).filter(([, t]) => /settlementSchedule\s*:/.test(strip(t))).map(([n]) => n);
  ok('T2. the MPP settlement schedule is configured in exactly one file, meter-mpp.js',
    here.length === 1 && here[0] === 'meter-mpp.js', here.join(', '));
  const synthetic = { ...serverModules, 'letters.js': serverModules['letters.js'] + "\nconst leak = { settlementSchedule: { amount: '1' } };\n" };
  ok('T2. DISCRIMINATES: a schedule configured elsewhere is flagged', tier2Offenders(synthetic).includes('letters.js'));
  ok('T2. what this tier does NOT prove: it cannot see the SDK settle — that is why it exists as a config assertion', true, 'stated in the gate header');
}

// ── TIER 3: client-signed and operator-run sites are PINNED ────────────────
// Update this map on purpose, in the same commit as the change that moves a
// number, by running `node _gate-money.pins.mjs`. A diff here means someone
// added, removed or moved a place that names a signing method.
const PINNED = {
  '_gate-escrow-contract.mjs': 3,   // writeContract ×2 (approve, send), deployContract ×1 (the reentrancy sink) — Moderato only
  '_gate-escrow-seat.mjs': 1,       // the viewer's approve — MAINNET dust, the Session 2 proof
  '_gate-gas-floor.mjs': 2,
  '_gate-guest-whitelist.mjs': 4,
  '_gate-mpp-clientpath.mjs': 9,
  '_gate-pin.mjs': 4,
  '_gate-polish.mjs': 3,
  '_gate-stability.mjs': 4,
  '_verify-join.mjs': 5,
  'scripts/deploy-escrow.mjs': 1,   // deployContract — the escrow's one deploy path
  'scripts/fund-escrow-roles.mjs': 1, // a capped USDC.e transfer to a role wallet for gas, mainnet, flag-guarded
  'scripts/probe-tempo-write.mjs': 1,
  'src/passkey-wallet.mjs': 1,
  'web/lib/join-page.ts': 5,
};
{
  const now = countTier3();
  const diff = [];
  for (const k of new Set([...Object.keys(PINNED), ...Object.keys(now)])) {
    if ((PINNED[k] || 0) !== (now[k] || 0)) diff.push(`${k}: pinned ${PINNED[k] || 0}, now ${now[k] || 0}`);
  }
  ok('T3. the set of client-signed and operator-run call sites matches the pin', diff.length === 0, diff.join(' | ') || `${Object.keys(now).length} files`);
  const synthetic = countTier3({ extraFiles: { 'web/lib/new-page.ts': "const x = await provider.request({ method: 'eth_sendTransaction' });" } });
  ok('T3. DISCRIMINATES: a new file naming a signing method is flagged', !!synthetic['web/lib/new-page.ts']);
  ok('T3. the deleted Arc-era viewer page is gone from the pin, not hidden in it', !('public/index.html' in now) && !('public/passkey-wallet.bundle.js' in now));
  ok('T3. what this tier does NOT prove: anything about behaviour — it pins names, so nobody adds a tenth path quietly', true, 'stated in the gate header');
}

// ── LEGACY PAGE: unreachable in the default configuration ──────────────────
{
  const { startGateServer } = await import('./_gate-helpers.mjs');
  const srv = await startGateServer({ port: 3322, dataDir: dirFor('http'), label: 'money-http', env: { KEEP_ORPHAN_ROOMS: 'true' } });
  try {
    const page = await fetch('http://localhost:3322/index.html');
    const bundle = await fetch('http://localhost:3322/passkey-wallet.bundle.js');
    ok('P. GET /index.html is not served — the Arc-era client-signed deposit page is gone', page.status === 404, `http ${page.status}`);
    ok('P. GET /passkey-wallet.bundle.js is not served — nothing loads the Circle bundler in a browser', bundle.status === 404, `http ${bundle.status}`);
    const join = await fetch('http://localhost:3322/join?room=default');
    ok('P. ...and the join page still answers', join.status === 200, `http ${join.status}`);
  } finally {
    srv.kill();
    // Let the child's handle close before process.exit: exiting on the same
    // tick trips libuv's UV_HANDLE_CLOSING assertion on Windows, after the
    // RESULT line but with a crash exit code.
    await new Promise((r) => setTimeout(r, 1500));
  }
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
