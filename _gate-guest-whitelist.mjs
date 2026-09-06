/**
 * GATE — GUEST WHITELIST
 *
 * Proves the streamer's standing free list over real HTTP against a real
 * server process: no store-level shortcuts, no asserting what the code "would"
 * do. Sections:
 *
 *   A  setup — identities, ownership, a paid room
 *   B  a whitelisted guest joins a PAID room and is charged nothing
 *   C  nobody else can join free by manipulating the client
 *   D  the master switch disables without losing the list
 *   E  the list supersedes price, seat cap, join-stream off, and a watch gate
 *   F  removing someone mid-session does not kick them
 *   G  the list cap is enforced
 *   H  ZERO transfer calls reached the chain across every section above
 *
 * Section H is the standing constraint and the reason this gate runs its own
 * JSON-RPC listener instead of pointing at a public node: every call the
 * server makes is recorded, so "nothing was charged" is measured at the wire
 * rather than inferred from a log line. The server is deliberately started
 * WITH a seller key, so the refund/transfer path is live and armed — a gate
 * that disabled it would prove nothing.
 */
import { createHmac } from 'crypto';
import { createServer } from 'http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { startGateServer } from './_gate-helpers.mjs';

const PORT = Number(process.env.GATE_PORT || 3390);
const RPC_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}`;
const CHAIN_ID = 4217; // must match the server (TEMPO_CHAIN_ID) or viem rejects the client
const WHITELIST_MAX = 3; // small on purpose so section G is cheap to fill

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { failures.push(label + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ─── mock JSON-RPC: answers plausibly, and REMEMBERS everything ─────────────
const rpcCalls = [];
const ERC20_TRANSFER_SELECTORS = ['0xa9059cbb', '0x23b872dd']; // transfer, transferFrom
function rpcResult(method, params) {
  switch (method) {
    case 'eth_chainId': return '0x' + CHAIN_ID.toString(16);
    case 'eth_blockNumber': return '0x10';
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas': return '0x3b9aca00';
    case 'eth_getBalance': return '0x0';
    case 'eth_getTransactionCount': return '0x0';
    case 'eth_estimateGas': return '0x5208';
    // Every read (balanceOf included) answers ZERO, so a non-whitelisted
    // joiner is genuinely broke and a paid join must fail with 402. That is
    // what makes "the toggle is off, so they are charged normally" observable.
    case 'eth_call': return '0x' + '0'.repeat(64);
    case 'eth_getBlockByNumber':
      return { number: '0x10', hash: '0x' + '1'.repeat(64), parentHash: '0x' + '0'.repeat(64), timestamp: '0x0', baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], miner: '0x' + '0'.repeat(40), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '0'.repeat(512), receiptsRoot: '0x' + '0'.repeat(64), sha3Uncles: '0x' + '0'.repeat(64), size: '0x0', stateRoot: '0x' + '0'.repeat(64), totalDifficulty: '0x0', transactionsRoot: '0x' + '0'.repeat(64), uncles: [] };
    default: return null;
  }
}
const rpc = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    const out = batch.map((call) => {
      const method = call.method || 'unknown';
      const params = call.params || [];
      rpcCalls.push({ method, params, at: Date.now() });
      return { jsonrpc: '2.0', id: call.id ?? 1, result: rpcResult(method, params) };
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
  });
});

/** Calls that MOVE money, or price a move. None of these may ever appear. */
function transferCalls() {
  return rpcCalls.filter((c) => {
    if (c.method === 'eth_sendRawTransaction' || c.method === 'eth_sendTransaction') return true;
    if (c.method === 'eth_estimateGas') return true;
    if (c.method === 'eth_call') {
      const data = String(c.params?.[0]?.data || c.params?.[0]?.input || '').toLowerCase();
      return ERC20_TRANSFER_SELECTORS.some((sel) => data.startsWith(sel));
    }
    return false;
  });
}

// ─── identities: seal cookies the way auth.js unseals them ─────────────────
const AUTH_SECRET = `gate-wl-${Date.now()}`;
function cookieFor(provider, platformId) {
  const payload = Buffer.from(JSON.stringify({ provider, platformId })).toString('base64url');
  const sig = createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `mc_identity=${encodeURIComponent(`${payload}.${sig}`)}`;
}
/** Handles that must resolve to REAL accounts for the add route to accept. */
const PEOPLE = {
  streamer: { provider: 'twitch', platformId: '9001', handle: 'gatestreamer' },
  guest:    { provider: 'twitch', platformId: '9002', handle: 'gateguest' },
  outsider: { provider: 'twitch', platformId: '9003', handle: 'gateoutsider' },
  extra1:   { provider: 'twitch', platformId: '9004', handle: 'gateextra_one' },
  extra2:   { provider: 'twitch', platformId: '9005', handle: 'gateextra_two' },
  extra3:   { provider: 'twitch', platformId: '9006', handle: 'gateextra_thr' },
  extra4:   { provider: 'twitch', platformId: '9008', handle: 'gateextra_fou' },
  filler:   { provider: 'twitch', platformId: '9007', handle: 'gatefiller' },
};
function seedIdentities(dataDir) {
  const identities = {};
  const handles = {};
  for (const p of Object.values(PEOPLE)) {
    const key = `${p.provider}:${p.platformId}`;
    identities[key] = {
      provider: p.provider, platformId: p.platformId,
      username: p.handle, handle: p.handle,
      createdAt: new Date().toISOString(),
    };
    handles[p.handle] = key;
  }
  writeFileSync(path.join(dataDir, 'identities.json'), JSON.stringify({ identities, handles }, null, 2));
}
const as = (who) => ({ Cookie: cookieFor(PEOPLE[who].provider, PEOPLE[who].platformId) });

// ─── HTTP helpers ──────────────────────────────────────────────────────────
async function api(method, url, { who = null, body = null, headers = {} } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(who ? as(who) : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

/** Ledger + store snapshot: every JSON/JSONL file the server persists. */
function ledgerSnapshot(dataDir, { exclude = [] } = {}) {
  const snap = {};
  if (!existsSync(dataDir)) return snap;
  for (const f of readdirSync(dataDir)) {
    if (!/\.(json|jsonl)$/.test(f)) continue;
    if (exclude.includes(f)) continue;
    snap[f] = readFileSync(path.join(dataDir, f));
  }
  return snap;
}
function snapshotsIdentical(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs = [];
  for (const k of keys) {
    if (!a[k] || !b[k]) { diffs.push(`${k} ${a[k] ? 'removed' : 'added'}`); continue; }
    if (!a[k].equals(b[k])) diffs.push(`${k} changed`);
  }
  return diffs;
}

async function createRoom(who, name, config) {
  const r = await api('POST', '/api/dashboard/rooms', { who, body: { name, config } });
  if (![200, 201].includes(r.status) || !r.body?.room?.id) {
    throw new Error(`room create failed (${r.status}): ${JSON.stringify(r.body)}`);
  }
  await api('POST', `/api/dashboard/rooms/${r.body.room.id}/start`, { who });
  return r.body.room.id;
}
const joinPasskey = (who, room, extra = {}) =>
  api('POST', '/api/join/passkey', { who, body: { room, username: 'someone', ...extra } });
const seatsIn = async (room) => (await api('GET', `/api/seats?room=${room}`)).body;

// ─── run ───────────────────────────────────────────────────────────────────
let srv = null;
try {
  await new Promise((resolve, reject) => {
    rpc.once('error', reject);
    rpc.listen(RPC_PORT, '127.0.0.1', resolve);
  });
  console.log(`[gate] mock JSON-RPC listening on :${RPC_PORT}`);

  const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-gate-wl-'));
  seedIdentities(dataDir);

  srv = await startGateServer({
    port: PORT,
    dataDir,
    label: 'guest-whitelist',
    env: {
      AUTH_SECRET,
      GUEST_WHITELIST_MAX: String(WHITELIST_MAX),
      // The server reads TEMPO_RPC_URL — pointing RPC_URL here instead is
      // how this gate first passed section H against ZERO recorded calls.
      TEMPO_RPC_URL: `http://127.0.0.1:${RPC_PORT}`,
      TEMPO_CHAIN_ID: String(CHAIN_ID),
      // A REAL seller key, so refunds and the transfer path are armed. Section
      // H is only meaningful because this is switched on.
      SELLER_PRIVATE_KEY: '0x' + '11'.repeat(32),
      LAZY_CONNECT: '0',
      BOUNTY_CLAIM: '0',
    },
  });

  // ── A. setup ─────────────────────────────────────────────────────────────
  section('A. Setup');
  const health = await api('GET', '/api/health');
  ok('server is up', health.status === 200);

  const whoami = await api('GET', '/api/whitelist', { who: 'streamer' });
  ok('whitelist route answers a signed-in streamer', whoami.status === 200, `got ${whoami.status}`);
  ok('empty list starts disabled (nothing to enable)', whoami.body?.enabled === false);
  ok('cap is reported to the streamer', whoami.body?.max === WHITELIST_MAX, `max=${whoami.body?.max}`);

  const anon = await api('GET', '/api/whitelist');
  ok('signed-out request is refused', anon.status === 401);

  const paidRoom = await createRoom('streamer', 'Gate paid room', {
    passkeyTickPrice: '0.05', passkeyTickSeconds: 1, maxSession: '5', maxSeats: 3,
  });
  ok('paid room created and owned by the streamer', !!paidRoom);

  // ── B. a whitelisted guest joins a PAID room, charged nothing ────────────
  section('B. Whitelisted guest joins a paid room free');
  const added = await api('POST', '/api/whitelist', { who: 'streamer', body: { handle: 'gateguest' } });
  ok('guest added', added.status === 200 && added.body?.added === true, JSON.stringify(added.body));
  ok('list turns itself on with its first guest', added.body?.enabled === true);

  const before = ledgerSnapshot(srv.dataDir, { exclude: ['guest-whitelist.json'] });
  const rpcBefore = rpcCalls.length;

  const gJoin = await joinPasskey('guest', paidRoom);
  ok('guest join returns 200 on a paid room', gJoin.status === 200, `got ${gJoin.status}: ${JSON.stringify(gJoin.body)}`);
  ok('response is marked free', gJoin.body?.free === true);
  ok('response is marked whitelist', gJoin.body?.whitelist === true);
  ok('payment mode is whitelist_stream', gJoin.body?.paymentMode === 'whitelist_stream');
  ok('nothing is held against the guest', gJoin.body?.remaining === '0' && gJoin.body?.sessionCap === '0');
  ok('no wallet was ever asked for', gJoin.body?.payment?.payer === null);

  const afterJoin = ledgerSnapshot(srv.dataDir, { exclude: ['guest-whitelist.json'] });
  const ledgerDiff = snapshotsIdentical(before, afterJoin);
  ok('every ledger/store file is byte-identical after the free join', ledgerDiff.length === 0, ledgerDiff.join(', '));

  const balanceReads = rpcCalls.slice(rpcBefore).filter((c) => c.method === 'eth_call');
  ok('no balance was read for the guest (no payment path was entered)', balanceReads.length === 0,
    `${balanceReads.length} eth_call(s)`);

  const guestSeatId = gJoin.body?.seatId;
  const seatsAfter = await seatsIn(paidRoom);
  ok('the guest is actually seated', seatsAfter?.seats?.some((s) => s.id === guestSeatId));

  const audit = await api('GET', '/api/whitelist', { who: 'streamer' });
  const guestEntry = audit.body?.entries?.find((e) => e.handle === 'gateguest');
  ok('the audit record shows when they were added', !!guestEntry?.addedAt);
  ok('the audit record shows the join', !!guestEntry?.lastJoinedAt && guestEntry.joinCount === 1);

  // ── C. nobody else rides free ────────────────────────────────────────────
  section('C. A non-whitelisted viewer cannot join free');
  const spoofs = [
    ['plain outsider', { who: 'outsider', extra: {} }],
    ['outsider claiming the guest username', { who: 'outsider', extra: { username: 'gateguest' } }],
    ['outsider asserting a handle in the body', { who: 'outsider', extra: { handle: 'gateguest' } }],
    ['outsider asserting guestHandle', { who: 'outsider', extra: { guestHandle: 'gateguest' } }],
    ['outsider asserting pinned + whitelist mode', { who: 'outsider', extra: { pinned: true, paymentMode: 'whitelist_stream', whitelist: true } }],
    ['no cookie at all', { who: null, extra: { handle: 'gateguest' } }],
  ];
  for (const [label, { who, extra }] of spoofs) {
    const r = await api('POST', '/api/join/passkey', {
      who, body: { room: paidRoom, username: 'someone', address: '0x' + '2'.repeat(40), ...extra },
    });
    const freed = r.status === 200 && (r.body?.free === true || r.body?.whitelist === true);
    ok(`${label}: refused a free seat`, !freed, `status ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }

  // ── D. the master switch ─────────────────────────────────────────────────
  section('D. Master switch');
  await api('POST', `/api/leave/${guestSeatId}`, { who: 'guest' });
  const off = await api('POST', '/api/whitelist/enabled', { who: 'streamer', body: { enabled: false } });
  ok('switch reports itself off', off.status === 200 && off.body?.enabled === false);
  ok('the list survives the switch', off.body?.entries?.length === 1);

  const offJoin = await joinPasskey('guest', paidRoom, { address: '0x' + '3'.repeat(40) });
  ok('with the switch off the guest is treated as a normal payer',
    !(offJoin.status === 200 && offJoin.body?.free === true),
    `status ${offJoin.status}`);
  ok('and they are charged normally (broke wallet ⇒ 402)', offJoin.status === 402,
    `got ${offJoin.status}: ${JSON.stringify(offJoin.body).slice(0, 140)}`);

  const on = await api('POST', '/api/whitelist/enabled', { who: 'streamer', body: { enabled: true } });
  ok('flipping back on restores the switch', on.body?.enabled === true);
  ok('everyone who was on the list is still on it', on.body?.entries?.some((e) => e.handle === 'gateguest'));
  const backOn = await joinPasskey('guest', paidRoom);
  ok('the guest rides free again', backOn.status === 200 && backOn.body?.free === true);
  await api('POST', `/api/leave/${backOn.body?.seatId}`, { who: 'guest' });

  // ── E. supersedes room settings, one at a time ───────────────────────────
  section('E. Whitelist supersedes room settings');

  // E1 — price (a deliberately expensive room)
  const dearRoom = await createRoom('streamer', 'Gate expensive room', {
    passkeyTickPrice: '9.99', passkeyTickSeconds: 1, maxSession: '99', maxSeats: 3,
  });
  const e1 = await joinPasskey('guest', dearRoom);
  ok('E1 price: guest joins a $9.99/s room free', e1.status === 200 && e1.body?.free === true,
    `status ${e1.status}`);
  const e1Outsider = await joinPasskey('outsider', dearRoom, { address: '0x' + '4'.repeat(40) });
  ok('E1 price: a non-guest is still charged there', e1Outsider.status === 402, `got ${e1Outsider.status}`);

  // E2 — seat cap (a FREE room so the cap can be filled without a wallet)
  const capRoom = await createRoom('streamer', 'Gate one-seat room', {
    passkeyTickPrice: '0', passkeyTickSeconds: 1, maxSession: '0', maxSeats: 1,
  });
  const filler = await api('POST', '/api/join/mpp', {
    who: 'filler', body: { room: capRoom, username: 'filler' },
  });
  ok('E2 seat cap: the only seat is taken by someone else', filler.status === 200, `got ${filler.status}`);
  const capFull = await api('POST', '/api/join/mpp', {
    who: 'outsider', body: { room: capRoom, username: 'outsider' },
  });
  ok('E2 seat cap: the room really is full for everyone else', capFull.status === 409,
    `got ${capFull.status}: ${JSON.stringify(capFull.body).slice(0, 120)}`);
  const capGuest = await joinPasskey('guest', capRoom);
  ok('E2 seat cap: the guest gets in anyway', capGuest.status === 200 && capGuest.body?.free === true,
    `status ${capGuest.status}: ${JSON.stringify(capGuest.body).slice(0, 140)}`);
  const capSeats = await seatsIn(capRoom);
  ok('E2 seat cap: the paying viewer was NOT bumped to make room',
    capSeats?.seats?.some((s) => s.id === filler.body?.seatId));

  // E3 — join-stream switched off entirely
  const closedRoom = await createRoom('streamer', 'Gate closed room', {
    passkeyTickPrice: '0.05', maxSeats: 3, joinStream: { enabled: false },
  });
  const e3Outsider = await joinPasskey('outsider', closedRoom, { address: '0x' + '5'.repeat(40) });
  ok('E3 join-stream off: a non-guest is refused', e3Outsider.status === 403,
    `got ${e3Outsider.status}`);
  const e3 = await joinPasskey('guest', closedRoom);
  ok('E3 join-stream off: the guest still gets in', e3.status === 200 && e3.body?.free === true,
    `status ${e3.status}`);

  // E4 — an eligibility gate (min watch time is the one actually enforced)
  const gatedRoom = await createRoom('streamer', 'Gate watch-gated room', {
    passkeyTickPrice: '0.05', maxSeats: 3,
    letters: { gates: { minWatchSeconds: 3600 } },
    joinStream: { enabled: true, gatesSameAsMegaChat: true },
  });
  const e4Outsider = await joinPasskey('outsider', gatedRoom, { address: '0x' + '6'.repeat(40) });
  ok('E4 watch gate: a non-guest is blocked by the gate', e4Outsider.status === 403
    && e4Outsider.body?.reason === 'min_watch_time', `got ${e4Outsider.status} ${e4Outsider.body?.reason}`);
  const e4 = await joinPasskey('guest', gatedRoom);
  ok('E4 watch gate: the guest is not gated', e4.status === 200 && e4.body?.free === true,
    `status ${e4.status}`);

  // ── F. removal mid-session does not kick ────────────────────────────────
  section('F. Removal mid-session');
  const liveSeat = e4.body?.seatId;
  const removed = await api('DELETE', '/api/whitelist/gateguest', { who: 'streamer' });
  ok('guest removed from the list', removed.status === 200 && removed.body?.removed === true);
  await sleep(1200); // let a meter tick or a sweeper run if one were going to
  const stillThere = await seatsIn(gatedRoom);
  ok('their live seat is untouched', stillThere?.seats?.some((s) => s.id === liveSeat),
    JSON.stringify(stillThere?.seats?.map((s) => s.id)));
  const afterRemoval = await joinPasskey('guest', paidRoom, { address: '0x' + '7'.repeat(40) });
  ok('but the NEXT join is charged normally', afterRemoval.status === 402, `got ${afterRemoval.status}`);
  await api('POST', `/api/leave/${liveSeat}`, { who: 'guest' });

  // ── G. cap ──────────────────────────────────────────────────────────────
  section('G. List cap');
  const selfAdd = await api('POST', '/api/whitelist', { who: 'streamer', body: { handle: 'gatestreamer' } });
  ok('whitelisting yourself is a no-op, not an error', selfAdd.status === 200 && selfAdd.body?.skipped === 'self');
  const unknown = await api('POST', '/api/whitelist', { who: 'streamer', body: { handle: 'nobodyhome' } });
  ok('an unreal handle is rejected with a clear reason', unknown.status === 404
    && unknown.body?.reason === 'unknown_handle');

  // Fill to exactly the cap, then try one more.
  const fills = ['gateextra_one', 'gateextra_two', 'gateextra_thr'];
  const results = [];
  for (const h of fills) results.push(await api('POST', '/api/whitelist', { who: 'streamer', body: { handle: h } }));
  const accepted = results.filter((r) => r.status === 200 && r.body?.added).length;
  ok(`the first ${WHITELIST_MAX} guests are accepted`, accepted === WHITELIST_MAX, `accepted ${accepted}`);
  const overflow = await api('POST', '/api/whitelist', { who: 'streamer', body: { handle: 'gateextra_fou' } });
  ok('the add past the cap is refused with 409 list_full',
    overflow.status === 409 && overflow.body?.reason === 'list_full',
    `got ${overflow.status} ${JSON.stringify(overflow.body).slice(0, 120)}`);
  const finalList = await api('GET', '/api/whitelist', { who: 'streamer' });
  ok(`cap of ${WHITELIST_MAX} holds the list at the limit`, finalList.body?.entries?.length === WHITELIST_MAX,
    `list holds ${finalList.body?.entries?.length}`);
  ok('the refused guest is genuinely absent',
    !finalList.body?.entries?.some((e) => e.handle === 'gateextra_fou'));

  // ── H. the standing constraint ──────────────────────────────────────────
  section('H. Zero transfer calls');
  const moved = transferCalls();
  ok('no transaction was ever broadcast, priced or simulated for a whitelist seat',
    moved.length === 0, moved.map((c) => c.method).join(', '));
  const sends = rpcCalls.filter((c) => c.method === 'eth_sendRawTransaction');
  ok('specifically: zero eth_sendRawTransaction across the whole run', sends.length === 0,
    `${sends.length} send(s)`);
  console.log(`  · ${rpcCalls.length} JSON-RPC call(s) seen in total`
    + ` (${[...new Set(rpcCalls.map((c) => c.method))].join(', ') || 'none'})`);
} catch (err) {
  failures.push(`harness: ${err.message}`);
  console.error('\n[gate] harness error:', err.message);
  if (srv) console.error(srv.stderr()?.slice(-1500));
} finally {
  if (srv) srv.kill();
  rpc.close();
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`GUEST WHITELIST GATE: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All sections green (A-H).');
process.exit(0);
