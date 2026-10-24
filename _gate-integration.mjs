/**
 * GATE — the audit round's integration changes (2026-10-24): the server.js
 * handoffs from every lane, and the cross-file fixes nobody else held.
 *
 * Every case below FAILS on the tree as it stood before the integration pass
 * and PASSES on this one (the mutation runs are in the round's notes); the
 * ones marked (control) pass on both, so a failure elsewhere means the case,
 * not the harness.
 *
 *   M. modules, each in a fresh process on its own scratch DATA_DIR
 *      M1 a torn accounts.json refuses a sign-in and keeps its bytes (stores-2)
 *      M2 a torn campaigns.json refuses a write and keeps its bytes (stores-2)
 *      M3 a bounty pool never pays out more than came in (money-9)
 *      M4 a campaign amount past the token's precision is refused (money H11)
 *   A. a healthy server (fresh unfunded seller key, a read-only RPC stand-in,
 *      a LiveKit stand-in that records what the server asks it to remove)
 *      A1 the boot is recorded (/api/health thisBootAt, stores S1)
 *      A2 migrations REPORT at boot and write nothing unless named (S2)
 *      A3 /api/health lists the hash-chained ledgers; money not halted (H8)
 *      A4 a deleted room's airings are pruned by the sweep (S6)
 *      A5 a 100 KB WebSocket frame closes the socket (server-4, S10)
 *      A6 a WebSocket message that parses to null is ignored, not a TypeError
 *      A7 the bounty frames route takes a body over 100 KB (bounty-14, H2)
 *      A8 leave, publisher token, quality and echo need the seat token (H3)
 *      A9 a seat:<id> participant with no seat there is removed (web-3)
 *      A10 the meter refuses a voucher for a seat that is not live (web-2)
 *      A11 seat credit is spent only by the account that earned it (H4)
 *      A12 rewards.payout survives; an out-of-bounds reward is a 400 (H7)
 *      A13 (control) an invalid payout wallet is a 400, not a 500 (ci-13)
 *   B. a server over damaged data
 *      B1 a damaged visibility chain is reported at boot (S5)
 *      B2 /api/health answers over a latched money ledger and says halted (H8)
 *      B3 a refused rooms.json stops the sweeps deleting other rooms' clips (S6)
 *      B4 a set-but-malformed key is named as malformed, not "not set" (H5)
 *      B5 the reward pool cannot share the escrow operator's key (H5)
 *      B6 a malformed TICK_SECONDS is its default, not NaN (S11)
 *   C. the follow loop and the boot migration
 *      C1 an emoji at the 64th character renames the room once, not every tick (S4)
 *      C2 MIGRATE_AT_BOOT applies the migration it names (S2)
 *      C3 a pull the halted door refuses ends the seat as ledger_corrupt, not out_of_funds (H8)
 *
 * Spends nothing: every key is generated for the run and never funded, the
 * RPC stand-in answers reads only, and no gas can be estimated through it.
 * Foreground only. Leaves no server running.
 *
 *   node _gate-integration.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratchDirs = [];
const scratch = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `mc-integration-${tag}-`)); scratchDirs.push(d); return d; };
const mod = (f) => import(pathToFileURL(path.join(HERE, f)).href);

// ── M. one module case per child process ────────────────────────────────────
// A module reads DATA_DIR and builds its caches once, so each case gets a
// process of its own and reports one JSON line.
if (process.argv[2] === '--case') {
  const name = process.argv[3];
  const dir = scratch(name);
  process.env.DATA_DIR = dir;
  process.env.BOUNTY_CLAIM = '1';
  const quiet = { log() {}, warn() {}, error() {} };
  const out = {};
  try {
    if (name === 'M1') {
      const file = path.join(dir, 'accounts.json');
      const doc = { accounts: { acct_alice0000000001: { id: 'acct_alice0000000001', handle: 'alice', primary: 'twitch', createdAt: '2026-10-01T00:00:00.000Z', links: [{ provider: 'twitch', platformId: '1', username: 'alice', handle: 'alice', linkedAt: '2026-10-01T00:00:00.000Z', attributes: null, attributesFetchedAt: null }], reservedHandles: [] } }, handles: { alice: 'acct_alice0000000001' }, links: { 'twitch:1': 'acct_alice0000000001' } };
      const full = JSON.stringify(doc, null, 2);
      fs.writeFileSync(file, full.slice(0, Math.floor(full.length * 0.6))); // a torn write
      const before = fs.readFileSync(file);
      const accounts = await mod('accounts.js');
      try { accounts.upsertAccountForLink({ provider: 'twitch', platformId: '1', username: 'alice' }); out.threw = null; } catch (e) { out.threw = e.code || e.message; }
      out.untouched = Buffer.compare(before, fs.readFileSync(file)) === 0;
    } else if (name === 'M2') {
      const file = path.join(dir, 'campaigns.json');
      fs.writeFileSync(file, '{"campaigns":{"cmp_1":{"id":"cmp_1","slug":"first","status":"live"');
      const before = fs.readFileSync(file);
      const { createCampaignStore } = await mod('campaign-store.js');
      const s = createCampaignStore({ dataDir: dir });
      try { s.putCampaign({ id: 'cmp_2', slug: 'second', status: 'draft' }); out.threw = null; } catch (e) { out.threw = e.code || e.message; }
      out.untouched = Buffer.compare(before, fs.readFileSync(file)) === 0;
    } else if (name === 'M3') {
      const escrow = await mod('bounty-escrow.js');
      const store = await mod('bounty-store.js');
      const intents = [];
      const settlement = { release: (a) => { intents.push({ kind: 'release', ...a }); return { ok: true }; }, refund: (a) => { intents.push({ kind: 'refund', ...a }); return { ok: true }; } };
      store.verifyEvidenceIntegrity();
      const a = escrow.contribute({ platform: 'twitch', handle: 'intstreamer', contributor: 'fan:a', amount: '1', letterRef: 'L-a' });
      const b = escrow.contribute({ platform: 'twitch', handle: 'intstreamer', contributor: 'fan:b', amount: '100', letterRef: 'L-b' });
      const rel = escrow.release({ handleKey: a.handleKey, claimId: null, airSessionId: null, verifiedClips: 1, verifiedClipSeconds: 30, confidence: 0.9, idempotencyKey: 'int:release:1', settlement });
      escrow.refund({ handleKey: a.handleKey, reason: 'UNVERIFIABLE_CLIP', actor: 'system', contributionIds: [b.id], settlement });
      escrow.refund({ handleKey: a.handleKey, reason: 'ADMIN_ACTION', actor: 'system', contributionIds: [a.id], settlement });
      out.released = rel.released;
      out.moneyOut = +intents.filter((i) => i.bucket !== 'platform_match').reduce((s, i) => s + parseFloat(i.amount), 0).toFixed(6);
      out.remaining = store.getPool(a.handleKey).remaining;
    } else if (name === 'M4') {
      const accounts = await mod('accounts.js');
      const { createCampaignEngine } = await mod('campaign-engine.js');
      const { createSettlement } = await mod('settlement.js');
      const creator = accounts.upsertAccountForLink({ provider: 'twitch', platformId: 'int1', username: 'intcreator' });
      const PLATFORM = '0x' + '11'.repeat(20);
      const door = createSettlement({ dataDir: dir, chain: null, platformAddress: PLATFORM, log: quiet });
      const eng = createCampaignEngine({
        dataDir: dir, settlement: door, platformAddress: PLATFORM, spender: '0x' + '22'.repeat(20),
        usdc: { address: '0x20c000000000000000000000b9537d11c60e8b50', decimals: 6, symbol: 'USDC' },
        resolveRoom: (h) => (h === 'introom' ? { id: 'room-int', ownerKey: creator.id } : null),
        roomOnAir: () => true, seatSignalAvailable: () => true, log: quiet,
      });
      const input = (amount) => ({
        title: 'Integration offer', blurb: 'Send a Holler on my stream and get paid for it.',
        action: { kind: 'holler', roomHandle: 'introom', require: 'aired' },
        reward: { type: 'usdc', amount }, budget: { amount: '1' }, maxClaims: 5,
        deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(), rules: { minFollowers: 10 },
      });
      const who = { accountId: creator.id, isAdmin: false };
      try { const c = await eng.createCampaign(input('0.0000019'), who); out.tooPrecise = { created: c.reward?.amount ?? true }; } catch (e) { out.tooPrecise = { refused: e.code || 'error', message: e.message }; }
      try { const c = await eng.createCampaign(input('0.5'), who); out.plain = { created: c.reward?.amount }; } catch (e) { out.plain = { refused: e.code || 'error', message: e.message }; }
    }
  } catch (e) { out.crashed = e.stack || e.message; }
  console.log(`CASE ${JSON.stringify(out)}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* OneDrive may hold a file */ }
  process.exit(0);
}

// ── the harness ─────────────────────────────────────────────────────────────
const { startGateServer, mintBountyAuth } = await import('./_gate-helpers.mjs');
const { startRpcStandIn, readOnlyTokenNode } = await import('./_gate-rpc-standin.mjs');
const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
const { encodeAbiParameters } = await import('viem');
const WebSocket = (await import('ws')).default;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(4, 70 - t.length))}`);
const BASE_PORT = Number(process.env.GATE_INTEGRATION_PORT) || 3441;
// Every live key (signers, LiveKit, platform secrets, moderation) already
// starts blank in a startGateServer child (SENSITIVE_ENV); this is the
// behaviour on top of that.
const NO_MONEY = {
  CAMPAIGN_FUNDING: '', X_CLIENT_ID: '', TWITCH_CLIENT_ID: '', MIGRATE_AT_BOOT: '',
  REWARDS_CASH_ALLOWLIST: '', KEEP_ORPHAN_ROOMS: 'true', FOLLOW_STREAM: '0',
};
const servers = [];
const closers = [];
process.on('exit', () => { for (const s of servers) s.kill(); });

const runCase = (name) => {
  const r = spawnSync(process.execPath, [SELF, '--case', name], { cwd: HERE, encoding: 'utf8', timeout: 120_000, env: { ...process.env } });
  const line = `${r.stdout || ''}`.split(/\r?\n/).find((l) => l.startsWith('CASE '));
  try { return JSON.parse(line.slice(5)); } catch { return { crashed: `${r.stdout || ''}${r.stderr || ''}`.slice(-600) }; }
};

// A LiveKit stand-in: the server's RoomServiceClient speaks Twirp over HTTP.
// It records every RemoveParticipant and answers every call with an empty
// success, so boot reconciliation finds an empty project.
function startLivekitStandIn() {
  const removed = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.endsWith('/RemoveParticipant')) { try { removed.push(JSON.parse(body)); } catch { removed.push({ raw: body }); } }
      res.writeHead(200, { 'content-type': 'application/json' }).end(req.url.endsWith('/ListRooms') ? '{"rooms":[]}' : '{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, removed,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

// LiveKit webhooks, signed the way LiveKit signs them (HS256, sha256 of the body).
const LK = { key: 'gatelk-int', secret: randomBytes(24).toString('hex') };
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function lkWebhook(event) {
  const body = JSON.stringify(event);
  const nowS = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const pl = b64u(JSON.stringify({ iss: LK.key, sha256: createHash('sha256').update(body).digest('base64'), iat: nowS, exp: nowS + 300 }));
  const sig = b64u(createHmac('sha256', LK.secret).update(`${h}.${pl}`).digest());
  return { body, headers: { 'Content-Type': 'application/webhook+json', Authorization: `Bearer ${h}.${pl}.${sig}` } };
}

const http_ = (APP) => async (method, p, { body, cookie, headers = {}, raw } = {}) => {
  const r = await fetch(`${APP}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json };
};
const wsOpen = (url, opts) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, opts);
  const msgs = [];
  ws.on('message', (d) => { try { msgs.push(JSON.parse(d.toString())); } catch { /* binary */ } });
  ws.once('open', () => resolve({ ws, msgs }));
  ws.once('error', reject);
});
const until = async (fn, ms = 8000, step = 200) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return !!(await fn());
};

try {
  // ═══ M ════════════════════════════════════════════════════════════════════
  section('M. modules');
  const m1 = runCase('M1');
  ok('M1 a torn accounts.json REFUSES the sign-in (store_refused) instead of minting the person again', m1.threw === 'store_refused', JSON.stringify(m1).slice(0, 200));
  ok('M1 ...and the torn file is left byte-for-byte for a person to repair', m1.untouched === true);
  const m2 = runCase('M2');
  ok('M2 a torn campaigns.json REFUSES a write (store_refused) instead of reading as "no campaigns"', m2.threw === 'store_refused', JSON.stringify(m2).slice(0, 200));
  ok('M2 ...and the funded campaign it held is not erased by the save', m2.untouched === true);
  const m3 = runCase('M3');
  ok('M3 $1 + $100, a release on A\'s clip, then both refunded: contributor money out never exceeds the $101 that came in',
    typeof m3.moneyOut === 'number' && m3.moneyOut <= 101 + 1e-6 && m3.released > 0, JSON.stringify(m3));
  ok('M3 ...and the pool never reads negative', typeof m3.remaining === 'number' && m3.remaining >= 0, `remaining=${m3.remaining}`);
  const m4 = runCase('M4');
  ok('M4 a reward of "0.0000019" USDC (7 places) is REFUSED, not truncated to 0.000001', m4.tooPrecise?.refused === 'invalid' && /decimal places/.test(m4.tooPrecise?.message || ''), JSON.stringify(m4.tooPrecise));
  ok('M4 (control) a reward of "0.5" is created', m4.plain?.created === '0.5', JSON.stringify(m4.plain));

  // ═══ A ════════════════════════════════════════════════════════════════════
  section('A. a healthy server');
  const VIEWER = privateKeyToAccount(generatePrivateKey()).address;
  const STREAMER = privateKeyToAccount(generatePrivateKey()).address;
  const FAN_WALLET = privateKeyToAccount(generatePrivateKey()).address;
  const OTHER_WALLET = privateKeyToAccount(generatePrivateKey()).address;
  const word = (n) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(n)]);
  const node = readOnlyTokenNode();
  const rpc = await startRpcStandIn({
    ...node,
    // balanceOf and allowance answer 5 USDC, so a paid join is granted;
    // nothing else changes, and nothing can be sent.
    eth_call: (params) => (/^0x(70a08231|dd62ed3e)/.test(String(params?.[0]?.data || params?.[0]?.input || '')) ? word(5_000_000) : node.eth_call(params)),
  });
  closers.push(rpc.close);
  const lk = await startLivekitStandIn();
  closers.push(lk.close);

  const dataA = scratch('A');
  const auth = mintBountyAuth({ handles: ['intowner', 'intfan', 'intother'], dataDir: dataA });
  {
    const f = path.join(dataA, 'accounts.json');
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    doc.accounts[auth.accountIdFor('intfan')].payoutWallet = FAN_WALLET;
    doc.accounts[auth.accountIdFor('intother')].payoutWallet = OTHER_WALLET;
    fs.writeFileSync(f, JSON.stringify(doc, null, 2));
  }
  // A pre-account identity the boot migration would carry over, and an
  // airing of a room that no longer exists.
  fs.writeFileSync(path.join(dataA, 'identities.json'), JSON.stringify({
    identities: { 'twitch:9001': { username: 'legacyone', handle: 'legacyone', createdAt: '2026-09-01T00:00:00.000Z' } },
    handles: { legacyone: 'twitch:9001' },
  }));
  const ghostAiring = randomUUID();
  fs.writeFileSync(path.join(dataA, 'airings.json'), JSON.stringify({ airings: [{ id: ghostAiring, roomId: 'ghostroom', platform: 'twitch', channel: 'ghost', startedAt: Date.now() - 3_600_000, endedAt: Date.now() - 1_800_000, moments: [] }] }));
  const accountsBefore = fs.readFileSync(path.join(dataA, 'accounts.json'));

  const seller = generatePrivateKey();
  const PORT_A = BASE_PORT;
  const srvA = await startGateServer({
    port: PORT_A, dataDir: dataA, label: 'integration-A',
    env: {
      ...NO_MONEY, ...auth.env,
      SELLER_PRIVATE_KEY: seller, SELLER_WALLET_ADDRESS: privateKeyToAccount(seller).address,
      TEMPO_RPC_URL: rpc.url, LIVEKIT_URL: lk.url, LIVEKIT_API_KEY: LK.key, LIVEKIT_API_SECRET: LK.secret,
      BOUNTY_CLAIM: '1', POSTER_SWEEP_MS: '1500', REWARDS_MIN_INTERVAL_S: '1',
    },
  });
  servers.push(srvA);
  const APP = `http://localhost:${PORT_A}`;
  const WS = `ws://localhost:${PORT_A}`;
  const call = http_(APP);
  const asOwner = auth.cookieFor('intowner');
  const asFan = auth.cookieFor('intfan');
  const asOther = auth.cookieFor('intother');

  const health = (await call('GET', '/api/health')).body;
  ok('A1 /api/health says when THIS boot was recorded (recordBoot runs at boot)', !!health.persistence?.thisBootAt, JSON.stringify(health.persistence?.thisBootAt ?? null));
  ok('A2 the account migration REPORTS at boot (one [migrate] line, by name)', /\[migrate\] accounts: report/.test(srvA.stderr()), (srvA.stderr().match(/\[migrate\][^\n]*/) || ['(no [migrate] line)'])[0].slice(0, 120));
  ok('A2 (control) ...and writes nothing, since MIGRATE_AT_BOOT does not name it (C2 is the other half)', Buffer.compare(accountsBefore, fs.readFileSync(path.join(dataA, 'accounts.json'))) === 0);
  ok('A3 /api/health lists the hash-chained ledgers, and money is not halted', Array.isArray(health.ledgers) && health.ledgers.some((l) => l.kind === 'settlement' && l.ok) && health.moneyHalted === null,
    JSON.stringify({ ledgers: health.ledgers?.length, moneyHalted: health.moneyHalted }));

  // Watched through the server's log, then read once: polling the file would
  // hold it open, and on Windows that refuses the store's rename over it.
  const dropped = await until(() => /\[airings\] dropped 1 airing\(s\) of deleted rooms/.test(srvA.stderr()), 8000, 300);
  await sleep(500);
  const ghostGone = dropped && (() => { try { return !JSON.parse(fs.readFileSync(path.join(dataA, 'airings.json'), 'utf8')).airings.some((a) => a.id === ghostAiring); } catch { return false; } })();
  ok('A4 the sweep drops the airings of a room that no longer exists', ghostGone, dropped ? (ghostGone ? '' : 'logged, but airings.json still holds it') : 'no "[airings] dropped" line');

  // A5 / A6 — the control socket
  {
    const big = await wsOpen(WS);
    const closed = new Promise((r) => big.ws.once('close', (code) => r(code)));
    big.ws.send(JSON.stringify({ type: 'subscribe_room', room: 'default', pad: 'x'.repeat(100 * 1024) }));
    const code = await Promise.race([closed, sleep(4000).then(() => 'still open')]);
    ok('A5 a 100 KB frame closes the socket (1009, message too big) instead of being buffered and parsed', code === 1009, `close ${code}`);
    try { big.ws.terminate(); } catch { /* gone */ }
    const small = await wsOpen(WS);
    small.ws.send(JSON.stringify({ type: 'subscribe_room', room: 'default' }));
    const got = await until(() => small.msgs.some((m) => m.type === 'initial_state'), 4000, 100);
    ok('A5 (control) an ordinary subscribe still gets its initial_state', got);
    small.ws.send('null');
    await sleep(600);
    const alive = await fetch(`${APP}/api/health`).then((r) => r.status).catch(() => 'down');
    ok('A6 (control) after a message that parses to null, the server still answers', alive === 200, `health ${alive}`);
    small.ws.send(JSON.stringify({ type: 'subscribe_room', room: 'default' }));
    const again = await until(() => small.msgs.filter((m) => m.type === 'initial_state').length >= 2, 3000, 100);
    ok('A6 a message that parses to null is IGNORED: the same socket still works (the TypeError used to escape the handler and leave the socket deaf)', again);
    small.ws.close();
  }

  {
    const frames = { frames: [`data:image/jpeg;base64,${'A'.repeat(200 * 1024)}`] };
    const r = await call('POST', `/api/bounty/clip/${randomUUID()}/frames`, { body: frames });
    ok('A7 a 200 KB frames upload reaches the route (404 for an unknown contribution), not the global 100 KB parser\'s 413', r.status === 404, `http ${r.status}`);
  }

  // Rooms: a free one, a paid one (MPP), a credit-reward one.
  const mk = async (name, config) => {
    const r = await call('POST', '/api/dashboard/create', { cookie: asOwner, body: { name, config } });
    return r.body?.room?.id || r.body?.roomId || null;
  };
  const freeRoom = await mk('Integration free', { passkeyTickPrice: '0' });
  const paidRoom = await mk('Integration paid', { passkeyTickPrice: '0.001', maxSession: '0.03', payoutAddress: STREAMER });
  const creditRoom = await mk('Integration credit', {
    passkeyTickPrice: '0.001', maxSession: '0.03', payoutAddress: STREAMER,
    rewards: { enabled: true, rewardType: 'usdc', payout: 'credit', earnInterval: 1, earnAmount: '0.01', earnCap: '0.1' },
  });
  ok('A (control) three rooms created', !!freeRoom && !!paidRoom && !!creditRoom, JSON.stringify({ freeRoom, paidRoom, creditRoom }));

  // A8 — the seat token on every seat-id route
  {
    const join = await call('POST', '/api/join/mpp', { body: { username: 'int-free', room: freeRoom } });
    const seatId = join.body.seatId;
    const token = join.body.seatToken;
    ok('A8 (control) a free seat is granted with its seat token', join.status === 200 && !!seatId && typeof token === 'string', `http ${join.status}`);
    const seated = async () => ((await call('GET', `/api/seats?room=${freeRoom}`)).body.seats || []).some((s) => s.id === seatId);
    const noTok = await call('POST', `/api/leave/${seatId}`, { body: {} });
    ok('A8 POST /api/leave/<id> WITHOUT the token is refused (403) and the seat stays', noTok.status === 403 && await seated(), `http ${noTok.status}`);
    const wrongTok = await call('POST', `/api/leave/${seatId}`, { body: { seatToken: randomUUID() } });
    ok('A8 ...and so is a wrong token', wrongTok.status === 403 && await seated(), `http ${wrongTok.status}`);
    const q0 = await call('POST', '/api/seat/quality', { body: { seatId, quality: 'poor' } });
    const q1 = await call('POST', '/api/seat/quality', { body: { seatId, quality: 'good', seatToken: token } });
    ok('A8 /api/seat/quality needs the token (403 without, 200 with)', q0.status === 403 && q1.status === 200, `${q0.status} / ${q1.status}`);
    const e0 = await call('POST', '/api/seat/echo', { body: { seatId, echo: true, lagS: 1 } });
    ok('A8 /api/seat/echo needs the token (403 without)', e0.status === 403, `http ${e0.status}`);
    const p0 = await call('POST', '/api/livekit/token', { body: { room: freeRoom, role: 'publisher', seatId } });
    const p1 = await call('POST', '/api/livekit/token', { body: { room: freeRoom, role: 'publisher', seatId, seatToken: token } });
    ok('A8 a PUBLISHER token for seat:<id> needs the seat token (403 without; 200 and the seat identity with)', p0.status === 403 && p1.status === 200 && p1.body.identity === `seat:${seatId}`, `${p0.status} / ${p1.status} ${p1.body.identity || ''}`);
    const left = await call('POST', `/api/leave/${seatId}`, { body: { seatToken: token } });
    ok('A8 (control) the seat\'s own token leaves it', left.status === 200 && !(await seated()), `http ${left.status}`);
  }

  // A9 — orphan seat participants
  {
    const hook = async (event) => { const q = lkWebhook(event); return fetch(`${APP}/api/livekit/webhook`, { method: 'POST', headers: q.headers, body: q.body }).then((r) => r.status); };
    const held = await call('POST', '/api/join/mpp', { body: { username: 'int-held', room: freeRoom } });
    const heldId = `seat:${held.body.seatId}`;
    const orphan = `seat:${randomUUID()}`;
    const ev = (event, room, identity) => ({ id: `EV_${randomUUID()}`, event, room: { name: `mc-${room}` }, participant: { identity }, createdAt: Math.floor(Date.now() / 1000) });
    const s1 = await hook(ev('participant_joined', freeRoom, orphan));
    const s2 = await hook(ev('participant_joined', freeRoom, heldId));
    const s3 = await hook(ev('participant_joined', paidRoom, heldId));
    const sawOrphan = await until(() => lk.removed.some((r) => r.identity === orphan && r.room === `mc-${freeRoom}`), 4000, 100);
    ok('A9 a seat:<id> participant whose seat is gone is removed from the SFU on its webhook', sawOrphan && s1 === 200, JSON.stringify(lk.removed.slice(-3)));
    const sawElsewhere = await until(() => lk.removed.some((r) => r.identity === heldId && r.room === `mc-${paidRoom}`), 3000, 100);
    ok('A9 ...and so is a held seat\'s identity in ANOTHER room', sawElsewhere && s3 === 200);
    await sleep(300);
    ok('A9 (control) a held seat in its own room is left alone', s2 === 200 && !lk.removed.some((r) => r.identity === heldId && r.room === `mc-${freeRoom}`));
    await call('POST', `/api/leave/${held.body.seatId}`, { body: { seatToken: held.body.seatToken } });
  }

  // A10 — no voucher before the seat is live
  {
    const join = await call('POST', '/api/join/mpp', { body: { username: 'int-paid', address: VIEWER, room: paidRoom } });
    ok('A10 (control) a paid MPP seat is granted (balance read from the stand-in)', join.status === 200 && !!join.body.seatId, `http ${join.status} ${join.body.error || ''}`);
    const tick = (seat) => call('POST', `/api/meter/tick?seat=${seat}&room=${encodeURIComponent(paidRoom)}`, { body: {} });
    const pre = await tick(join.body.seatId);
    ok('A10 a tick for a seat that is NOT LIVE is refused before the meter: 409 not_live (it used to get the 402 that opens a channel)', pre.status === 409 && pre.body.reason === 'not_live', `http ${pre.status} ${pre.body.reason || ''}`);
    const ghost = await tick(randomUUID());
    ok('A10 ...and a tick for a seat this room does not hold is a 404', ghost.status === 404, `http ${ghost.status}`);
    const sock = await wsOpen(WS);
    sock.ws.send(JSON.stringify({ type: 'subscribe_room', room: paidRoom }));
    sock.ws.send(JSON.stringify({ type: 'camera_ready', seatId: join.body.seatId, seatToken: join.body.seatToken }));
    await until(() => sock.msgs.some((m) => m.type === 'seat_added' && m.seat?.id === join.body.seatId), 4000, 100);
    const live = await tick(join.body.seatId);
    ok('A10 (control) once live, the same tick reaches the meter (its 402 challenge)', live.status === 402, `http ${live.status}`);
    sock.ws.close();
    await call('POST', `/api/leave/${join.body.seatId}`, { body: { seatToken: join.body.seatToken } });
  }

  // A11 / A12 — seat credit and the reward config
  {
    const cfg = (await call('GET', `/api/config?room=${creditRoom}`)).body;
    ok('A12 rewards.payout survives the room config ("credit"; it was stripped, so every USDC room paid cash)', cfg.rewards?.payout === 'credit', JSON.stringify(cfg.rewards?.payout ?? null));
    const earner = await wsOpen(WS, { headers: { Cookie: asFan } });
    earner.ws.send(JSON.stringify({ type: 'subscribe_room', room: creditRoom }));
    earner.ws.send(JSON.stringify({ type: 'rewards_register', roomId: creditRoom }));
    const earned = await until(() => earner.msgs.filter((m) => m.type === 'rewards_earned' && m.credited).length >= 2, 9000, 200);
    const conf = earner.msgs.find((m) => m.type === 'rewards_config');
    ok('A11 (control) the signed-in fan earns seat credit to their payout wallet', earned, JSON.stringify(conf ? { enabled: conf.enabled, reason: conf.reason, payout: conf.payout } : null));
    earner.ws.close();
    const join = (cookie) => call('POST', '/api/join/passkey', { cookie, body: { username: 'int-credit', address: FAN_WALLET, room: creditRoom, useRewardCredit: true } });
    const anon = await join(null);
    ok('A11 an UNSIGNED request naming the fan\'s wallet cannot spend its credit (401)', anon.status === 401, `http ${anon.status} ${anon.body.reason || ''}`);
    const other = await join(asOther);
    ok('A11 ...nor can another signed-in account (403)', other.status === 403, `http ${other.status} ${other.body.reason || ''}`);
    const mine = await join(asFan);
    ok('A11 (control) the fan who earned it joins with it', mine.status === 200 && !!mine.body.seatId, `http ${mine.status} ${mine.body.error || ''}`);
    if (mine.body.seatId) await call('POST', `/api/leave/${mine.body.seatId}`, { body: { seatToken: mine.body.seatToken } });

    const put = (rewards) => call('PUT', `/api/dashboard/rooms/${creditRoom}`, { cookie: asOwner, body: { config: { rewards } } });
    const over = await put({ enabled: true, rewardType: 'usdc', payout: 'credit', earnInterval: 1, earnAmount: '5', earnCap: '0.1' });
    ok('A12 an ENABLED reward above REWARDS_MAX_EARN is refused with 400 rewards_out_of_bounds (it saved, and was clamped silently)', over.status === 400 && over.body.code === 'rewards_out_of_bounds', `http ${over.status} ${over.body.error || ''}`);
    const off = await put({ enabled: false, rewardType: 'usdc', earnInterval: 60, earnAmount: '5', earnCap: '5' });
    ok('A12 (control) the same numbers on a reward that is OFF still save (the dashboard sends them on every save)', off.status === 200, `http ${off.status} ${off.body.error || ''}`);
    // ci-13 residual (the identity lane's accounts.js statuses): a bad
    // address is the caller's mistake, a 400, not a 500.
    const bad = await call('POST', '/api/account/payout-wallet', { cookie: asOther, body: { address: 'not-an-address' } });
    ok('A13 (control) POST /api/account/payout-wallet with an invalid address answers 400', bad.status === 400, `http ${bad.status} ${bad.body.reason || ''}`);
  }
  srvA.kill();

  // ═══ B ════════════════════════════════════════════════════════════════════
  section('B. a server over damaged data');
  const dataB = scratch('B');
  let clipFileB = null;
  {
    const { createLedger } = await import('./bounty-ledger.js');
    const quiet = { log() {}, warn() {}, error() {} };
    const damage = (file, rows) => {
      const L = createLedger({ filePath: path.join(dataB, file), kind: 'gate-damage', log: quiet });
      for (const r of rows) L.append(r);
      const p = path.join(dataB, file);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"at":2', '"at":7')); // an INTERIOR row no longer matches its checksum
    };
    damage('overlay-visibility.jsonl', [1, 2, 3].map((at) => ({ type: 'overlay_visibility', roomId: 'r2', signal: 'overlay_visible', sessionKey: null, at })));
    damage('settlement.jsonl', [1, 2, 3].map((at) => ({ type: 'INTENT', ref: `gate:${at}`, kind: 'release', signer: 'platform', to: STREAMER, amountAtomic: '1', at })));
    fs.writeFileSync(path.join(dataB, 'rooms.json'), '{"rooms":{"default":{"id":"default","name":"Default"},"r2":{"id":"r2","name":"Second"'); // torn
    const clipId = randomUUID();
    fs.mkdirSync(path.join(dataB, 'aired-clips'), { recursive: true });
    fs.writeFileSync(path.join(dataB, 'aired-clips', `${clipId}.clip`), randomBytes(2048));
    fs.writeFileSync(path.join(dataB, 'aired-clips', `${clipId}.json`), JSON.stringify({ id: clipId, roomId: 'r2', mime: 'video/webm', at: Date.now() - 60_000, bytes: 2048, keepDays: 30 }));
    fs.writeFileSync(path.join(dataB, 'airings.json'), JSON.stringify({ airings: [{ id: randomUUID(), roomId: 'r2', platform: 'twitch', channel: 'second', startedAt: Date.now() - 600_000, endedAt: Date.now() - 300_000, moments: [{ kind: 'megachat', label: null, at: Date.now() - 400_000, ref: clipId }] }] }));
    clipFileB = path.join(dataB, 'aired-clips', `${clipId}.clip`);
  }
  const shared = generatePrivateKey();
  const srvB = await startGateServer({
    port: BASE_PORT + 1, dataDir: dataB, label: 'integration-B',
    env: {
      ...NO_MONEY, SELLER_PRIVATE_KEY: 'not-a-hex-key', REWARD_POOL_PRIVATE_KEY: shared, ESCROW_OPERATOR_KEY: shared,
      TEMPO_RPC_URL: 'http://127.0.0.1:9',
      TICK_SECONDS: 'abc', POSTER_SWEEP_MS: '1500',
    },
  });
  servers.push(srvB);
  const callB = http_(`http://localhost:${BASE_PORT + 1}`);
  const logB = () => srvB.stderr();
  ok('B1 a damaged visibility chain is reported at BOOT, with what the meter does about it', /\[visibility\] the overlay-visibility chain cannot be read/.test(logB()));
  const hB = await callB('GET', '/api/health');
  ok('B2 /api/health still answers over a latched settlement ledger, and says money is halted', hB.status === 200 && !!hB.body.moneyHalted && hB.body.ledgers?.some((l) => l.kind === 'settlement' && l.ok === false),
    JSON.stringify({ status: hB.status, halted: !!hB.body.moneyHalted }));
  await sleep(4500); // two sweeps at POSTER_SWEEP_MS
  ok('B3 with rooms.json refused, the sweep stands down: another room\'s kept clip is NOT deleted', fs.existsSync(clipFileB), clipFileB);
  ok('B4 a SELLER_PRIVATE_KEY that is set but malformed is logged as malformed (by name), not "not set"', /SELLER_PRIVATE_KEY is set but is not a 0x-prefixed 64-hex key/.test(logB()));
  ok('B5 a reward-pool key that is the escrow operator\'s is refused, naming ESCROW_OPERATOR_KEY', /REWARD_POOL_PRIVATE_KEY resolves to the same address as [^\n]*ESCROW_OPERATOR_KEY/.test(logB()));
  ok('B6 a malformed TICK_SECONDS reads as its default (10 s), not NaN', /Meter \(legacy prepaid\): [0-9.]+ USDC \/ 10s/.test(logB()), (logB().match(/Meter \(legacy prepaid\)[^\n]*/) || ['(no banner)'])[0]);
  srvB.kill();

  // ═══ C ════════════════════════════════════════════════════════════════════
  section('C. the follow loop and the boot migration');
  const TITLE = `${'a'.repeat(63)}😀 and the rest of a long stream title`;
  const twitch = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/oauth2/token') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'fake', expires_in: 3600 }));
    if (url.pathname === '/helix/streams') {
      const data = url.searchParams.getAll('user_login').map((l) => ({ user_login: l, viewer_count: 3, title: TITLE }));
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => twitch.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { twitch.closeAllConnections?.(); twitch.close(r); }));
  const TW = `http://127.0.0.1:${twitch.address().port}`;
  const dataC = scratch('C');
  {
    // A latched money ledger in C's data dir: the door is halted (B2), so the
    // direct seat's first pull is refused before anything is signed (C3).
    const { createLedger } = await import('./bounty-ledger.js');
    const L = createLedger({ filePath: path.join(dataC, 'settlement.jsonl'), kind: 'gate-damage', log: { log() {}, warn() {}, error() {} } });
    for (const at of [1, 2, 3]) L.append({ type: 'INTENT', ref: `gate:${at}`, kind: 'release', signer: 'platform', to: STREAMER, amountAtomic: '1', at });
    const f = path.join(dataC, 'settlement.jsonl');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"at":2', '"at":7'));
  }
  const SELLER_C = privateKeyToAccount(generatePrivateKey()).address;
  fs.writeFileSync(path.join(dataC, 'identities.json'), JSON.stringify({
    identities: { 'twitch:9002': { username: 'legacytwo', handle: 'legacytwo', createdAt: '2026-09-01T00:00:00.000Z' } },
    handles: { legacytwo: 'twitch:9002' },
  }));
  const srvC = await startGateServer({
    port: BASE_PORT + 2, dataDir: dataC, label: 'integration-C',
    env: {
      ...NO_MONEY, SELLER_WALLET_ADDRESS: SELLER_C, TEMPO_RPC_URL: rpc.url,
      FOLLOW_STREAM: '1', TWITCH_CLIENT_ID: 'gate-client', TWITCH_CLIENT_SECRET: 'gate-secret',
      TWITCH_ID_BASE: TW, TWITCH_API_BASE: TW, FOLLOW_POLL_MS: '700', MIGRATE_AT_BOOT: 'accounts',
    },
  });
  servers.push(srvC);
  const callC = http_(`http://localhost:${BASE_PORT + 2}`);
  const made = await callC('POST', '/api/dashboard/create', { body: { name: 'Follow me', password: 'int-pass-1', config: { twitchChannel: 'intchan', twitchAuto: true } } });
  const followRoom = made.body?.room?.id || made.body?.roomId;
  await sleep(5000); // ~7 polls of a live channel whose title never changes
  const renames = srvC.stderr().split(/\r?\n/).filter((l) => l.includes(`[follow] ${followRoom} (intchan) renamed to the stream title`)).length;
  ok('C1 a title with an emoji at the 64th character renames the room ONCE, not on every poll', !!followRoom && renames === 1, `${renames} rename(s)`);
  const named = (await callC('GET', `/api/config?room=${followRoom}`)).body.roomName || '';
  ok('C1 (control) ...to the title cut by character, the emoji whole', named === Array.from(TITLE).slice(0, 64).join(''), JSON.stringify(named.slice(-6)));
  const migrated = (() => { try { return JSON.parse(fs.readFileSync(path.join(dataC, 'accounts.json'), 'utf8')); } catch { return null; } })();
  ok('C2 MIGRATE_AT_BOOT=accounts APPLIES the account migration at boot', /\[migrate\] accounts: written/.test(srvC.stderr()) && !!migrated?.handles?.legacytwo,
    (srvC.stderr().match(/\[migrate\][^\n]*/) || ['(no [migrate] line)'])[0].slice(0, 120));

  // C3 — a direct seat whose pull the halted door refuses
  {
    const room = (await callC('POST', '/api/dashboard/create', { body: { name: 'Direct seat', password: 'int-pass-2', config: { passkeyTickPrice: '0.001', maxSession: '0.03', payoutAddress: STREAMER } } })).body?.room?.id;
    const pay = Buffer.from(JSON.stringify({ type: 'approve', payer: VIEWER, amount: '30000' })).toString('base64');
    const join = await callC('POST', '/api/join/passkey', { headers: { 'X-Modular-Payment': pay }, body: { username: 'int-direct', address: VIEWER, room } });
    ok('C3 (control) a direct-mode passkey seat is granted (allowance read from the stand-in)', join.status === 200 && join.body.escrowMode === 'direct', `http ${join.status} ${join.body.error || ''} ${join.body.reason || ''}`);
    const sock = await wsOpen(`ws://localhost:${BASE_PORT + 2}`);
    sock.ws.send(JSON.stringify({ type: 'subscribe_room', room }));
    sock.ws.send(JSON.stringify({ type: 'camera_ready', seatId: join.body.seatId, seatToken: join.body.seatToken }));
    await until(() => sock.msgs.some((m) => m.type === 'seat_removed' && m.seatId === join.body.seatId), 8000, 200);
    const gone = sock.msgs.find((m) => m.type === 'seat_removed' && m.seatId === join.body.seatId);
    ok('C3 a pull the HALTED door refuses ends the seat as ledger_corrupt — our ledger, not the viewer\'s balance (it said out_of_funds)', gone?.reason === 'ledger_corrupt', `reason ${gone?.reason ?? '(seat not removed)'}`);
    sock.ws.close();
  }
  srvC.kill();

  // D — a non-numeric PENDING_CAMERA_TIMEOUT_MS. Number('abc') is NaN, and
  // setTimeout(NaN) fires at once, so every seat was released before its
  // camera could start; envNum falls back to the five-minute default.
  {
    const dataD = scratch('D');
    const srvD = await startGateServer({
      port: BASE_PORT + 3, dataDir: dataD, label: 'integration-D',
      // Server A's shape: the MPP meter needs the seller key to grant a seat at all.
      env: { ...NO_MONEY, ...auth.env, SELLER_PRIVATE_KEY: seller, SELLER_WALLET_ADDRESS: privateKeyToAccount(seller).address, TEMPO_RPC_URL: rpc.url, PENDING_CAMERA_TIMEOUT_MS: 'abc' },
    });
    servers.push(srvD);
    const callD = http_(`http://localhost:${BASE_PORT + 3}`);
    const room = (await callD('POST', '/api/dashboard/create', { body: { name: 'Pending camera', password: 'int-pass-3', config: { passkeyTickPrice: '0' } } })).body?.room?.id;
    const join = await callD('POST', '/api/join/mpp', { body: { username: 'int-pending', room } });
    ok('D1 (control) a free seat is granted and left pending (no camera_ready)', join.status === 200 && !!join.body.seatId, `http ${join.status} ${join.body.error || ''}`);
    await sleep(2500);
    const still = ((await callD('GET', `/api/seats?room=${room}`)).body.seats || []).some((s) => s.id === join.body.seatId);
    ok('D1 with PENDING_CAMERA_TIMEOUT_MS=abc the pending seat is still held after 2.5 s (a non-number falls back to the default; it used to end the seat at once)', still);
    await callD('POST', `/api/leave/${join.body.seatId}`, { body: { seatToken: join.body.seatToken } });
    srvD.kill();
  }
} catch (e) {
  ok(`the gate ran to the end (it crashed: ${e.stack || e.message})`, false);
} finally {
  for (const s of servers) s.kill();
  for (const c of closers) { try { await c(); } catch { /* already closed */ } }
  await sleep(1000);
  for (const d of scratchDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a file still held */ } }
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
