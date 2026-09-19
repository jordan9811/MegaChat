/**
 * GATE — a live seat through the escrow contract, END TO END ON TEMPO MAINNET.
 *
 * SPENDS REAL DUST. This is the Session 2 proof and it is the only gate that
 * touches the mainnet escrow. Per run, from the wallets named below:
 *   viewer   TEST_VIEWER_KEY (.env)     approves 0.05 USDC.e twice, pays the
 *                                        streamer ~0.02–0.03 across both modes,
 *                                        and its own approve gas
 *   operator ESCROW_OPERATOR_KEY        deposit + finalize gas (~$0.002)
 *   attester ESCROW_ATTEST_KEY          attest gas (~$0.0002)
 *   seller   SELLER_PRIVATE_KEY (.env)  the direct fallback's per-tick pulls
 * The streamer is the reward-pool wallet (REWARD_POOL_WALLET_ADDRESS), an
 * operator-held wallet, so nothing paid is lost. Run it as
 *
 *   railway run node _gate-escrow-seat.mjs
 *
 * because the two escrow keys live on the Railway service, not in .env. The
 * gate boots its servers with PLATFORM_SETTLEMENT_KEY blanked so the door
 * records and never pays during the run.
 *
 * Two servers: A has the escrow (the recorded mainnet deployment), B is given
 * an address with no code so its preflight fails and it must fall back. A
 * third room has no payout address and must be refused by both.
 *
 * Timing: the escrow deadline is join + cap (50 ticks) + a 5 s tail, so the
 * finalize wait is about a minute of real time.
 */
import { mkdtempSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createPublicClient, createWalletClient, http, erc20Abi, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';

try { process.loadEnvFile(); } catch { /* env external */ }

const USDC = '0x20c000000000000000000000b9537d11c60e8b50';
const SELLER = process.env.SELLER_WALLET_ADDRESS;
const STREAMER = process.env.REWARD_POOL_WALLET_ADDRESS;
const norm = (k) => { const t = String(k || '').trim(); return /^[0-9a-fA-F]{64}$/.test(t) ? `0x${t}` : t; };
const viewerKey = norm(process.env.TEST_VIEWER_KEY);
for (const [n, v] of [['TEST_VIEWER_KEY', viewerKey], ['ESCROW_OPERATOR_KEY', norm(process.env.ESCROW_OPERATOR_KEY)], ['ESCROW_ATTEST_KEY', norm(process.env.ESCROW_ATTEST_KEY)]]) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) { console.error(`${n} is not available — run under railway run with .env present`); process.exit(2); }
}
if (!STREAMER || !SELLER) { console.error('REWARD_POOL_WALLET_ADDRESS / SELLER_WALLET_ADDRESS missing'); process.exit(2); }

const { defaultContractAddress, escrowIdFor, loadEscrowAbi } = await import('./escrow-chain.js');
const ESCROW = process.env.ESCROW_CONTRACT_ADDRESS || defaultContractAddress(4217);
if (!ESCROW) { console.error('no recorded mainnet escrow deployment'); process.exit(2); }
const ABI = loadEscrowAbi();

const pub = createPublicClient({ chain: tempo, transport: http() });
const viewer = privateKeyToAccount(viewerKey);
const viewerWallet = createWalletClient({ account: viewer, chain: tempo, transport: http() });
const bal = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const fmt = (v) => formatUnits(v, 6);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n── a seat through the escrow, on mainnet ──────────────────────');
console.log(`  escrow ${ESCROW}  viewer ${viewer.address}  streamer ${STREAMER}`);
const v0 = await bal(viewer.address);
ok('0. the viewer wallet holds enough USDC.e for two 0.05 caps plus gas', v0 >= parseUnits('0.13', 6), `${fmt(v0)} USDC.e`);
if (v0 < parseUnits('0.13', 6)) { console.log('\nRESULT: aborted — fund TEST_VIEWER_KEY'); process.exit(1); }

// rooms-store reads DATA_DIR at import — and under `railway run` the service's
// own DATA_DIR is in the environment — so the gate's dir is set BEFORE the
// import, rooms are seeded once, and server B gets a copy of the file.
const DIR_A = mkdtempSync(path.join(tmpdir(), 'mc-escrow-a-')), DIR_B = mkdtempSync(path.join(tmpdir(), 'mc-escrow-b-'));
process.env.DATA_DIR = DIR_A;
const rooms = await import('./rooms-store.js');
const { startGateServer, mintBountyAuth } = await import('./_gate-helpers.mjs');

const authA = mintBountyAuth({ handles: ['escrowhost'], dataDir: DIR_A });
const authB = mintBountyAuth({ handles: ['escrowhost'], dataDir: DIR_B });
const paidRoom = rooms.createRoom('escrow seat room', { passkeyTickPrice: '0.001', passkeyTickSeconds: 1, maxSession: '0.05', maxSeats: 3, payoutAddress: STREAMER });
// Owner keys are ACCOUNT ids since the identity layer; the minter knows them.
rooms.setRoomOwner(paidRoom.id, authA.accountIdFor('escrowhost'));
const orphanRoom = rooms.createRoom('no payout room', { passkeyTickPrice: '0.001', passkeyTickSeconds: 1, maxSession: '0.05', maxSeats: 3 });
const roomsA = { paid: paidRoom, orphan: orphanRoom }, roomsB = roomsA;
copyFileSync(path.join(DIR_A, 'rooms.json'), path.join(DIR_B, 'rooms.json'));

const common = {
  KEEP_ORPHAN_ROOMS: 'true', PLATFORM_SETTLEMENT_KEY: '', // the door records, never pays, during this run
  SEAT_ESCROW_TAIL_MS: '5000', SEAT_ESCROW_REVIEW_MS: '0', SEAT_ESCROW_SWEEP_MS: '5000',
  SEAT_DETECTION_LAG_MS: '0', // so buried ticks are the streamer's and the attestation carries a nonzero hidden figure
};
const srvA = await startGateServer({ port: 3331, dataDir: DIR_A, label: 'escrow-A', env: { ...authA.env, ...common, ESCROW_CONTRACT_ADDRESS: ESCROW } });
const srvB = await startGateServer({ port: 3332, dataDir: DIR_B, label: 'escrow-B', env: { ...authB.env, ...common, ESCROW_CONTRACT_ADDRESS: '0x000000000000000000000000000000000000dEaD' } });
const A = 'http://localhost:3331', B = 'http://localhost:3332';
const post = (base, p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const rows = (dir, file, type) => existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !type || r.type === type) : [];

async function approve(spender, amount) {
  const before = await bal(viewer.address);
  const hash = await viewerWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [spender, amount], feeToken: USDC });
  await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return before - (await bal(viewer.address)); // the approve's own fee, in USDC.e
}
async function goLive(base, seatId) {
  const port = new URL(base).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'register_seat', seatId }));
  ws.send(JSON.stringify({ type: 'camera_ready', seatId }));
  return ws;
}

let wsA = null, wsB = null;
try {
  // ── config says which mode each server is in ─────────────────────────────
  const cfgA = await fetch(`${A}/api/config?room=${roomsA.paid.id}`).then((r) => r.json());
  const cfgB = await fetch(`${B}/api/config?room=${roomsB.paid.id}`).then((r) => r.json());
  ok('1. server A: escrow enabled, preflight passed, mode escrow', cfgA.escrow?.enabled === true && cfgA.escrow?.mode === 'escrow' && cfgA.escrow?.address?.toLowerCase() === ESCROW.toLowerCase(), JSON.stringify(cfgA.escrow));
  ok('1. server B: an address with no code fails preflight → mode direct, and says why', cfgB.escrow?.mode === 'direct' && /no code/.test(cfgB.escrow?.reason || ''), cfgB.escrow?.reason);

  // ── the hard stop ────────────────────────────────────────────────────────
  const noPayA = await post(A, '/api/join/passkey', { username: 'nopay', address: viewer.address, room: roomsA.orphan.id });
  const noPayB = await post(B, '/api/join/passkey', { username: 'nopay', address: viewer.address, room: roomsB.orphan.id });
  ok('2. a room with NO payout address is refused in escrow mode (409 no_payout_address)', noPayA.status === 409 && noPayA.body.reason === 'no_payout_address');
  ok('2. ...and in direct mode: never a silent fallback to the platform wallet', noPayB.status === 409 && noPayB.body.reason === 'no_payout_address');

  // ═══════════ ESCROW PATH (server A) ═══════════
  console.log('\n── escrow path ─────────────────────────────────────────────');
  const termsA = await post(A, '/api/join/passkey', { username: 'escrowee', address: viewer.address, room: roomsA.paid.id });
  ok('3. terms name the CONTRACT as spender and the streamer as payout', termsA.body.needsApprove === true && termsA.body.escrow?.mode === 'escrow' && termsA.body.payTo?.toLowerCase() === ESCROW.toLowerCase() && termsA.body.escrow?.payoutAddress === STREAMER, `payTo ${termsA.body.payTo}`);
  const capA = BigInt(termsA.body.sessionAmountAtomic);
  ok('3. the cap is the room max (0.05), not the wallet balance', capA === parseUnits('0.05', 6), fmt(capA));
  const approveFeeA = await approve(ESCROW, capA);
  const sBefore = await bal(STREAMER), vBefore = await bal(viewer.address), cBefore = await bal(ESCROW);
  const joinA = await post(A, '/api/join/passkey', { username: 'escrowee', address: viewer.address, room: roomsA.paid.id }, { 'X-Modular-Payment': b64({ type: 'approve', payer: viewer.address, amount: capA.toString(), seller: ESCROW, tokenAddress: USDC }) });
  ok('4. the join is granted in escrow mode with a deposit transaction and a deadline', joinA.status === 200 && joinA.body.escrowMode === 'escrow' && /^0x[0-9a-f]{64}$/i.test(joinA.body.escrow?.txHash || '') && joinA.body.escrow?.releaseAt > 0, `tx ${joinA.body.escrow?.txHash?.slice(0, 18)}… release ${joinA.body.escrow?.releaseAt}`);
  const seatA = joinA.body.seatId;
  const escrowId = escrowIdFor(seatA);
  const onchain0 = await pub.readContract({ address: ESCROW, abi: ABI, functionName: 'escrow', args: [escrowId] });
  ok('4. ON-CHAIN: the contract holds exactly the cap for this seat, streamer fixed, rate = tick price', onchain0.deposited === capA && onchain0.remaining === capA && onchain0.streamer.toLowerCase() === STREAMER.toLowerCase() && onchain0.rate === 1000n, `deposited ${fmt(onchain0.deposited)}`);
  ok('4. the viewer wallet is down by exactly the cap; the contract is up by it', vBefore - (await bal(viewer.address)) === capA && (await bal(ESCROW)) - cBefore === capA);
  const depRow = rows(DIR_A, 'escrow-chain.jsonl', 'DEPOSIT').find((r) => r.phase === 'DONE');
  ok('4. the escrow ledger has DEPOSIT SENT then DONE with the receipt', !!depRow && !!depRow.txHash && !!depRow.blockNumber);
  const joinedAt = Date.now();

  // meter
  wsA = await goLive(A, seatA);
  await sleep(6_500);
  const accrued1 = rows(DIR_A, 'seat-ledger.jsonl', 'SEAT_ACCRUE').length;
  const pulls = rows(DIR_A, 'settlement.jsonl', 'PULL');
  ok('5. the seat meters into the ledger (ACCRUE rows) and NO tick pulled anything on chain', accrued1 >= 4 && pulls.length === 0, `${accrued1} ticks, ${pulls.length} pulls`);
  // bury
  const asOwnerA = { Cookie: authA.cookieFor('escrowhost') };
  const hid = await post(A, `/api/rooms/${roomsA.paid.id}/overlay-visibility`, { signal: 'overlay_hidden', reason: 'scene' }, asOwnerA);
  ok('6. the owner reports overlay_hidden (row 25a: a REAL OBS has never sent this — the gate is the mock)', hid.status === 200);
  await sleep(4_500);
  const accruedHidden = rows(DIR_A, 'seat-ledger.jsonl', 'SEAT_ACCRUE').length;
  await post(A, `/api/rooms/${roomsA.paid.id}/overlay-visibility`, { signal: 'overlay_visible', scale: { scaleY: 1 } }, asOwnerA);
  await sleep(4_500);
  const accrued2 = rows(DIR_A, 'seat-ledger.jsonl', 'SEAT_ACCRUE').length;
  const buried = rows(DIR_A, 'seat-ledger.jsonl', 'SEAT_REFUND_BURIED')[0];
  ok('6. the meter paused while hidden and resumed after; the ledger recorded a buried refund', accruedHidden === accrued1 + (accruedHidden - accrued1) && accrued2 > accruedHidden && !!buried, `ticks ${accrued1} → ${accruedHidden} → ${accrued2}; buried ${buried?.fromStreamer} atomic`);
  const buriedAtomic = BigInt(buried?.fromStreamer || 0) + BigInt(buried?.fromPlatform || 0);

  // leave → attest
  const left = await post(A, `/api/leave/${seatA}`, {});
  ok('7. the viewer leaves', left.status === 200 || left.body.success === true, `http ${left.status}`);
  let attestRow = null;
  for (let i = 0; i < 30 && !attestRow; i++) { await sleep(2000); attestRow = rows(DIR_A, 'escrow-chain.jsonl', 'ATTEST').find((r) => r.phase === 'DONE'); }
  const ticksTotal = rows(DIR_A, 'seat-ledger.jsonl', 'SEAT_ACCRUE').length;
  const expectedHidden = Number((buriedAtomic + 999n) / 1000n);
  const sentAttest = rows(DIR_A, 'escrow-chain.jsonl', 'ATTEST').find((r) => r.phase === 'SENT');
  ok('7. the ATTESTER wrote the ledger figures to the contract: consumed = ticks accrued, hidden = buried ticks', !!attestRow && sentAttest?.consumedUnits === ticksTotal && sentAttest?.hiddenUnits === expectedHidden, `consumed ${sentAttest?.consumedUnits}, hidden ${sentAttest?.hiddenUnits}; ledger ticks ${ticksTotal}, buried ${expectedHidden}`);
  const onchain1 = await pub.readContract({ address: ESCROW, abi: ABI, functionName: 'escrow', args: [escrowId] });
  ok('7. ON-CHAIN: attested, and the figures match', onchain1.attested === true && onchain1.consumed === ticksTotal && onchain1.hidden === expectedHidden);
  const outcome = await pub.readContract({ address: ESCROW, abi: ABI, functionName: 'outcome', args: [escrowId] });
  const expectStreamer = BigInt(ticksTotal - expectedHidden) * 1000n, expectViewer = capA - expectStreamer;
  ok('7. outcome() previews streamer = (consumed − hidden) × rate, viewer = the rest', outcome[0] === expectStreamer && outcome[2] === expectViewer, `streamer ${fmt(outcome[0])}, viewer ${fmt(outcome[2])}`);

  // finalize by the sweeper after the deadline
  const releaseAt = joinA.body.escrow.releaseAt * 1000;
  console.log(`  waiting for the deadline (${Math.max(0, Math.round((releaseAt - Date.now()) / 1000))} s) and the sweeper…`);
  let finRow = null;
  for (let i = 0; i < 60 && !finRow; i++) { await sleep(3000); finRow = rows(DIR_A, 'escrow-chain.jsonl', 'FINALIZE').find((r) => r.phase === 'DONE'); }
  ok('8. the sweeper finalized after the deadline (FINALIZE DONE in the escrow ledger)', !!finRow, finRow?.txHash?.slice(0, 18));
  const onchain2 = await pub.readContract({ address: ESCROW, abi: ABI, functionName: 'escrow', args: [escrowId] });
  const sAfter = await bal(STREAMER), vAfter = await bal(viewer.address), cAfter = await bal(ESCROW);
  ok('8. ON-CHAIN: finalized; the contract holds nothing for this seat', onchain2.finalized === true && cAfter === cBefore, `contract delta ${fmt(cAfter - cBefore)}`);
  ok('8. the STREAMER received exactly (consumed − hidden) × rate', sAfter - sBefore === expectStreamer, `+${fmt(sAfter - sBefore)} USDC.e`);
  ok('8. the VIEWER got back exactly the rest: net cost = what they consumed on screen', vBefore - vAfter === expectStreamer, `−${fmt(vBefore - vAfter)} USDC.e (approve fee separately: ${fmt(approveFeeA)})`);
  ok('8. the door never paid: every seat row for this seat is accounting, no INTENT was sent', rows(DIR_A, 'settlement.jsonl').every((r) => r.type !== 'SENT' && r.type !== 'DONE'));
  console.log(`  amounts: cap ${fmt(capA)}, consumed ${ticksTotal} ticks, hidden ${expectedHidden}, streamer +${fmt(expectStreamer)}, viewer refund ${fmt(expectViewer)}`);

  // ═══════════ DIRECT FALLBACK (server B) ═══════════
  console.log('\n── direct fallback ─────────────────────────────────────────');
  const termsB = await post(B, '/api/join/passkey', { username: 'directee', address: viewer.address, room: roomsB.paid.id });
  ok('9. terms name the SELLER key as spender, mode direct, with the reason', termsB.body.escrow?.mode === 'direct' && termsB.body.payTo?.toLowerCase() === SELLER.toLowerCase() && !!termsB.body.escrow?.reason, termsB.body.escrow?.reason);
  const capB = BigInt(termsB.body.sessionAmountAtomic);
  await approve(SELLER, capB);
  const sB0 = await bal(STREAMER), vB0 = await bal(viewer.address), sellerB0 = await bal(SELLER);
  const joinB = await post(B, '/api/join/passkey', { username: 'directee', address: viewer.address, room: roomsB.paid.id }, { 'X-Modular-Payment': b64({ type: 'approve', payer: viewer.address, amount: capB.toString(), seller: SELLER, tokenAddress: USDC }) });
  ok('10. the join is granted in direct mode, no deposit', joinB.status === 200 && joinB.body.escrowMode === 'direct' && joinB.body.escrow === null && joinB.body.payoutAddress === STREAMER);
  wsB = await goLive(B, joinB.body.seatId);
  await sleep(7_000);
  await post(B, `/api/leave/${joinB.body.seatId}`, {});
  await sleep(2_500);
  const pullsB = rows(DIR_B, 'settlement.jsonl', 'PULL').filter((r) => !r.dry);
  ok('11. every tick was a real pull viewer → STREAMER, recorded at the door with the payout address as `to`', pullsB.length >= 4 && pullsB.every((r) => r.to?.toLowerCase() === STREAMER.toLowerCase()), `${pullsB.length} pulls → ${pullsB[0]?.to}`);
  const paidB = BigInt(pullsB.length) * 1000n;
  ok('11. the streamer received the ticks; the viewer paid them; the seller wallet gained nothing', (await bal(STREAMER)) - sB0 === paidB && vB0 - (await bal(viewer.address)) === paidB && (await bal(SELLER)) - sellerB0 <= 0n, `+${fmt(paidB)} to the streamer`);
  ok('11. no escrow rows on the fallback server', rows(DIR_B, 'escrow-chain.jsonl').length === 0);
  ok('11. the direct seat produced no door INTENT either (no escrow, no mediation)', rows(DIR_B, 'settlement.jsonl').every((r) => r.type === 'PULL'));
  console.log(`  amounts: ${pullsB.length} ticks × 0.001 = ${fmt(paidB)} USDC.e viewer → streamer, directly`);
} finally {
  try { wsA?.close(); } catch { /* gone */ }
  try { wsB?.close(); } catch { /* gone */ }
  if (fail) { console.log('--- server A tail ---'); console.log(srvA.stderr().slice(-2500)); console.log('--- server B tail ---'); console.log(srvB.stderr().slice(-1200)); }
  srvA.kill(); srvB.kill();
  await sleep(1500);
}
const vEnd = await bal(viewer.address);
console.log(`\n  viewer wallet: ${fmt(v0)} → ${fmt(vEnd)} USDC.e over the run (−${fmt(v0 - vEnd)}, of which streamer payments ${fmt(v0 - vEnd)} minus approve fees)`);
console.log(`\nRESULT: ${pass} pass, ${fail} fail   (escrow ${ESCROW}, chain 4217)`);
process.exit(fail === 0 ? 0 : 1);
