/**
 * GATE — demo money in the Holler demo room (owner, 2026-11-09).
 *
 * In the demo room (handle 'demo', seeded by server.js) a signed-in viewer
 * earns $1 of demo money a second, up to $10, and spends it right there on a
 * Call in ($0.10/s) and a Holler ($0.05/s). It is never real: no settlement,
 * no transfer, real money refused, never listed as withdrawable. The house
 * issues at most DEMO_CREDIT_HOURLY / DEMO_CREDIT_DAILY in total (small here).
 *
 * The real server, booted by startGateServer in the foreground over a scratch
 * DATA_DIR, every real signer key blanked; a seller key generated for this run
 * (only so the MPP join route is mounted) and TEMPO_RPC_URL on a read-only
 * stand-in, so nothing can be sent anywhere. Identities are minted
 * (mintBountyAuth), never bypassed.
 *
 *   D1  the demo's terms: $1 every 1 s up to $10, credit, never cash
 *   D2  earning ticks every second to the $10 cap, for a signed-in viewer only
 *   D3  real money is refused in the demo (Call in and Holler)
 *   D4  a Holler is paid in demo money ($0.50 for 10 s), another account
 *       cannot spend it, and a reject gives it back (no settlement row)
 *   D5  a Call in seat runs on demo money on the MPP route: the meter spends
 *       $0.10 a second, and leaving gives the rest back
 *   D6  the house budget stops grants at the hourly limit, in words
 *   D7  a seat stops when the demo money runs out
 *   D8  the budget persists across a restart; the daily limit has its own words
 *   D9  a non-demo room is unchanged: 60 s minimum, $0.01 / $0.1 bounds, cash
 *       rules (a room that only stores isDemo is not the demo)
 *   D10 the account's Rewards section never lists demo money
 *   D11 the $10 cap is per visit: back within the grace (a refresh) it is
 *       still maxed; gone past it, the counter starts at $0 and earns again
 *
 * GATE_CWD runs the same checks against another tree (the previous code).
 */
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import WebSocket from 'ws';
import { generatePrivateKey } from 'viem/accounts';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-gate-demo-money-'));
process.env.DATA_DIR = SCRATCH;
const PORT = Number(process.env.GATE_PORT || 3361);
const APP = `http://localhost:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const CWD = process.env.GATE_CWD || undefined;
const DEMO_PW = 'demo-gate-password';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n── demo money: earn, spend, house budget${CWD ? ` (tree: ${CWD})` : ''} ──────────`);

const rooms = await import('./rooms-store.js');
const { startGateServer, mintBountyAuth } = await import('./_gate-helpers.mjs');
const { startRpcStandIn, readOnlyTokenNode } = await import('./_gate-rpc-standin.mjs');

const auth = mintBountyAuth({ handles: ['demoa', 'demob', 'democ'], dataDir: SCRATCH });
// Non-demo rooms, seeded before boot, storing the demo's own terms.
const demoTerms = { enabled: true, rewardType: 'usdc', payout: 'credit', earnInterval: 1, earnAmount: '1', earnCap: '10' };
const creditRoom = rooms.createRoom('credit room', { rewards: demoTerms });
const fakeDemo = rooms.createRoom('claims to be the demo', { isDemo: true, rewards: demoTerms });
const cashRoom = rooms.createRoom('cash password room', { rewards: { ...demoTerms, payout: 'cash' } });

const rpc = await startRpcStandIn(readOnlyTokenNode());
const baseEnv = {
  ...auth.env, KEEP_ORPHAN_ROOMS: 'true', DEMO_ROOM_PASSWORD: DEMO_PW,
  SELLER_PRIVATE_KEY: generatePrivateKey(), TEMPO_RPC_URL: rpc.url,
  SEAT_RECONNECT_GRACE_MS: '5000',
  // Small house limits: $11 an hour (one viewer's $10 and one more), $100 a day.
  DEMO_CREDIT_HOURLY: '11', DEMO_CREDIT_DAILY: '100',
};
const boot = (label, env = {}) => startGateServer({ port: PORT, dataDir: SCRATCH, label, env: { ...baseEnv, ...env }, ...(CWD ? { cwd: CWD } : {}) });

function socket(cookie = null) {
  const ws = new WebSocket(WS_URL, cookie ? { headers: { Cookie: cookie } } : {});
  ws.msgs = [];
  ws.on('message', (raw) => { try { ws.msgs.push({ ...JSON.parse(raw.toString()), _t: Date.now() }); } catch { /* not json */ } });
  return new Promise((resolve, reject) => { ws.on('open', () => resolve(ws)); ws.on('error', reject); });
}
const send = (ws, m) => ws.send(JSON.stringify(m));
const last = (ws, type, pred = () => true) => [...ws.msgs].reverse().find((m) => m.type === type && pred(m));
const register = async (ws, roomId) => {
  send(ws, { type: 'subscribe_room', room: roomId });
  send(ws, { type: 'rewards_register', roomId });
  send(ws, { type: 'rewards_visibility', visible: true });
  await sleep(400);
  return last(ws, 'rewards_config');
};
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(100); } return fn(); };
const post = (p, body, headers = {}) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const put = (p, buf, type) => fetch(`${APP}${p}`, { method: 'PUT', headers: { 'Content-Type': type }, body: buf })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const asA = { Cookie: auth.cookieFor('demoa') };
const asB = { Cookie: auth.cookieFor('demob') };
const ledgerRows = (name) => {
  const f = path.join(SCRATCH, name);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];
};
const demoIssued = () => ledgerRows('rewards-ledger.jsonl').filter((r) => r.type === 'EARN' && r.house === 'demo').reduce((a, r) => a + BigInt(r.amountAtomic), 0n);
const balanceOf = (ws) => {
  const m = [...ws.msgs].reverse().find((x) => (x.type === 'rewards_balance' || x.type === 'rewards_earned' || x.type === 'rewards_config') && x.joinBalance != null);
  return m ? Number(m.joinBalance) : null;
};

let srv = null, crashed = null;
const sockets = [];
try {
  srv = await boot('demo-money');
  const demoCfg = await fetch(`${APP}/api/config?room=demo`).then((r) => r.json());
  const demoId = demoCfg.roomId;
  ok('D1. the demo room is seeded at /demo', !!demoId && demoCfg.isDemo === true, demoId);
  ok('D1. ...Call in $0.10 a second up to $10, Holler $0.50 for the longest 10 s clip',
    Number(demoCfg.passkeyTickPrice) === 0.1 && Number(demoCfg.passkeyTickSeconds) === 1 && Number(demoCfg.maxSession) === 10 && Number(demoCfg.letters?.price) === 0.5 && Number(demoCfg.letters?.maxSeconds) === 10,
    `tick ${demoCfg.passkeyTickPrice}/${demoCfg.passkeyTickSeconds}s, max ${demoCfg.maxSession}, holler ${demoCfg.letters?.price}/${demoCfg.letters?.maxSeconds}s`);

  // ── D2: earning, signed in only ───────────────────────────────────────────
  const anon = await socket(); sockets.push(anon);
  const cAnon = await register(anon, demoId);
  ok('D2. a signed-out viewer is told to sign in, and earns nothing', cAnon?.enabled === false && cAnon?.reason === 'sign_in_required', cAnon?.reason);

  const a = await socket(asA.Cookie); sockets.push(a);
  const cA = await register(a, demoId);
  ok('D1. the demo pays $1 every 1 s, up to $10, as seat credit (never cash, nothing on chain)',
    cA?.enabled === true && cA.earnInterval === 1 && Number(cA.earnAmount) === 1 && Number(cA.earnCap) === 10 && cA.payout === 'credit' && cA.dryRun === true,
    JSON.stringify(cA && { on: cA.enabled, why: cA.reason, i: cA.earnInterval, a: cA.earnAmount, c: cA.earnCap, p: cA.payout }));
  ok('D1. ...held by a placeholder wallet, with no payout wallet asked for', cA?.demo === true && /^0x[0-9a-f]{40}$/i.test(cA?.payee || ''), cA?.payee || cA?.reason);
  const payeeA = cA?.payee;
  const grants = await waitFor(() => { const g = a.msgs.filter((m) => m.type === 'rewards_earned' && m.credited); return g.length >= 10 && a.msgs.some((m) => m.type === 'rewards_earned' && m.capped) ? g : null; }, 15_000)
    || a.msgs.filter((m) => m.type === 'rewards_earned' && m.credited);
  const gaps = grants.slice(1).map((g, i) => g._t - grants[i]._t).sort((x, y) => x - y);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  ok('D2. earning ticks every second: ten $1 grants about 1 s apart', grants.length === 10 && grants.every((g) => Number(g.credited) === 1) && median != null && median >= 700 && median <= 1400,
    `${grants.length} grants, median gap ${median} ms`);
  await sleep(2200);
  const after = a.msgs.filter((m) => m.type === 'rewards_earned' && m.credited).length;
  const capMsg = last(a, 'rewards_earned', (m) => m.capped);
  ok('D2. ...and stops at the $10 cap', after === 10 && Number(capMsg?.earned) === 10 && balanceOf(a) === 10, `${after} grants, earned ${capMsg?.earned}, balance ${balanceOf(a)}`);

  // ── D3: real money is refused in the demo ─────────────────────────────────
  const realSeat = await post('/api/join/mpp', { username: 'realmoney', address: payeeA, room: demoId }, asA);
  ok('D3. a Call in with real money is refused in the demo', realSeat.status === 402 && realSeat.body.reason === 'demo_money_only', `${realSeat.status} ${realSeat.body.reason}`);
  const realHoller = await post('/api/letter/submit', { room: demoId, username: 'realmoney', address: payeeA, durationS: 10, mime: 'video/webm' }, asA);
  ok('D3. ...and so is a Holler paid with real money', realHoller.status === 402 && realHoller.body.reason === 'demo_money_only', `${realHoller.status} ${realHoller.body.reason}`);

  // ── D4: a Holler on demo money, refunded on reject ────────────────────────
  const stolen = await post('/api/letter/submit', { room: demoId, username: 'thief', address: payeeA, durationS: 10, mime: 'video/webm', useRewardCredit: true }, asB);
  ok('D4. another account cannot spend this viewer\'s demo money', stolen.status === 403 && stolen.body.reason === 'credit_not_yours', `${stolen.status} ${stolen.body.reason}`);
  const holler = await post('/api/letter/submit', { room: demoId, username: 'demoa', address: payeeA, durationS: 10, mime: 'video/webm', useRewardCredit: true }, asA);
  ok('D4. a 10 s Holler is sent on demo money: exactly $0.50, no wallet, no MPP', holler.status === 200 && !!holler.body.letterId && Number(holler.body.price) === 0.5, `${holler.status} ${holler.body.price ?? holler.body.error}`);
  const afterHoller = await waitFor(() => (balanceOf(a) === 9.5 ? 9.5 : null), 2000) ?? balanceOf(a);
  ok('D4. ...the page is told the new balance: $9.50', afterHoller === 9.5, String(afterHoller));
  const up = await put(`/api/letter/upload/${holler.body.letterId}`, Buffer.alloc(4096, 1), 'video/webm');
  ok('D4. ...the clip uploads and queues', up.status === 200 && up.body.status === 'queued', `${up.status} ${up.body.status ?? up.body.error}`);
  const rej = await post(`/api/dashboard/rooms/${demoId}/letters/${holler.body.letterId}/reject`, {}, { 'x-room-password': DEMO_PW });
  const afterReject = await waitFor(() => (balanceOf(a) === 10 ? 10 : null), 2000) ?? balanceOf(a);
  ok('D4. a rejected demo Holler gives the $0.50 back to the demo money', rej.status === 200 && rej.body.refunded === true && afterReject === 10, `${rej.status} refunded ${rej.body.refunded}, balance ${afterReject}`);
  const doorRows = ledgerRows('settlement.jsonl').filter((r) => String(r.ref || '').includes(holler.body.letterId || 'none'));
  ok('D4. ...and the settlement door never saw it (no refund intent)', doorRows.length === 0, `${doorRows.length} door row(s)`);

  // ── D5: a Call in on demo money, on the MPP route ─────────────────────────
  const seat = await post('/api/join/mpp', { username: 'demoa', address: payeeA, room: demoId, useRewardCredit: true }, asA);
  ok('D5. a Call in seat is granted on demo money on the MPP route (credit_stream, $10 cap)', seat.status === 200 && seat.body.paymentMode === 'credit_stream' && Number(seat.body.remaining) === 10, `${seat.status} ${seat.body.paymentMode ?? seat.body.reason ?? seat.body.error} ${seat.body.remaining ?? ''}`);
  const atJoin = await waitFor(() => (balanceOf(a) === 0 ? 0 : null), 2000) ?? balanceOf(a);
  ok('D5. ...the cap left the demo money at the join ($0 left to spend)', atJoin === 0, String(atJoin));
  if (seat.body.seatId) {
    send(a, { type: 'register_seat', seatId: seat.body.seatId, seatToken: seat.body.seatToken });
    send(a, { type: 'camera_ready', seatId: seat.body.seatId, seatToken: seat.body.seatToken });
    await sleep(3600);
    const meters = a.msgs.filter((m) => m.type === 'meter_update' && m.seatId === seat.body.seatId);
    const lastMeter = meters[meters.length - 1];
    ok('D5. live, the seat meter spends demo money at $0.10 a second', meters.length >= 2 && Number(lastMeter.spent) >= 0.2 && Math.abs(Number(lastMeter.remaining) + Number(lastMeter.spent) - 10) < 1e-9,
      `${meters.length} updates, spent ${lastMeter?.spent}, remaining ${lastMeter?.remaining}`);
    const left = await post(`/api/leave/${seat.body.seatId}`, { seatToken: seat.body.seatToken });
    await sleep(800);
    const finalMeter = a.msgs.filter((m) => m.type === 'meter_update' && m.seatId === seat.body.seatId).pop();
    const back = await waitFor(() => (balanceOf(a) > 0 ? balanceOf(a) : null), 2000) ?? balanceOf(a);
    ok('D5. leaving gives the unspent demo money back to the balance', left.status === 200 && Math.abs(back - Number(finalMeter?.remaining)) < 1e-9 && back > 9 && back < 10, `left ${left.status}, back ${back}, last remaining ${finalMeter?.remaining}`);
  }

  // ── D6 / D7: the house budget, and a seat that runs out ───────────────────
  const b = await socket(asB.Cookie); sockets.push(b);
  await register(b, demoId);
  const budgetStop = await waitFor(() => last(b, 'rewards_config', (m) => m.reason === 'demo_budget_hour'), 5000);
  const bGrants = b.msgs.filter((m) => m.type === 'rewards_earned' && m.credited);
  ok('D6. the house budget stops grants at the hourly limit: the second viewer got $1 ($11 - $10), then paused',
    !!budgetStop && bGrants.length === 1 && Number(bGrants[0].credited) === 1 && demoIssued() === 11_000_000n, `${bGrants.length} grant(s), issued ${demoIssued()} atomic, ${budgetStop?.reason}`);
  ok('D6. ...the paused state still carries the balance to spend', budgetStop?.joinBalance != null && Number(budgetStop.joinBalance) === 1, budgetStop?.joinBalance);
  const c = await socket(auth.cookieFor('democ')); sockets.push(c);
  const cC = await register(c, demoId);
  await sleep(2200);
  ok('D6. a third viewer is paused from the start and earns nothing', cC?.enabled === false && cC?.reason === 'demo_budget_hour' && !c.msgs.some((m) => m.type === 'rewards_earned' && m.credited), cC?.reason);

  const bSeat = await post('/api/join/mpp', { username: 'demob', address: last(b, 'rewards_config')?.payee, room: demoId, useRewardCredit: true }, asB);
  ok('D7. a Call in with $1 of demo money is granted ($1 cap)', bSeat.status === 200 && Number(bSeat.body.remaining) === 1, `${bSeat.status} ${bSeat.body.remaining ?? bSeat.body.reason}`);
  if (bSeat.body.seatId) {
    send(b, { type: 'register_seat', seatId: bSeat.body.seatId, seatToken: bSeat.body.seatToken });
    send(b, { type: 'camera_ready', seatId: bSeat.body.seatId, seatToken: bSeat.body.seatToken });
    const gone = await waitFor(() => b.msgs.find((m) => m.type === 'seat_removed' && m.seatId === bSeat.body.seatId), 16_000);
    const meters = b.msgs.filter((m) => m.type === 'meter_update' && m.seatId === bSeat.body.seatId);
    ok('D7. the seat stops when the demo money runs out (ten $0.10 ticks, then out of funds)',
      !!gone && /out_of_funds/.test(String(gone.reason)) && Number(meters[meters.length - 1]?.remaining) === 0, `${gone?.reason}, ${meters.length} ticks, last remaining ${meters[meters.length - 1]?.remaining}`);
  }

  // ── D9: a non-demo room is unchanged ──────────────────────────────────────
  const n1 = await register(await socket(asA.Cookie).then((s) => (sockets.push(s), s)), creditRoom.id);
  ok('D9. a non-demo credit room storing the demo\'s terms still gets the operator bounds: 60 s, $0.01, cap $0.1',
    n1?.earnInterval === 60 && Number(n1.earnAmount) === 0.01 && Number(n1.earnCap) === 0.1 && n1.payout === 'credit', JSON.stringify(n1 && { i: n1.earnInterval, a: n1.earnAmount, c: n1.earnCap, why: n1.reason }));
  ok('D9. ...and still asks for a payout wallet (no placeholder outside the demo)', n1?.enabled === false && n1?.reason === 'payout_wallet_required', n1?.reason);
  const n2 = await register(await socket(asA.Cookie).then((s) => (sockets.push(s), s)), fakeDemo.id);
  ok('D9. a room that only stores isDemo is not the demo: bounds apply', n2?.earnInterval === 60 && Number(n2.earnAmount) === 0.01 && !n2.demo, JSON.stringify(n2 && { i: n2.earnInterval, a: n2.earnAmount, demo: n2.demo }));
  const n3 = await register(await socket(asA.Cookie).then((s) => (sockets.push(s), s)), cashRoom.id);
  ok('D9. cash rules unchanged: a password-only room never pays cash', n3?.payout === 'cash' && n3?.reason === 'password_room', `${n3?.payout} ${n3?.reason}`);

  // ── D10: never listed as withdrawable ─────────────────────────────────────
  const acct = await fetch(`${APP}/api/account/rewards`, { headers: asA }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const listed = (acct.body.rooms || []).filter((r) => r.roomId === demoId);
  ok('D10. the account\'s Rewards section does not list demo money', acct.status === 200 && listed.length === 0, `${acct.status}, ${listed.length} demo row(s)`);

  // ── D8: the budget survives a restart ─────────────────────────────────────
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  sockets.length = 0;
  srv.kill(); srv = null;
  await sleep(1500);
  srv = await boot('demo-money-restart');
  const c2 = await socket(auth.cookieFor('democ')); sockets.push(c2);
  const r2 = await register(c2, demoId);
  await sleep(2200);
  ok('D8. AFTER A RESTART the hourly budget still holds: a viewer who never earned is paused, nothing issued',
    r2?.enabled === false && r2?.reason === 'demo_budget_hour' && demoIssued() === 11_000_000n, `${r2?.reason}, issued ${demoIssued()}`);
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  sockets.length = 0;
  srv.kill(); srv = null;
  await sleep(1500);
  srv = await boot('demo-money-daily', { DEMO_CREDIT_HOURLY: '100', DEMO_CREDIT_DAILY: '11' });
  const c3 = await socket(auth.cookieFor('democ')); sockets.push(c3);
  const r3 = await register(c3, demoId);
  ok('D8. the daily limit, read from the same ledger, pauses with its own reason', r3?.enabled === false && r3?.reason === 'demo_budget_day', r3?.reason);

  // ── D11: the cap is per visit ─────────────────────────────────────────────
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  sockets.length = 0;
  srv.kill(); srv = null;
  await sleep(1500);
  srv = await boot('demo-money-visits', { DEMO_CREDIT_HOURLY: '1000', DEMO_CREDIT_DAILY: '1000', DEMO_VISIT_GRACE_MS: '3000' });
  const credited = (ws) => ws.msgs.filter((m) => m.type === 'rewards_earned' && m.credited).length;
  const d1 = await socket(auth.cookieFor('demod')); sockets.push(d1);
  await register(d1, demoId);
  await waitFor(() => d1.msgs.some((m) => m.type === 'rewards_earned' && m.capped), 15_000);
  ok('D11. a visit earns to the $10 cap', credited(d1) === 10, `${credited(d1)} grants`);
  d1.close(); await sleep(800);
  const d2 = await socket(auth.cookieFor('demod')); sockets.push(d2);
  const back = await register(d2, demoId);
  await sleep(2200);
  ok('D11. back within the grace (a refresh): still maxed, nothing more earned', Number(back?.earned) === 10 && credited(d2) === 0, `earned ${back?.earned}, ${credited(d2)} grants`);
  d2.close(); await sleep(4000);
  const d3 = await socket(auth.cookieFor('demod')); sockets.push(d3);
  const fresh = await register(d3, demoId);
  const again = await waitFor(() => (credited(d3) >= 2 ? credited(d3) : null), 6000) ?? credited(d3);
  ok('D11. left past the grace: a new visit starts at $0 and earns again', Number(fresh?.earned) === 0 && again >= 2, `earned at return ${fresh?.earned}, ${again} grants`);
} catch (e) {
  crashed = e;
} finally {
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  if ((fail || crashed) && srv) { console.log('--- server output (tail) ---'); console.log(srv.stderr().slice(-3000)); }
  srv?.kill();
  await rpc.close();
  await sleep(1500);
}
if (crashed) { console.log(`\nGATE CRASHED: ${crashed.stack || crashed}`); process.exit(1); }
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
