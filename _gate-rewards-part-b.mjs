/**
 * Part B rewards gate — optional per-room rewards must not break pay-to-join.
 *
 * Booted through startGateServer (verify-money N3): a scratch DATA_DIR, so
 * the repo's data/ is never written; a readiness poll and a nonce instead of
 * a fixed sleep; and every signer key from .env BLANKED, with TEMPO_RPC_URL on
 * a read-only 127.0.0.1 stand-in, so even a USDC case added here could not
 * sign a real transfer. It used to spawn server.js bare with the local .env.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startGateServer } from './_gate-helpers.mjs';
import { startRpcStandIn, readOnlyTokenNode } from './_gate-rpc-standin.mjs';

const PORT = Number(process.env.GATE_PORT || 3348);
// localhost, not 127.0.0.1: server.js 301s 127.0.0.1 to localhost, and fetch
// turns a redirected POST into a GET (every create here 404'd that way).
const BASE = `http://localhost:${PORT}`;
const ROOM_PW = process.env.GATE_ROOM_PASSWORD || 'rewards-gate-secret';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const TEST_WALLET = '0x0000000000000000000000000000000000000001';
const fails = [];

function ok(m) { console.log('  ✓', m); }
function fail(m) { fails.push(m); console.error('  ✗', m); }

const rpc = await startRpcStandIn(readOnlyTokenNode());
let srv = null;
try {
  srv = await startGateServer({
    port: PORT, label: 'rewards-part-b',
    dataDir: mkdtempSync(path.join(tmpdir(), 'mc-gate-rewards-b-')),
    // Every live key starts blank (startGateServer, SENSITIVE_ENV).
    env: { ROOM_DEFAULT_PASSWORD: 'changeme', KEEP_ORPHAN_ROOMS: 'true', TEMPO_RPC_URL: rpc.url },
  });
} catch (e) {
  fail('boot: ' + e.message);
}

if (srv) try {
  for (const p of ['/dashboard', '/', '/overlay']) {
    const res = await fetch(`${BASE}${p}`);
    if (res.status !== 200) fail(`GET ${p} => ${res.status}`);
    else ok(`GET ${p} 200`);
  }

  // The dashboard is a client-rendered Next page now: its rewards toggle is in
  // the page's JS, not its HTML, so the old `includes('rewardsEnabled')` check
  // could not pass. What the toggle reads and writes is checked below
  // (/api/dashboard/rooms, /api/config).

  const created = await fetch(`${BASE}/api/dashboard/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Rewards Gate Room',
      password: ROOM_PW,
      config: {
        passkeyTickPrice: '1',
        passkeyTickSeconds: 1,
        maxSession: '20',
        paymentTokenAddress: ARC_USDC,
        rewards: {
          enabled: true,
          earnInterval: 1,
          earnAmount: '5',
          earnCap: '20',
          rewardType: 'points',
        },
      },
    }),
  });
  const cdata = await created.json();
  if (!created.ok || !cdata.room?.id) fail('create rewards room failed');
  else ok('rewards room created with persisted config');

  const cfg = await (await fetch(`${BASE}/api/config?room=${cdata.room.id}`)).json();
  if (!cfg.rewards?.enabled) fail('/api/config missing rewards.enabled');
  else ok('/api/config exposes rewards');

  const earned = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('rewards accrual timeout'));
    }, 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'rewards_register',
        wallet: TEST_WALLET,
        roomId: cdata.room.id,
      }));
      ws.send(JSON.stringify({ type: 'rewards_visibility', visible: true }));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'rewards_earned' && msg.credited) {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    });
    ws.on('error', reject);
  }).catch((e) => {
    fail('WS earn: ' + e.message);
    return null;
  });

  if (earned) {
    ok(`rewards credited ${earned.credited} ${earned.symbol || 'PTS'}`);
  }

  const joinTerms = await fetch(`${BASE}/api/join/passkey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'gateviewer',
      address: TEST_WALLET,
      room: cdata.room.id,
    }),
  });
  const terms = await joinTerms.json();
  if (!joinTerms.ok || !terms.useRewardCredit) {
    fail('passkey terms should offer useRewardCredit after earning');
  } else {
    ok('earned balance enables reward join path');
  }

  const joined = await fetch(`${BASE}/api/join/passkey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'gateviewer',
      address: TEST_WALLET,
      room: cdata.room.id,
      useRewardCredit: true,
    }),
  });
  const jdata = await joined.json();
  if (!joined.ok || !jdata.success || jdata.paymentMode !== 'points_stream') {
    fail('reward credit join failed: ' + (jdata.error || joined.status));
  } else {
    ok('reward credit join assigns seat (points_stream)');
  }

  const defaultTerms = await fetch(`${BASE}/api/join/passkey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 't',
      address: '0x0000000000000000000000000000000000000002',
      room: 'default',
    }),
  });
  const dterms = await defaultTerms.json();
  if (defaultTerms.ok && dterms.needsApprove) {
    ok('pay-to-join passkey path unchanged (needsApprove on default room)');
  } else if (defaultTerms.status === 402) {
    ok('pay-to-join passkey path unchanged (402 balance gate)');
  } else {
    fail('unexpected default room passkey response');
  }

  const offRoom = await fetch(`${BASE}/api/dashboard/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'No Rewards',
      password: ROOM_PW,
      config: { paymentTokenAddress: ARC_USDC, rewards: { enabled: false } },
    }),
  });
  const offData = await offRoom.json();
  const offCfg = await (await fetch(`${BASE}/api/config?room=${offData.room.id}`)).json();
  if (offCfg.rewards?.enabled) fail('rewards off room should have enabled:false');
  else ok('rewards off by default on new room');

} catch (e) {
  fail('HTTP: ' + e.message);
}

if (fails.length && srv) console.log(srv.stderr().slice(-3000));
srv?.kill();
await rpc.close();
await sleep(1500);

console.log('');
if (fails.length) {
  console.error(`PART B GATE FAILED (${fails.length})`);
  fails.forEach((f) => console.error(' -', f));
  process.exit(1);
}
console.log('Part B gate PASSED. Live: REWARDS_TEST.md');
