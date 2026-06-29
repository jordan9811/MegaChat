/**
 * Part B rewards gate — optional per-room rewards must not break pay-to-join.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.GATE_PORT || 3004;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM_PW = process.env.GATE_ROOM_PASSWORD || 'rewards-gate-secret';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const TEST_WALLET = '0x0000000000000000000000000000000000000001';
const fails = [];

function ok(m) { console.log('  ✓', m); }
function fail(m) { fails.push(m); console.error('  ✗', m); }

let serverProc;
try {
  serverProc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ROOM_DEFAULT_PASSWORD: 'changeme' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
} catch (e) {
  fail('spawn: ' + e.message);
}

await sleep(2500);

try {
  for (const p of ['/dashboard', '/', '/overlay']) {
    const res = await fetch(`${BASE}${p}`);
    if (res.status !== 200) fail(`GET ${p} => ${res.status}`);
    else ok(`GET ${p} 200`);
  }

  const dashHtml = await (await fetch(`${BASE}/dashboard`)).text();
  if (!dashHtml.includes('rewardsEnabled')) fail('dashboard missing rewards toggle');
  else ok('dashboard rewards config UI present');

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

if (serverProc) serverProc.kill();
await sleep(400);

console.log('');
if (fails.length) {
  console.error(`PART B GATE FAILED (${fails.length})`);
  fails.forEach((f) => console.error(' -', f));
  process.exit(1);
}
console.log('Part B gate PASSED. Live: REWARDS_TEST.md');
