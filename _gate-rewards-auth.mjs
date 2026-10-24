/**
 * GATE — watch-to-earn pays the SIGNED-IN account, in bounds, once (money-1),
 * and a seat id alone cannot take a seat (N1).
 *
 * The real server, booted by startGateServer in the foreground, over a
 * scratch DATA_DIR. Every real signer key from .env is BLANKED; the reward
 * pool gets a key generated for this run, and TEMPO_RPC_URL points at a
 * read-only stand-in on 127.0.0.1 that refuses gas estimation, so nothing can
 * be sent anywhere. Credentials are minted (mintBountyAuth), never bypassed.
 *
 *   A0  cash pays only in an allowlisted OWNED room; a password room never
 *   A1  an anonymous socket in a cash room earns nothing and writes no intent
 *   A2  a signed-in socket naming an attacker wallet: every intent pays the
 *       account's payout wallet
 *   A3  re-registering and three more sockets: the total stays within the cap
 *   A4  a restart over the same data: the cap still holds
 *   A5  the server's bounds apply whatever the room stored
 *   A6  a cash reward is cash only: no seat credit beside it
 *   A7  register_seat / camera_ready without the seat token are refused, and
 *       the seat survives the attacker's socket closing
 *
 * A8 (a credit join spending another account's credit) is the join route's,
 * not this module's: HANDOFF in scratchpad/audit/fix-money/NOTES.md.
 */
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import WebSocket from 'ws';
import { generatePrivateKey } from 'viem/accounts';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-gate-rewards-auth-'));
process.env.DATA_DIR = SCRATCH;
const PORT = 3347;
const APP = `http://localhost:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const ATTACKER = '0x000000000000000000000000000000000000a77a';
const PAYOUT = '0x00000000000000000000000000000000000b0b01';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n── rewards: signed in, in bounds, once ─────────────────────');

const rooms = await import('./rooms-store.js');
const accounts = await import('./accounts.js');
const { startGateServer, mintBountyAuth } = await import('./_gate-helpers.mjs');
const { startRpcStandIn, readOnlyTokenNode } = await import('./_gate-rpc-standin.mjs');

const auth = mintBountyAuth({ handles: ['earner', 'owner1', 'owner2'], dataDir: SCRATCH });
accounts.setAccountPayoutWallet(auth.accountIdFor('earner'), PAYOUT);
const rewards = { enabled: true, rewardType: 'usdc', earnInterval: 1, earnAmount: '1000', earnCap: '1000000' };
const cashRoom = rooms.createRoom('cash room', { rewards });
rooms.setRoomOwner(cashRoom.id, auth.accountIdFor('owner1'));
const otherRoom = rooms.createRoom('not allowlisted', { rewards });
rooms.setRoomOwner(otherRoom.id, auth.accountIdFor('owner2'));
const pwRoom = rooms.createRoom('password room', { rewards });
const freeRoom = rooms.createRoom('free room', { passkeyTickPrice: '0' });

const rpc = await startRpcStandIn(readOnlyTokenNode());
const ENV = {
  ...auth.env, KEEP_ORPHAN_ROOMS: 'true',
  // Real keys start blank (startGateServer, SENSITIVE_ENV): nothing this gate
  // boots can sign with a funded key. Generated for this run, never funded, and the node is a read-only stand-in:
  // the seller key exists only so the MPP route (the free-room join) is mounted.
  SELLER_PRIVATE_KEY: generatePrivateKey(), REWARD_POOL_PRIVATE_KEY: generatePrivateKey(),
  TEMPO_RPC_URL: rpc.url,
  REWARDS_CASH_ALLOWLIST: auth.accountIdFor('owner1'),
  REWARDS_MIN_INTERVAL_S: '2', REWARDS_MAX_EARN: '0.01', REWARDS_MAX_CAP: '0.03',
  SEAT_RECONNECT_GRACE_MS: '5000',
};
const doorFile = path.join(SCRATCH, 'settlement.jsonl');
const intents = () => (existsSync(doorFile) ? readFileSync(doorFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'INTENT' && String(r.ref).startsWith('reward:')) : []);
const total = (rs) => rs.reduce((a, r) => a + BigInt(r.amountAtomic), 0n);

function socket(cookie = null) {
  const ws = new WebSocket(WS_URL, cookie ? { headers: { Cookie: cookie } } : {});
  ws.msgs = [];
  ws.on('message', (raw) => { try { ws.msgs.push(JSON.parse(raw.toString())); } catch { /* not json */ } });
  return new Promise((resolve, reject) => { ws.on('open', () => resolve(ws)); ws.on('error', reject); });
}
const send = (ws, m) => ws.send(JSON.stringify(m));
const lastConfig = (ws) => [...ws.msgs].reverse().find((m) => m.type === 'rewards_config');
const register = async (ws, roomId, wallet = ATTACKER) => { send(ws, { type: 'rewards_register', roomId, wallet }); send(ws, { type: 'rewards_visibility', visible: true }); await sleep(300); return lastConfig(ws); };

let srv = null, crashed = null;
const sockets = [];
try {
  srv = await startGateServer({ port: PORT, dataDir: SCRATCH, label: 'rewards-auth', env: ENV });
  const cookie = auth.cookieFor('earner');

  // ── A0 / A1: where cash may pay, and to whom ──────────────────────────────
  const anon = await socket(); sockets.push(anon);
  const c1 = await register(anon, cashRoom.id);
  const signedPw = await socket(cookie); sockets.push(signedPw);
  const c2 = await register(signedPw, pwRoom.id);
  const signedOther = await socket(cookie); sockets.push(signedOther);
  const c3 = await register(signedOther, otherRoom.id);
  await sleep(4500);
  ok('A1. an ANONYMOUS socket in a cash room is told to sign in and earns nothing (it earned 1 intent a second to any wallet)',
    c1?.enabled === false && c1?.reason === 'sign_in_required' && intents().length === 0, `${c1?.reason}; ${intents().length} intents`);
  ok('A0. a PASSWORD-ONLY room never pays cash, signed in or not', c2?.enabled === false && c2?.reason === 'password_room', c2?.reason);
  ok('A0. an owned room whose creator is NOT on REWARDS_CASH_ALLOWLIST does not pay cash', c3?.enabled === false && c3?.reason === 'cash_not_allowed', c3?.reason);

  // ── A2 / A5: the payee and the bounds ─────────────────────────────────────
  const earner = await socket(cookie); sockets.push(earner);
  const c4 = await register(earner, cashRoom.id, ATTACKER);
  ok('A5. the server\'s bounds replace what the room stored: interval 2 s (stored 1), 0.01 per earn (stored 1000), cap 0.03 (stored 1000000)',
    c4?.enabled === true && c4.earnInterval === 2 && c4.earnAmount === '0.01' && c4.earnCap === '0.03' && c4.payout === 'cash', JSON.stringify(c4 && { i: c4.earnInterval, a: c4.earnAmount, c: c4.earnCap, why: c4.reason }));
  await sleep(4600);
  const first = intents();
  ok('A2. a signed-in socket naming an attacker wallet: EVERY intent pays the account\'s payout wallet (they paid the named wallet)',
    first.length >= 1 && first.every((r) => r.to.toLowerCase() === PAYOUT.toLowerCase() && r.signer === 'rewardPool'), `${first.length} intent(s) to ${[...new Set(first.map((r) => r.to))].join(',')}`);
  ok('A5. ...no single intent exceeds REWARDS_MAX_EARN', first.every((r) => BigInt(r.amountAtomic) <= 10_000n));

  // ── A3: re-register, and three more sockets ───────────────────────────────
  await register(earner, cashRoom.id, ATTACKER);
  for (let i = 0; i < 3; i++) { const s = await socket(cookie); sockets.push(s); await register(s, cashRoom.id, `0x${String(i + 1).repeat(40)}`); }
  await sleep(7000);
  const afterFlood = intents();
  ok('A3. RE-REGISTER + 3 MORE SOCKETS: the account\'s total stays within the 0.03 cap (it was 5x the cap in four seconds)',
    total(afterFlood) <= 30_000n && total(afterFlood) > 0n, `${afterFlood.length} intents, ${total(afterFlood)} atomic`);
  const superseded = sockets.slice(-4, -1).filter((s) => s.msgs.some((m) => m.type === 'rewards_config' && m.reason === 'superseded')).length;
  ok('A3. ...one earning socket per account per room: each newer register superseded the one before', superseded >= 2, `${superseded} superseded`);

  // ── A6: cash OR credit ────────────────────────────────────────────────────
  // Neither the account's payout wallet nor the wallet the client named holds
  // a seat credit: the old code issued the same amount AGAIN as credit.
  const termsFor = (address) => fetch(`${APP}/api/join/passkey`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'x', address, room: cashRoom.id }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const credited = [];
  for (const w of [PAYOUT, ATTACKER]) { const t = await termsFor(w); if (t.body.useRewardCredit === true || (t.body.rewardBalance != null && t.body.rewardBalance !== '0')) credited.push(`${w.slice(0, 8)}: ${t.body.rewardBalance}`); }
  ok('A6. a cash reward issues NO seat credit beside the intent, to any wallet (the same amount was also spendable credit)', credited.length === 0, credited.join(', ') || 'no credit anywhere');

  // ── A4: a restart over the same data ──────────────────────────────────────
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  sockets.length = 0;
  srv.kill(); srv = null;
  await sleep(1500);
  srv = await startGateServer({ port: PORT, dataDir: SCRATCH, label: 'rewards-auth-restart', env: ENV });
  const before = total(intents());
  const again = await socket(cookie); sockets.push(again);
  const c5 = await register(again, cashRoom.id);
  await sleep(4600);
  ok('A4. AFTER A RESTART the cap still holds: no new intent past it (a new socket was a new cap)',
    total(intents()) === before && total(intents()) <= 30_000n && c5?.earned != null, `${before} → ${total(intents())}, earned ${c5?.earned}`);

  // ── A7: a seat id is not a seat ───────────────────────────────────────────
  const join = await fetch(`${APP}/api/join/mpp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'guest', address: PAYOUT, room: freeRoom.id }) }).then((r) => r.json());
  const seatId = join.seatId;
  const attacker = await socket();
  send(attacker, { type: 'subscribe_room', room: freeRoom.id });
  send(attacker, { type: 'register_seat', seatId });
  send(attacker, { type: 'camera_ready', seatId });
  await sleep(400);
  const refused = attacker.msgs.filter((m) => m.type === 'seat_refused' && m.seatId === seatId).length;
  attacker.close();
  await sleep(6500); // past SEAT_RECONNECT_GRACE_MS
  const seats = await fetch(`${APP}/api/seats?room=${freeRoom.id}`).then((r) => r.json());
  const still = (seats.seats || []).find((s) => s.id === seatId);
  ok('A7. register_seat and camera_ready WITHOUT the seat token are refused, and the seat outlives the attacker\'s socket (it was ended as disconnected)',
    !!seatId && refused === 2 && !!still && still.live === false, `refused ${refused}, ${still ? `still seated, live ${still.live}` : 'seat GONE'}`);
  ok('A7. the join response carries the seat token the owner proves itself with (HANDOFF H2: server.js join responses)', typeof join.seatToken === 'string' && join.seatToken.length >= 32, join.seatToken ? 'present' : 'absent — HANDOFF H2 not applied');
  if (typeof join.seatToken === 'string') {
    const owner = await socket();
    send(owner, { type: 'register_seat', seatId, seatToken: join.seatToken });
    send(owner, { type: 'camera_ready', seatId, seatToken: join.seatToken });
    await sleep(500);
    const live = (await fetch(`${APP}/api/seats?room=${freeRoom.id}`).then((r) => r.json())).seats.find((s) => s.id === seatId);
    ok('A7. ...WITH the token the owner binds the seat and goes live', !owner.msgs.some((m) => m.type === 'seat_refused') && live?.live === true);
    owner.close();
  }
} catch (e) {
  crashed = e;
} finally {
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  if ((fail || crashed) && srv) { console.log('--- server output (tail) ---'); console.log(srv.stderr().slice(-4000)); }
  srv?.kill();
  await rpc.close();
  await sleep(1500);
}
if (crashed) { console.log(`\nGATE CRASHED: ${crashed.stack || crashed}`); process.exit(1); }
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
