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

/**
 * Comments out, everything else kept — strings included, because a quoted
 * functionName is one of the things Tier 1 looks for. A scanner, not a regex
 * (money-8): the old /\/\*[\s\S]*?\*\// pass did not know about strings, so
 * each '*' + '/' + '*' MIME string in server.js opened a "comment" that
 * swallowed the next route — 66 lines, a writeContract inside them passed.
 * Strings, template literals (with ${} nesting) and regex literals (after an
 * operator or opening bracket) are skipped whole; a block comment becomes
 * blank lines so line numbers survive.
 */
const BS = String.fromCharCode(92);
function strip(src) {
  let out = '', i = 0, prev = '';
  const n = src.length;
  const regexOk = () => prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    if (c === "'" || c === '"') { let j = i + 1; while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === BS ? 2 : 1; out += src.slice(i, j + 1); i = j + 1; prev = c; continue; }
    if (c === '`') {
      let j = i + 1, depth = 0;
      while (j < n) { if (src[j] === BS) { j += 2; continue; } if (depth === 0 && src[j] === '`') break; if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; } if (depth > 0 && src[j] === '}') depth--; j++; }
      out += src.slice(i, j + 1); i = j + 1; prev = '`'; continue;
    }
    if (c === '/' && regexOk()) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') { if (src[j] === BS) { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; }
      while (j + 1 < n && /[a-z]/i.test(src[j + 1])) j++;
      out += src.slice(i, j + 1); i = j + 1; prev = '/'; continue;
    }
    out += c; if (!/\s/.test(c)) prev = c; i++;
  }
  return out;
}

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
// Identifier calls, not only member calls (money-8: 11 of 13 ways to sign or
// send passed the old /\.writeContract\(/-style net): viem/actions' standalone
// writeContract(client, …), a pre-signed sendRawTransaction, a raw
// eth_sendTransaction request, getContract().write.x(), signTypedData for a
// transferWithAuthorization, sendCalls, an mppx settle() imported bare, and a
// money functionName in any quote, backtick included.
const TIER1_RE = new RegExp([
  String.raw`\b(?:writeContract|sendTransaction|sendRawTransaction|signTransaction|signTypedData|sendCalls|deployContract|sendUserOperation)\s*\(`,
  String.raw`\bsettle\s*\(`,
  String.raw`eth_send(?:Raw)?Transaction|eth_sign(?:Transaction|TypedData(?:_v4)?)?\b`,
  String.raw`\.write\.\w+\s*\(`,
  String.raw`functionName\s*:\s*['"\x60](?:transfer|transferFrom|approve|transferWithAuthorization)['"\x60]`,
].join('|'));
// Session 2: two doors, each accounted for. settlement.js moves platform-wallet
// money against recorded intents; escrow-chain.js moves seat money into and out
// of contracts/MegaChatEscrow.sol against its own ledger. Nothing else may.
const TIER1_ALLOWED = new Set(['settlement.js', 'escrow-chain.js']);
// A `settle(` that is not money, by file and purpose. A new one fails until it is named here.
const SETTLE_NOT_MONEY = {
  'livekit-activity.js': "its own settle(roomId, reason): the LiveKit connect/hang-up decision",
  'platform-avatars.js': "its own settle(url): resolves a pending avatar lookup",
};
function tier1Hits(name, text) {
  const s = strip(text);
  if (!TIER1_RE.test(s)) return false;
  if (!SETTLE_NOT_MONEY[name]) return true;
  // Only the file's own settle( is excused; any other hit still counts.
  return TIER1_RE.test(s.replace(/\bsettle\s*\(/g, 'settle_ ('));
}
function tier1Offenders(texts) {
  return Object.entries(texts).filter(([name, text]) => !TIER1_ALLOWED.has(name) && tier1Hits(name, text)).map(([n]) => n);
}
// Every server-side module: the top level plus every server directory. A new
// top-level directory holding code must be classified here first (money-8:
// attestation/ — imported by auth.js and the campaign engine — was in no tier).
const SERVER_DIRS = ['attestation'];
const OTHER_CODE_DIRS = {
  web: 'client (Tier 3)', public: 'client (Tier 3)', src: 'client (Tier 3)',
  scripts: 'operator scripts (Tier 3)', contracts: 'contract tooling (Tier 3)',
  'design-assets': 'design lab scripts, never served', tools: 'tooling, never served',
};
const IGNORED_DIRS = /^(\.|node_modules$|data$|docs$|corpus$|design$|fixtures$|join-fix-evidence$|screens$|dist$)/;
const hasCode = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() ? !/^(node_modules|\.next)$/.test(e.name) && hasCode(path.join(dir, e.name)) : /\.(c?js|mjs)$/.test(e.name)) return true;
  }
  return false;
};
const unclassifiedDirs = readdirSync('.', { withFileTypes: true })
  .filter((e) => e.isDirectory() && !IGNORED_DIRS.test(e.name) && !SERVER_DIRS.includes(e.name) && !OTHER_CODE_DIRS[e.name] && hasCode(e.name))
  .map((e) => e.name);
const serverModules = Object.fromEntries([
  ...readdirSync('.').filter((f) => /^[a-z][a-z0-9-]*\.(js|mjs)$/.test(f) && !f.startsWith('_')),
  ...SERVER_DIRS.flatMap((d) => readdirSync(d).filter((f) => /\.(js|mjs)$/.test(f)).map((f) => `${d}/${f}`)),
].map((f) => [f, readFileSync(f, 'utf8')]));
{
  const offenders = tier1Offenders(serverModules);
  ok('T1. every server-side transfer-shaped call lives in settlement.js or escrow-chain.js',
    offenders.length === 0, offenders.join(', ') || `${Object.keys(serverModules).length} modules scanned, ${SERVER_DIRS.join(', ')} included`);
  ok('T1. every top-level directory holding code is classified (server, client or script)',
    unclassifiedDirs.length === 0, unclassifiedDirs.join(', ') || 'none unclassified');
  const door = strip(serverModules['settlement.js'] || '');
  ok('T1. ...and settlement.js actually contains them (the door is not empty)',
    /\.writeContract\(/.test(door) && /session\.settle\(/.test(door) && /functionName:\s*'transferFrom'/.test(door) && /functionName:\s*'transfer'/.test(door) && /\.signTransaction\(/.test(door));
  const escrowDoor = strip(serverModules['escrow-chain.js'] || '');
  ok('T1. ...and escrow-chain.js signs every escrow write through ONE function, ahead of the send, with the fee token explicit',
    (escrowDoor.match(/\.signTransaction\(/g) || []).length === 1 && (escrowDoor.match(/\.sendRawTransaction\(/g) || []).length === 1
      && !/writeContract\s*\(/.test(escrowDoor) && /feeToken: fee/.test(escrowDoor));
  ok('T1. server.js itself never signs: it asks a door', !TIER1_RE.test(strip(serverModules['server.js'] || '')));
  // Discrimination: a transfer added anywhere else fails the scan.
  const synthetic = { ...serverModules, 'rooms-store.js': serverModules['rooms-store.js'] + "\nexport async function leak(w){ return w.writeContract({ functionName: 'transfer' }); }\n" };
  ok('T1. DISCRIMINATES: a writeContract added to another module is flagged',
    tier1Offenders(synthetic).includes('rooms-store.js'));
  const comment = { ...serverModules, 'rooms-store.js': serverModules['rooms-store.js'] + "\n// a comment mentioning .writeContract( is not a call\n/* nor .sendTransaction( in a block */\n" };
  ok('T1. ...and a mention inside a comment is not', tier1Offenders(comment).length === 0);
  // One synthetic offender per idiom (money/gate-h-probe.mjs): each must be flagged.
  const IDIOMS = {
    'member writeContract': "export async function leak(w){ return w.writeContract({ address: t, abi, functionName: 'transfer', args: [to, 1n] }); }",
    'viem/actions writeContract(client, …)': "import { writeContract } from 'viem/actions';\nexport async function leak(c){ return writeContract(c, { address: t, abi, functionName: 'approve', args: [to, 1n] }); }",
    'viem/actions sendTransaction(client, …)': "import { sendTransaction } from 'viem/actions';\nexport async function leak(c){ return sendTransaction(c, { to, data }); }",
    'signTransaction + sendRawTransaction': "export async function leak(c, a, req){ const raw = await a.signTransaction(req); return c.sendRawTransaction({ serializedTransaction: raw }); }",
    'sendRawTransaction of a tx signed elsewhere': "export async function leak(c, raw){ return c.sendRawTransaction({ serializedTransaction: raw }); }",
    "request({ method: 'eth_sendTransaction' })": "export async function leak(w){ return w.request({ method: 'eth_sendTransaction', params: [{ to, data }] }); }",
    'getContract().write.transfer()': "import { getContract } from 'viem';\nexport async function leak(w){ const c = getContract({ address: t, abi, client: w }); return c.write.transfer([to, 1n]); }",
    'signTypedData (transferWithAuthorization)': "export async function leak(a){ return relay(await a.signTypedData({ domain, types, primaryType: 'TransferWithAuthorization', message })); }",
    "a bound writeContract with functionName 'approve'": "export async function leak(w){ const send = w.writeContract.bind(w); return send({ address: t, abi, functionName: 'approve', args: [to, 1n] }); }",
    'functionName in a template literal': "export async function leak(w, f){ return w[f]({ address: t, abi, functionName: `transfer`, args: [to, 1n] }); }",
    'sendCalls (EIP-5792)': "export async function leak(w){ return w.sendCalls({ calls: [{ to: t, data }] }); }",
    'mppx settle imported bare': "import { settle } from 'mppx/tempo/session/server/Settlement';\nexport async function leak(s, c, id){ return settle(s, c, id, {}); }",
    "a '/*' inside a string ahead of the call": "export const route = '/api/*';\nexport async function leak(w){ return w.writeContract({ address: t, abi, functionName: 'transfer', args: [to, 1n] }); }\n/* a later block comment */",
  };
  const missed = Object.entries(IDIOMS).filter(([, snippet]) => !tier1Offenders({ 'rooms-store.js': `${serverModules['rooms-store.js']}\n${snippet}\n` }).length).map(([k]) => k);
  ok(`T1. DISCRIMINATES: every one of ${Object.keys(IDIOMS).length} signing idioms is flagged in a server module (the old net missed 11)`, missed.length === 0, missed.join(' | ') || 'all flagged');
  ok('T1. DISCRIMINATES: ...in a server SUBDIRECTORY too (attestation/)',
    tier1Offenders({ ...serverModules, 'attestation/x-api.js': `${serverModules['attestation/x-api.js']}\n${IDIOMS['member writeContract']}\n` }).includes('attestation/x-api.js'));
  // The '*' + '/' + '*' strings in server.js: a writeContract placed INSIDE the
  // region the old stripper swallowed (the /api/livekit/webhook route) is flagged.
  const lines = serverModules['server.js'].split('\n');
  const at = lines.findIndex((l) => /app\.post\('\/api\/livekit\/webhook'/.test(l));
  const mime = lines.slice(Math.max(0, at - 5), at + 15).some((l) => l.includes("'*/*'"));
  const planted = [...lines.slice(0, at + 8), "  await sellerWalletClient.writeContract({ functionName: 'transfer' });", ...lines.slice(at + 8)].join('\n');
  ok("T1. DISCRIMINATES: a writeContract planted inside the route after server.js's '*/*' MIME string is flagged (the old stripper swallowed it)",
    at > 0 && mime && tier1Offenders({ 'server.js': planted }).includes('server.js'), at > 0 ? `planted at server.js:${at + 9}` : 'route not found');
  ok('T1. ...and the TIER-1 excuse for a non-money settle( covers only that file\'s own settle',
    tier1Offenders({ 'livekit-activity.js': `${serverModules['livekit-activity.js']}\n${IDIOMS['member writeContract']}\n` }).includes('livekit-activity.js')
      && tier1Offenders({ 'livekit-activity.js': serverModules['livekit-activity.js'] }).length === 0);
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

const quiet = { log() {}, warn() {}, error() {} };
const sumOf = (recs) => recs.reduce((a, r) => a + BigInt(r.amountAtomic), 0n);

// ── E2: a hide/show toggle refunds each tick ONCE (money-2) ────────────────
// The owner of a room (a room password is enough) posts transitions; the
// buried-seconds refund used to re-count every tick in the 30 s detection lag
// on every flip, out of the platform wallet. The meter is modelled as the
// server runs it: an MPP (platform-mode) seat keeps accruing while PAUSED, an
// escrow passkey seat's meter skips hidden ticks.
{ try {
  const seat = await import('./seat-escrow.js');
  const run = (mode, periodMs) => {
    const door = createSettlement({ dataDir: dirFor(`e2-${mode}-${periodMs}`), chain: fakeChain(), platformAddress: PLATFORM, log: quiet });
    seat.setSettlement(door);
    const id = `T-${mode}-${periodMs}`, room = `RT-${mode}-${periodMs}`;
    const t0 = 50_000_000 + periodMs * 1000 + (mode === 'escrow' ? 7_000_000 : 0);
    seat.open({ seatId: id, roomId: room, viewer: VIEWER, streamer: STREAMER, token: TOKEN, tickMs: 1000, mode, at: t0 });
    let paid = 0n, hidden = false, next = t0 + 60_000;
    for (let ms = 1000; ms <= 120_000; ms += 100) {
      const at = t0 + ms;
      if (at >= next && at < t0 + 120_000) { hidden = !hidden; seat.onVisibility(room, hidden ? 'overlay_hidden' : 'overlay_visible', { at }); next += periodMs; }
      if (ms % 1000 === 0 && (mode === 'platform' || !hidden)) { seat.accrue(id, 1000n, { at: at + 1 }); paid += 1000n; }
    }
    if (hidden) seat.onVisibility(room, 'overlay_visible', { at: t0 + 120_500 });
    const rec = seat.seatRecord(id);
    // Discrimination figure: the same windows, each tick counted at most once.
    const once = new Set();
    for (const p of rec.pauses) for (const t of rec.ticks) if (t.at >= p.from - seat.seatConfig.detectionLagMs && t.at <= (p.to ?? Infinity)) once.add(t.at);
    return { paid, door: sumOf(door.intentsFor(`seat:${id}:buried`)), lifetime: rec.refundedFromStreamer + rec.refundedFromPlatform, once: BigInt(once.size) * 1000n };
  };
  const p1 = run('platform', 1000), e1 = run('escrow', 1000), p2 = run('platform', 200), e2 = run('escrow', 200);
  ok('E2. HIDE/SHOW EVERY SECOND, PLATFORM MODE: the door refunds each tick once — 89000, not 930000 (7.75x what the viewer paid)',
    p1.door === 89_000n && p1.door === p1.once, `paid ${p1.paid}, door ${p1.door}, once-only ${p1.once}`);
  ok('E2. ...ESCROW MODE: the platform pays the lag once — 59000, not 570000',
    e1.door === 59_000n && e1.door === e1.once, `paid ${e1.paid}, door ${e1.door}`);
  ok('E2. ...toggling every 200 ms is no worse: the once-only figure in both modes',
    p2.door === p2.once && e2.door === e2.once, `platform ${p2.door}/${p2.once}, escrow ${e2.door}/${e2.once}`);
  ok('E2. a seat\'s lifetime refunds never exceed what it paid',
    [p1, e1, p2, e2].every((r) => r.lifetime <= r.paid), [p1, e1, p2, e2].map((r) => `${r.lifetime}/${r.paid}`).join(' '));
  // A single pause is refunded exactly as before (the _gate-meter-pause shape).
  const door = createSettlement({ dataDir: dirFor('e2-single'), chain: fakeChain(), platformAddress: PLATFORM, log: quiet });
  seat.setSettlement(door);
  const t0 = 90_000_000;
  seat.open({ seatId: 'T-single', roomId: 'RT-single', viewer: VIEWER, streamer: STREAMER, token: TOKEN, at: t0 });
  for (let s = 1; s <= 60; s++) seat.accrue('T-single', 1000n, { at: t0 + s * 1000 });
  seat.onVisibility('RT-single', 'overlay_hidden', { at: t0 + 40_500 });
  seat.onVisibility('RT-single', 'overlay_visible', { at: t0 + 50_500 });
  ok('E2. a single pause still refunds the lag and the buried ticks (30 + 10 ticks)', sumOf(door.intentsFor('seat:T-single:buried')) === 40_000n, String(sumOf(door.intentsFor('seat:T-single:buried'))));
  // A door that REFUSES (a latched ledger) must not lose the obligation, nor
  // stop the seat's own flow: the seat closes, and the next door installed
  // (boot) is handed the same intent, by the same ref, once.
  const refusing = { refund() { throw Object.assign(new Error('settlement door halted'), { code: 'money_halted' }); }, release() { throw Object.assign(new Error('settlement door halted'), { code: 'money_halted' }); }, status: () => null };
  seat.setSettlement(refusing);
  const t1 = 95_000_000;
  seat.open({ seatId: 'T-refused', roomId: 'RT-refused', viewer: VIEWER, streamer: STREAMER, token: TOKEN, at: t1 });
  for (let s = 1; s <= 20; s++) seat.accrue('T-refused', 1000n, { at: t1 + s * 1000 });
  let threw = null;
  try {
    seat.onVisibility('RT-refused', 'overlay_hidden', { at: t1 + 10_500 });
    seat.close('T-refused', { at: t1 + 20_500 });
  } catch (e) { threw = e; }
  const healed = createSettlement({ dataDir: dirFor('e2-healed'), chain: fakeChain(), platformAddress: PLATFORM, log: quiet });
  seat.setSettlement(healed);
  const again = createSettlement({ dataDir: dirFor('e2-healed'), chain: fakeChain(), platformAddress: PLATFORM, log: quiet });
  seat.setSettlement(again);
  const refunds = again.intentsFor('seat:T-refused:buried');
  ok('E2. a REFUSING door does not lose the refund or stop the seat: it closes, and the next door is handed the same intent once (it threw out of close())',
    !threw && seat.seatRecord('T-refused').state !== 'OPEN' && seat.seatRecord('T-refused').state !== 'PAUSED' && refunds.length === 1 && refunds[0].amountAtomic === '20000',
    threw ? threw.message : `${seat.seatRecord('T-refused').state}; ${refunds.map((r) => `${r.ref.split(':').pop()}=${r.amountAtomic}`).join(' ')}`);
} catch (e) { ok(`E2. the section ran to the end (it crashed: ${e.message})`, false); } }

// ── F: the folds advance by the new rows only (stores-4) ───────────────────
{ try {
  const seat = await import('./seat-escrow.js');
  const { checksum } = await import('./bounty-ledger.js');
  const { writeFileSync, appendFileSync } = await import('fs');
  const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x === -Infinity ? '-inf' : x));
  // Equivalence: what the incremental view holds equals a full re-fold of the same file.
  const before = show(seat.listSeats());
  seat.verifySeatLedgerIntegrity(); // reloads the ledger: the next read folds every row from scratch
  ok('F. the incremental seat view equals a full re-fold of the same ledger', show(seat.listSeats()) === before, `${seat.listSeats().length} seats`);
  // Cost: 30k ACCRUE rows (written with the real checksum, no 30k fsyncs),
  // then 500 reads. A re-fold per read walked all 30k rows each time.
  const seatFile = path.join(dirFor('e'), 'seat-ledger.jsonl');
  const have = readFileSync(seatFile, 'utf8').trim().split('\n').length;
  const lines = [];
  const rec = (r, seq) => { const row = { ...r, seq }; return JSON.stringify({ ...row, sum: checksum(row) }); };
  lines.push(rec({ type: 'SEAT_OPEN', seatId: 'BULK', roomId: 'R-bulk', viewer: VIEWER, streamer: STREAMER, token: TOKEN, tickMs: 1000, mode: 'platform', fromState: null, toState: 'OPEN', idempotencyKey: 'seat:open:BULK', at: 1 }, have + 1));
  for (let i = 0; i < 30_000; i++) lines.push(rec({ type: 'SEAT_ACCRUE', amount: '1000', seatId: 'BULK', fromState: null, toState: null, idempotencyKey: `seat:accrue:BULK:${i + 2}`, at: i + 2 }, have + 2 + i));
  appendFileSync(seatFile, lines.join('\n') + '\n');
  seat.verifySeatLedgerIntegrity();
  seat.seatRecord('BULK'); // the one full fold
  let t = performance.now();
  for (let i = 0; i < 500; i++) seat.seatRecord('BULK');
  const seatMs = performance.now() - t;
  ok('F. 500 seat reads over a 30k-row ledger take under 250 ms (a full fold per read took seconds)', seatMs < 250 && seat.seatRecord('BULK').accrued === 30_000_000n, `${seatMs.toFixed(1)} ms`);
  const doorDir = dirFor('f-door');
  const { mkdirSync } = await import('fs');
  mkdirSync(doorDir, { recursive: true });
  const dl = [];
  for (let i = 0; i < 30_000; i++) {
    const row = { type: 'PULL', ref: `seat:BULK:tick:${i}`, signer: 'pull', from: VIEWER, to: PLATFORM, token: TOKEN, amountAtomic: '1000', txHash: null, dry: true, meta: null, at: i, seq: i + 1 };
    dl.push(JSON.stringify({ ...row, sum: checksum(row) }));
  }
  writeFileSync(path.join(doorDir, 'settlement.jsonl'), dl.join('\n') + '\n');
  const bulkDoor = createSettlement({ dataDir: doorDir, chain: fakeChain(), platformAddress: PLATFORM, log: quiet });
  bulkDoor.status('seat:BULK:tick:0');
  t = performance.now();
  for (let i = 0; i < 500; i++) bulkDoor.status(`seat:BULK:tick:${i}`);
  const doorMs = performance.now() - t;
  ok('F. 500 door status() reads over a 30k-row ledger take under 250 ms', doorMs < 250, `${doorMs.toFixed(1)} ms`);
  bulkDoor.refund({ to: VIEWER, amountAtomic: '7', token: TOKEN, ref: 'f:new' });
  const fresh = createSettlement({ dataDir: doorDir, chain: fakeChain(), platformAddress: PLATFORM, log: quiet });
  ok('F. the incremental door view equals a fresh door\'s full fold of the same file', show(bulkDoor.all()) === show(fresh.all()) && bulkDoor.status('f:new').status === 'PENDING');
} catch (e) { ok(`F. the section ran to the end (it crashed: ${e.message})`, false); } }

// ── K2/K3: one signer's backlog never holds another's payout back (money-10, N2) ──
{ try {
  const PAST = 1_700_000_000_000;
  const realNow = Date.now;
  const seed = (door, n) => { let clock = PAST; Date.now = () => clock++; try { for (let i = 0; i < n; i++) door.release({ signer: 'rewardPool', to: `0x${(i + 1).toString(16).padStart(40, '0')}`, amountAtomic: '100000', token: TOKEN, ref: `reward:r:${i}` }); } finally { Date.now = realNow; } };
  const k2chain = fakeChain({ signers: ['pull', 'platform'] }); // no reward-pool key
  const k2 = createSettlement({ dataDir: dirFor('k2'), chain: k2chain, platformAddress: PLATFORM, log: quiet });
  seed(k2, 50);
  k2.refund({ to: VIEWER, amountAtomic: '320000', token: TOKEN, ref: 'seat:K2:unused-refund' });
  const f2 = await k2.flush();
  ok('K2. 50 older reward intents with NO pool key: the platform refund still leaves on the FIRST flush (it waited forever)',
    f2.sent.includes('seat:K2:unused-refund') && k2.status('seat:K2:unused-refund').status === 'DONE' && f2.skipped === 50, `sent ${f2.sent.length}, skipped ${f2.skipped}`);
  const k3chain = fakeChain();
  k3chain.transfer = async (a) => { if (a.signer === 'rewardPool') throw new Error('insufficient funds for transfer'); k3chain.transfers.push(a); return `0xok${k3chain.transfers.length}`; };
  const k3 = createSettlement({ dataDir: dirFor('k3'), chain: k3chain, platformAddress: PLATFORM, log: quiet });
  seed(k3, 600);
  k3.refund({ to: VIEWER, amountAtomic: '320000', token: TOKEN, ref: 'seat:K3:unused-refund' });
  const f3 = await k3.flush();
  ok('K3. 600 older reward intents that FAIL: the refund is sent on the first flush, second in line (it waited 13 flushes)',
    k3.status('seat:K3:unused-refund').status === 'DONE' && f3.sent.indexOf('seat:K3:unused-refund') <= 1, `refund at position ${f3.sent.indexOf('seat:K3:unused-refund')}, ${f3.failed.length} failed`);
  ok('K3. ...and each signer still takes at most `max` a flush', f3.failed.length === 50, `${f3.failed.length} reward sends tried`);
} catch (e) { ok(`K2/K3. the section ran to the end (it crashed: ${e.message})`, false); } }

// ── L: a damaged money ledger LATCHES; it never serves an empty view (verify-1, D4) ──
{ try {
  const { createLedger, ledgerHealth, corruptMoneyLedger, checksum, checksumV2 } = await import('./bounty-ledger.js');
  const fs = await import('fs');
  const dir = dirFor('l');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'x.jsonl');
  const L1 = createLedger({ filePath: file, log: quiet, kind: 'test' });
  for (let i = 0; i < 3; i++) L1.append({ type: 't', at: 1000 + i });
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"at":1001', '"at":1009'));
  const bytes = fs.readFileSync(file, 'utf8');
  const L2 = createLedger({ filePath: file, log: quiet, kind: 'test' });
  const codes = [];
  for (const op of [() => L2.all(), () => L2.all(), () => L2.append({ type: 't', at: 2000 })]) { try { op(); codes.push('ok'); } catch (e) { codes.push(e.code); } }
  ok('L. an interior-damaged ledger refuses EVERY read and append, not just the first (it served [] and wrote seq 1)',
    codes.every((c) => c === 'ledger_corrupt') && fs.readFileSync(file, 'utf8') === bytes, codes.join(','));

} catch (e) { ok(`L. the latch part ran to the end (it crashed: ${e.message})`, false); } }
{ try {
  const { createLedger, ledgerHealth, corruptMoneyLedger, checksum, checksumV2 } = await import('./bounty-ledger.js');
  const fs = await import('fs');
  const dir = dirFor('l');
  fs.mkdirSync(dir, { recursive: true });
  // The door over a damaged ledger: a paid ref is never paid again (settlement-latch.mjs).
  const ddir = dirFor('l-door');
  const chain = fakeChain();
  let door = createSettlement({ dataDir: ddir, chain, platformAddress: PLATFORM, log: quiet });
  const args = { to: STREAMER, amountAtomic: '1000000', ref: 'seat:s1:sweep:1', token: TOKEN };
  door.release(args); await door.flush();
  door.release({ ...args, ref: 'seat:s2:sweep:1' }); await door.flush();
  const dfile = path.join(ddir, 'settlement.jsonl');
  const dl = fs.readFileSync(dfile, 'utf8').split('\n');
  dl[3] = dl[3].replace('"amountAtomic":"1000000"', '"amountAtomic":"1000001"');
  fs.writeFileSync(dfile, dl.join('\n'));
  const logged = [];
  door = createSettlement({ dataDir: ddir, chain, platformAddress: PLATFORM, log: { log() {}, warn() {}, error: (m) => logged.push(m) } });
  const results = [];
  for (let i = 0; i < 2; i++) { try { door.release(args); results.push('accepted'); } catch (e) { results.push(e.code); } }
  const fl = await door.flush();
  ok('L. DOOR: after the damage, release() refuses every time and the paid ref is NOT paid again — 2 transfers stay 2 (they became 3)',
    results.every((r) => r === 'ledger_corrupt') && chain.transfers.length === 2 && !!fl.halted, `${results.join(',')}; transfers ${chain.transfers.length}; flush ${fl.halted ? 'halted' : 'ran'}`);
  ok('L. ...the latch is logged ONCE, and /api/health\'s ledger list names it',
    logged.filter((m) => /LATCHED CORRUPT/.test(m)).length === 1 && ledgerHealth().some((h) => h.kind === 'settlement' && h.ok === false && h.corruptAtLine === 4),
    `${logged.length} log line(s)`);
  let pullErr = null;
  try { await door.pull({ from: VIEWER, to: PLATFORM, token: TOKEN, amountAtomic: '1', ref: 'l:tick' }); } catch (e) { pullErr = e; }
  ok('L. ...and a pull is refused before anything is signed (preSend)', pullErr?.preSend === true && chain.pulls.length === 0, pullErr?.code || pullErr?.message);

} catch (e) { ok(`L. the door part ran to the end (it crashed: ${e.message})`, false); } }
{ try {
  const { createLedger, ledgerHealth, corruptMoneyLedger, checksum, checksumV2 } = await import('./bounty-ledger.js');
  const fs = await import('fs');
  const dir = dirFor('l');
  fs.mkdirSync(dir, { recursive: true });
  // A damaged SEAT ledger beside a healthy door stops the door too: its
  // refunds and sweeps are computed from that ledger. Scoped to the directory.
  const sdir = dirFor('l-seat');
  const SL = createLedger({ filePath: path.join(sdir, 'seat-ledger.jsonl'), kind: 'seat-ledger', log: quiet });
  SL.append({ type: 'SEAT_OPEN', seatId: 'x', at: 1 }); SL.append({ type: 'SEAT_ACCRUE', seatId: 'x', amount: '5', at: 2 });
  fs.writeFileSync(path.join(sdir, 'seat-ledger.jsonl'), fs.readFileSync(path.join(sdir, 'seat-ledger.jsonl'), 'utf8').replace('"amount":"5"', '"amount":"6"'));
  const fresh = createLedger({ filePath: path.join(sdir, 'seat-ledger.jsonl'), kind: 'seat-ledger', log: quiet });
  try { fresh.load(); } catch { /* latched */ }
  const sideChain = fakeChain();
  const side = createSettlement({ dataDir: sdir, chain: sideChain, platformAddress: PLATFORM, log: quiet });
  side.refund({ to: VIEWER, amountAtomic: '9', token: TOKEN, ref: 'l:side' });
  const fs2 = await side.flush();
  const other = createSettlement({ dataDir: dirFor('l-other'), chain: fakeChain(), platformAddress: PLATFORM, log: quiet });
  other.refund({ to: VIEWER, amountAtomic: '9', token: TOKEN, ref: 'l:other' });
  const fo = await other.flush();
  ok('L. a latched SEAT ledger halts the door in the SAME data directory (recorded intents wait), and no other',
    !!fs2.halted && sideChain.transfers.length === 0 && side.status('l:side').status === 'PENDING' && fo.sent.length === 1 && !!corruptMoneyLedger(sdir) && !corruptMoneyLedger(dirFor('l-other')));

} catch (e) { ok(`L. the seat-halt part ran to the end (it crashed: ${e.message})`, false); } }
{ try {
  const { createLedger, ledgerHealth, corruptMoneyLedger, checksum, checksumV2 } = await import('./bounty-ledger.js');
  const fs = await import('fs');
  const dir = dirFor('l');
  fs.mkdirSync(dir, { recursive: true });
  // The seat module itself: setSettlement (boot) verifies its ledger, latches, does not throw.
  const seat = await import('./seat-escrow.js');
  const seatFile = path.join(dirFor('e'), 'seat-ledger.jsonl');
  const good = fs.readFileSync(seatFile, 'utf8');
  const sl = good.split('\n');
  sl[2] = sl[2].replace(/"at":([0-9]+)/, (_m, d) => `"at":${Number(d) + 1}`);
  fs.writeFileSync(seatFile, sl.join('\n'));
  let threw = false;
  try { seat.setSettlement(createSettlement({ dataDir: dirFor('l-boot'), chain: fakeChain(), platformAddress: PLATFORM, log: quiet })); } catch { threw = true; }
  const v = seat.verifySeatLedgerIntegrity();
  ok('L. BOOT: installing the door verifies the seat ledger — damage latches and is reported, boot does not stop',
    !threw && v.ok === false && ledgerHealth().some((h) => h.kind === 'seat-ledger' && !h.ok), v.error?.slice(0, 60));
  let readErr = null;
  try { seat.seatRecord('S'); } catch (e) { readErr = e.code; }
  fs.writeFileSync(seatFile, good);
  const v2 = seat.verifySeatLedgerIntegrity();
  ok('L. ...every seat read throws while latched, and a repaired file clears it', readErr === 'ledger_corrupt' && v2.ok === true && seat.seatRecord('S') !== null);

} catch (e) { ok(`L. the seat-boot part ran to the end (it crashed: ${e.message})`, false); } }
{ try {
  const { createLedger, ledgerHealth, corruptMoneyLedger, checksum, checksumV2 } = await import('./bounty-ledger.js');
  const fs = await import('fs');
  const dir = dirFor('l');
  fs.mkdirSync(dir, { recursive: true });
  // A short write is cut back: the file is exactly as long as before, nothing recorded.
  const wfile = path.join(dir, 'short.jsonl');
  const W = createLedger({ filePath: wfile, log: quiet, kind: 'test' });
  W.append({ type: 'a' });
  const len = fs.statSync(wfile).size;
  const realWrite = fs.default.writeSync;
  fs.default.writeSync = (fd, buf) => realWrite(fd, buf.subarray(0, Math.floor(buf.length / 2)));
  let shortErr = null;
  try { W.append({ type: 'b' }); } catch (e) { shortErr = e.code; } finally { fs.default.writeSync = realWrite; }
  const after = W.append({ type: 'c' });
  ok('L. a SHORT write throws, the file is cut back to its old length, and the next row is seq 2 on a clean file',
    shortErr === 'ledger_write_failed' && after.seq === 2 && createLedger({ filePath: wfile, log: quiet }).all().length === 2, `${shortErr}; ${len} bytes before`);

} catch (e) { ok(`L. the short-write part ran to the end (it crashed: ${e.message})`, false); } }
{ try {
  const { createLedger, ledgerHealth, corruptMoneyLedger, checksum, checksumV2 } = await import('./bounty-ledger.js');
  const fs = await import('fs');
  const dir = dirFor('l');
  fs.mkdirSync(dir, { recursive: true });
  // stores-5 READER: v1 rows and v2 rows both verify; v2 covers nested fields.
  const vfile = path.join(dir, 'v2.jsonl');
  const tok = { address: '0x' + 'a'.repeat(40), decimals: 6, symbol: 'USDC.e' };
  const V = createLedger({ filePath: vfile, log: quiet, kind: 'test' });
  for (let i = 0; i < 50; i++) V.append({ type: 'INTENT', ref: `r${i}`, token: tok, amountAtomic: String(1000 + i), meta: { n: i }, at: i });
  const legacy = fs.readFileSync(vfile, 'utf8');
  const v2row = (extra = {}) => { const r = { type: 'INTENT', ref: 'r50', token: tok, amountAtomic: '1', at: 50, seq: 51, sumV: 2, ...extra }; return { ...r, sum: checksumV2(r) }; };
  const loads = (text) => { fs.writeFileSync(vfile, text); try { return createLedger({ filePath: vfile, log: quiet, kind: 'test' }).all().length; } catch (e) { return e.code; } };
  const row = v2row();
  ok('L. checksum v2 READER: all 50 legacy v1 rows load, and a v2 row after them loads too', loads(legacy) === 50 && loads(legacy + JSON.stringify(row) + '\n') === 51);
  const tampered = { ...row, token: { ...tok, address: '0x' + 'e'.repeat(40) } };
  ok('L. ...a NESTED edit (the token the door pays in) is refused under v2, where the v1 rule cannot see it',
    loads(legacy + JSON.stringify(tampered) + '\nX') === 'ledger_corrupt' && checksum({ ...tampered }) === checksum({ ...row }));
  const { sumV, ...stripped } = row;
  ok('L. ...a stripped or unknown version marker is refused, and a v1 row after a v2 row is refused',
    loads(legacy + JSON.stringify(stripped) + '\nX') === 'ledger_corrupt' && loads(legacy + JSON.stringify({ ...row, sumV: 3 }) + '\nX') === 'ledger_corrupt'
      && loads(legacy + JSON.stringify(row) + '\n' + (() => { const r = { type: 't', seq: 52, at: 1 }; return JSON.stringify({ ...r, sum: checksum(r) }); })() + '\nX') === 'ledger_corrupt');
  ok('L. ...and this build still WRITES v1 (the writer flips one deploy later)', !JSON.parse(legacy.trim().split('\n').pop()).sumV);
} catch (e) { ok(`L. the v2-reader part ran to the end (it crashed: ${e.message})`, false); } }

// ── V: the meter cannot see the overlay — it does not charge (D4, stores-3) ──
{ try {
  const { createLedger } = await import('./bounty-ledger.js');
  const fs = await import('fs');
  const seat = await import('./seat-escrow.js');
  // D4 meter half: a damaged VISIBILITY chain means the meter cannot see the
  // overlay — it does not charge, does not throw (one bad chain aborted the
  // tick for every seat after it), and the seat holds rather than releases.
  const ov = await import('./overlay-visibility.js');
  const vfile = path.join(dirFor('e'), 'overlay-visibility.jsonl');
  const VL = createLedger({ filePath: vfile, kind: 'overlay-visibility', log: quiet });
  VL.append({ type: 'overlay_visibility', roomId: 'R-vis', signal: 'overlay_visible', sessionKey: null, at: 1 });
  VL.append({ type: 'overlay_visibility', roomId: 'R-vis', signal: 'overlay_visible', sessionKey: null, at: 2 });
  VL.append({ type: 'overlay_visibility', roomId: 'R-vis', signal: 'overlay_hidden', sessionKey: null, at: 3 });
  fs.writeFileSync(vfile, fs.readFileSync(vfile, 'utf8').replace('"at":2', '"at":7'));
  ov._resetForTests();
  const seen = [];
  const realError = console.error;
  console.error = (m) => seen.push(String(m));
  let charge = null, threw = null, signalled = null;
  try {
    for (let i = 0; i < 5; i++) charge = seat.shouldCharge('R-vis');
    signalled = seat.isSignalled('R-vis');
  } catch (e) { threw = e; } finally { console.error = realError; }
  ok('V. D4: over a DAMAGED visibility chain the meter charges NO tick and never throws; the damage is logged once',
    charge === false && !threw && signalled === false && seen.filter((m) => /LATCHED CORRUPT/.test(m)).length === 1, threw ? threw.code : `${seen.length} error line(s)`);
  fs.rmSync(vfile, { force: true });
  ov._resetForTests();
  ok('V. ...while NO visibility signal at all (a manual-paste room) still charges', seat.shouldCharge('R-novis') === true);
} catch (e) { ok(`V. the section ran to the end (it crashed: ${e.message})`, false); } }

// ── R5–R7, N1: the real adapter against a node stand-in (money-3, -6, -7) ──
// viem's Tempo chain, a key generated for this run, a JSON-RPC stand-in on
// 127.0.0.1: no network, no funds.
{ try {
  const viem = await import('viem');
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
  const { tempo } = await import('viem/chains');
  const { viemChainAdapter, NONCE_FLOOR_TTL_MS } = await import('./settlement.js');
  const { startRpcStandIn, block, receipt, tx, hex } = await import('./_gate-rpc-standin.mjs');
  const { deserialize } = await import('./node_modules/viem/_esm/tempo/Transaction.js');
  const USDC = TOKEN.address;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nonceOf = (raw) => Number(deserialize(raw).nonce ?? 0);
  // A node: accepted transactions by hash, and what each one does.
  function node({ onSend = null, mine = true, estimateMs = 0 } = {}) {
    const st = { head: 1000, mined: 0, held: new Map(), sends: 0 };
    st.handlers = {
      eth_chainId: () => hex(tempo.id),
      eth_blockNumber: () => hex(++st.head),
      eth_getBlockByNumber: ([n]) => block(n === 'latest' || n === 'pending' ? st.head : Number(BigInt(n))),
      eth_getTransactionCount: ([, tag]) => hex(tag === 'latest' ? st.mined : st.mined + st.held.size),
      eth_maxPriorityFeePerGas: () => '0x0',
      eth_gasPrice: () => hex(1_000_000_000n),
      eth_estimateGas: async () => { if (estimateMs) await sleep(estimateMs); return hex(60_000); },
      eth_sendRawTransaction: async ([raw]) => {
        st.sends += 1;
        const h = viem.keccak256(raw), n = nonceOf(raw);
        if ([...st.held.values()].some((x) => x.nonce === n)) throw { rpcError: { code: -32000, message: `nonce ${n} already used` } };
        st.held.set(h, { nonce: n, raw });
        if (onSend) await onSend(h, st);
        return h;
      },
      eth_getTransactionReceipt: ([h]) => (mine && st.held.has(h) ? receipt(h, st.head, '0x0', USDC) : null),
      eth_getTransactionByHash: () => null,
    };
    return st;
  }
  const account = privateKeyToAccount(generatePrivateKey());
  const clients = (url) => ({
    wallet: () => viem.createWalletClient({ account, chain: { ...tempo, rpcUrls: { default: { http: [url] } } }, transport: viem.http(url) }),
    pub: viem.createPublicClient({ chain: tempo, transport: viem.http(url), pollingInterval: 100 }),
  });
  const refund = (door, ref) => door.refund({ to: VIEWER, amountAtomic: '320000', token: TOKEN, ref });

  // R5a: the node takes the transfer and the answer is lost (a 504).
  {
    const st = node({ onSend: () => { throw { httpStatus: 504 }; } });
    const rpc = await startRpcStandIn(st.handlers);
    const c = clients(rpc.url), dir = dirFor('r5a');
    const mk = (ms) => createSettlement({ dataDir: dir, chain: viemChainAdapter({ platform: c.wallet(), publicClient: c.pub, receiptTimeoutMs: ms }), platformAddress: PLATFORM, log: quiet });
    const d1 = mk(1500);
    refund(d1, 'seat:R5:unused-refund');
    await d1.flush();
    const after1 = d1.status('seat:R5:unused-refund');
    const d2 = mk(1500); // the next process
    await d2.flush();
    ok('R5. LOST ANSWER: the hash is on the ledger BEFORE the send, so the transfer stays SENT (it was recorded FAILED for money that moved)',
      after1.status === 'SENT' && after1.signedAhead === true && st.held.has(after1.txHash), `${after1.status} ${after1.txHash?.slice(0, 10)}`);
    ok('R5. ...after a restart its receipt makes it DONE, and the node saw ONE transfer', d2.status('seat:R5:unused-refund').status === 'DONE' && st.sends === 1, `sends ${st.sends}`);
    await rpc.close();
  }
  // R5b: the process dies while the send is in flight (a redeploy).
  {
    const st = node({ onSend: (h, s) => (s.sends === 1 ? new Promise(() => {}) : null) });
    const rpc = await startRpcStandIn(st.handlers);
    const c = clients(rpc.url), dir = dirFor('r5b');
    const mk = () => createSettlement({ dataDir: dir, chain: viemChainAdapter({ platform: c.wallet(), publicClient: c.pub, receiptTimeoutMs: 1500 }), platformAddress: PLATFORM, log: quiet });
    const d1 = mk();
    refund(d1, 'seat:R5b:unused-refund');
    void d1.flush(); // never answers: the process is "killed" here
    await sleep(800);
    const d2 = mk();
    const f = await d2.flush();
    ok('R5. KILLED MID-SEND: the next process reconciles the recorded hash instead of sending again — one transfer for one ref (it was two)',
      st.sends === 1 && f.sent.length === 0 && d2.status('seat:R5b:unused-refund').status === 'DONE', `sends ${st.sends}, resent ${f.sent.length}`);
    await rpc.close();
  }
  // R6: another transaction from our account took our nonce; ours never mines.
  {
    const B = `0x${'b'.repeat(64)}`;
    const st = node({ mine: false });
    let ours = null;
    st.handlers.eth_sendRawTransaction = ([raw]) => { const h = viem.keccak256(raw); ours = { h, nonce: nonceOf(raw) }; st.sends += 1; return h; };
    st.handlers.eth_getTransactionByHash = ([h]) => (ours && h === ours.h ? tx(ours.h, account.address, ours.nonce, USDC, '0xa9059cbb') : h === B ? tx(B, account.address, ours.nonce, USDC, '0x23b872dd', st.head) : null);
    st.handlers.eth_getBlockByNumber = ([n, full]) => { const num = n === 'latest' || n === 'pending' ? st.head : Number(BigInt(n)); return block(num, full && ours ? [tx(B, account.address, ours.nonce, USDC, '0x23b872dd', num)] : []); };
    st.handlers.eth_getTransactionReceipt = ([h]) => (h === B ? receipt(B, st.head, account.address, USDC) : null);
    const rpc = await startRpcStandIn(st.handlers);
    const c = clients(rpc.url);
    const door = createSettlement({ dataDir: dirFor('r6'), chain: viemChainAdapter({ platform: c.wallet(), publicClient: c.pub, receiptTimeoutMs: 2500 }), platformAddress: PLATFORM, log: quiet });
    refund(door, 'seat:R6:unused-refund');
    await door.flush();
    ok("R6. A REPLACEMENT'S receipt is not ours: the transfer is not DONE (viem's replacement check marked a never-mined payout DONE)",
      door.status('seat:R6:unused-refund').status !== 'DONE', door.status('seat:R6:unused-refund').status);
    await rpc.close();
  }
  // R7: a signed-ahead transfer the mempool dropped.
  {
    const st = node({ mine: false });
    st.handlers.eth_getTransactionCount = ([, tag]) => hex(tag === 'latest' ? st.mined : st.mined + st.held.size);
    const rpc = await startRpcStandIn(st.handlers);
    const c = clients(rpc.url), dir = dirFor('r7');
    const d1 = createSettlement({ dataDir: dir, chain: viemChainAdapter({ platform: c.wallet(), publicClient: c.pub, receiptTimeoutMs: 1000 }), platformAddress: PLATFORM, log: quiet });
    for (const k of [1, 2, 3]) refund(d1, `seat:R7-${k}:unused-refund`);
    await d1.flush();
    st.mined = 3; st.held.clear(); // every nonce is used by something else; no node knows our hashes
    const realNow = Date.now;
    Date.now = () => realNow() + NONCE_FLOOR_TTL_MS + 5_000;
    let f, ms, d2;
    try {
      d2 = createSettlement({ dataDir: dir, chain: viemChainAdapter({ platform: c.wallet(), publicClient: c.pub, receiptTimeoutMs: 60_000 }), platformAddress: PLATFORM, log: quiet });
      const t = performance.now();
      f = await d2.flush();
      ms = performance.now() - t;
    } finally { Date.now = realNow; }
    ok("R7. DROPPED: a TTL after the send, a mined nonce past ours and an unknown hash make it FAILED 'dropped' (it stayed SENT forever)",
      f.failed.length === 3 && f.failed.every((r) => d2.status(r)?.status === 'FAILED' && /dropped/.test(d2.status(r)?.error || '')), `${f.failed.length} dropped`);
    ok('R7. ...and the reconcile pass asks once per row instead of waiting 60 s on each', ms < 10_000, `${(ms / 1000).toFixed(1)} s for 3 stuck rows`);
    await rpc.close();
  }
  // N1: a payout and a tick pull on ONE account: one nonce stream, one lock.
  {
    const st = node({ estimateMs: 150 });
    const rpc = await startRpcStandIn(st.handlers);
    const c = clients(rpc.url);
    const door = createSettlement({ dataDir: dirFor('n1'), chain: viemChainAdapter({ pull: c.wallet(), platform: c.wallet(), publicClient: c.pub, receiptTimeoutMs: 1500 }), platformAddress: account.address, log: quiet });
    refund(door, 'seat:N1:unused-refund');
    const flushP = door.flush();
    await sleep(20); // the 1 s meter fires a direct-mode tick in another macrotask
    let pullErr = null;
    const pullP = door.pull({ from: '0x00000000000000000000000000000000000000c3', to: STREAMER, token: TOKEN, amountAtomic: '1000', ref: 'seat:N1b:tick:1' }).catch((e) => { pullErr = e; });
    await Promise.all([flushP, pullP]);
    const nonces = [...st.held.values()].map((x) => x.nonce).sort();
    ok('N1. a payout and a tick pull on the same account sign DIFFERENT nonces and both are accepted (both signed nonce 0; the tick lost and ended the seat)',
      !pullErr && nonces.join(',') === '0,1' && door.status('seat:N1:unused-refund').status === 'DONE', `nonces ${nonces.join(',')}${pullErr ? `; pull threw ${pullErr.shortMessage || pullErr.message}` : ''}`);
    await rpc.close();
  }
} catch (e) { ok(`R5-R7/N1. the section ran to the end (it crashed: ${e.message})`, false); } }

// ── C: signer keys — the guard sees every key a signer could use (cc-3, N4) ──
{ try {
  const { normalizeKey, signerAddress, keyProblem } = await import('./token-utils.js');
  const { privateKeyToAccount } = await import('viem/accounts');
  const K = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // a public test key (Anvil #0), not a secret
  const strict = (k) => (/^0x[0-9a-fA-F]{64}$/.test(k || '') ? privateKeyToAccount(k).address : null); // server.js keyAddress today
  const addr = privateKeyToAccount(`0x${K}`).address;
  ok('C. an unprefixed key (the form escrow-chain.js signs with) resolves for the collision guard; the strict reader saw no key at all',
    signerAddress(K) === addr && strict(K) === null && normalizeKey(` ${K} `) === `0x${K}`);
  ok('C. ...empty and whitespace are UNSET, never malformed, and resolve to nothing (PLATFORM_SETTLEMENT_KEY is present-but-empty in production)',
    keyProblem('') === 'unset' && keyProblem('   ') === 'unset' && keyProblem(undefined) === 'unset' && signerAddress('') === null && signerAddress('  ') === null);
  ok('C. ...a set key without 0x is MALFORMED by name (it used to log "not set"), and a 0x key is fine',
    keyProblem(K) === 'malformed' && keyProblem(`0x${K}`) === null && keyProblem('0x1234') === 'malformed');
  // N4: a reward-pool key that is the platform account is refused at the door, by name.
  const same = { ...fakeChain(), address: () => addr };
  const errs = [];
  const door = createSettlement({ dataDir: dirFor('c-n4'), chain: same, platformAddress: addr, log: { log() {}, warn() {}, error: (m) => errs.push(m) } });
  ok('C. N4: a reward pool that resolves to the platform wallet is DISABLED at the door, named, and the server keeps its other slots',
    door.hasSigner('rewardPool') === false && door.hasSigner('platform') === true && errs.some((m) => /REWARD_POOL_PRIVATE_KEY/.test(m) && /SELLER_WALLET_ADDRESS/.test(m)));
  const sep = { ...fakeChain(), address: (s) => (s === 'rewardPool' ? '0x' + '9'.repeat(40) : addr) };
  const door2 = createSettlement({ dataDir: dirFor('c-n4b'), chain: sep, platformAddress: addr, otherSigners: { ESCROW_OPERATOR_KEY: signerAddress(K) }, log: quiet });
  const door3 = createSettlement({ dataDir: dirFor('c-n4c'), chain: { ...sep, address: (s) => (s === 'rewardPool' ? addr : '0x' + '8'.repeat(40)) }, platformAddress: '0x' + '8'.repeat(40), otherSigners: { ESCROW_OPERATOR_KEY: signerAddress(K) }, log: quiet });
  ok('C. ...a reward pool of its own is kept; one that is an escrow key (unprefixed in the env) is refused too',
    door2.hasSigner('rewardPool') === true && door3.hasSigner('rewardPool') === false);
} catch (e) { ok(`C. the section ran to the end (it crashed: ${e.message})`, false); } }

// ── TU: amounts parse strictly and print signed (money-13, cc-30) ───────────
{ try {
  const { toAtomic, fromAtomic } = await import('./token-utils.js');
  const throws = (f) => { try { f(); return false; } catch { return true; } };
  const refused = ['-0.5', '-1.5', '+1', '1e-7', String(1e-7), '1.2.3', '', ' ', '.', 'abc', '0x10', '1,5'].filter((v) => !throws(() => toAtomic(v, 6)));
  ok('TU. a signed, exponent, multi-dot, empty or junk amount is REFUSED (-0.5 became +0.5, so a "-0.5" campaign reward was a 0.5 reward)',
    refused.length === 0, refused.map((v) => JSON.stringify(v)).join(' ') || 'all refused');
  ok('TU. ...plain decimals still parse, as before', toAtomic('1.5', 6) === 1_500_000n && toAtomic('.5', 6) === 500_000n && toAtomic('1.', 6) === 1_000_000n && toAtomic(' 2 ', 6) === 2_000_000n && toAtomic('0.001', 0) === 0n);
  ok('TU. ...excess precision truncates by default (the demo room parses "0.001" at 0 decimals) and is refused in exact mode',
    toAtomic('0.0000019', 6) === 1n && throws(() => toAtomic('0.0000019', 6, { exact: true })) && toAtomic('1.500000000', 6, { exact: true }) === 1_500_000n);
  ok('TU. fromAtomic prints negatives with ONE sign ("-1.-5" before)', fromAtomic(-1_500_000n, 6) === '-1.5' && fromAtomic(-1n, 6) === '-0.000001' && fromAtomic(-500_000n, 6) === '-0.5' && fromAtomic(0n, 6) === '0' && fromAtomic(12n, 0) === '12');
} catch (e) { ok(`TU. the section ran to the end (it crashed: ${e.message})`, false); } }

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
  '_gate-campaigns.mjs': 1,         // a node STAND-IN answering the raw send (custom transport, no network, no funds): proves settlement.js records PULL_SENT before the send, 2026-10-23 round 3
  '_gate-escrow-chain.mjs': 1,      // the escrow contract STAND-IN's raw-send handler (127.0.0.1, generated keys, no funds): proves escrow-chain.js signs ahead and reads a lost deposit back, 2026-10-24
  // _gate-gas-floor (2), _gate-pin (4), _gate-stability (4), _verify-join (5)
  // and scripts/probe-tempo-write (1) left the pin when they were deleted,
  // 2026-10-24 (audit harness-1/-2/-12: Arc-era, or unable to load).
  '_gate-guest-whitelist.mjs': 4,
  '_gate-mpp-clientpath.mjs': 9,
  '_gate-polish.mjs': 3,
  'scripts/deploy-escrow.mjs': 1,   // deployContract — the escrow's one deploy path
  'scripts/fund-escrow-roles.mjs': 1, // a capped USDC.e transfer to a role wallet for gas, mainnet, flag-guarded
  'src/passkey-wallet.mjs': 1,
  'web/components/campaigns/approve-step.tsx': 1, // a campaign creator's ONE approve of the budget to the pull spender (campaign-engine.js funding), 2026-10-23
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
