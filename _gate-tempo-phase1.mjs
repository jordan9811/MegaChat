/**
 * GATE — Tempo migration Phase 1 (chain + wallet layer).
 *
 * Verifies against a RUNNING server (npm run dev):
 *  1. /api/config serves Tempo mainnet values (4217, rpc.tempo.xyz, USDC.e)
 *     and the Privy block (or a loud warning when the app id isn't set yet).
 *  2. /api/balance/:addr does a REAL on-chain read from Tempo mainnet for the
 *     seller + test viewer wallets (proves RPC + token wiring end to end).
 *  3. Legacy rooms with persisted Arc token addresses resolve to the Tempo
 *     token (read-time remap; rooms.json on disk must stay untouched).
 *  4. The retired Gateway join returns 501.
 *  5. /join serves the Next page with the Privy-era buttons.
 *  6. Direct RPC sanity: eth_chainId === 0x1079.
 */
import { readFileSync } from 'fs';

const BASE = process.env.GATE_BASE_URL || 'http://localhost:3000';
let pass = 0, fail = 0, warn = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const note = (name, extra) => { warn++; console.warn(`  WARN  ${name} — ${extra}`); };

// Pull addresses from .env without printing secrets.
const env = Object.fromEntries(
  readFileSync(new URL('./.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
);
const SELLER = env.SELLER_WALLET_ADDRESS;
const VIEWER = env.TEST_VIEWER_WALLET;

console.log('\n— 1. /api/config (Tempo values) —');
const cfg = await (await fetch(`${BASE}/api/config?room=default`)).json();
ok('chainId 4217', cfg.chainId === 4217, String(cfg.chainId));
ok('chainIdHex 0x1079', cfg.chainIdHex === '0x1079', cfg.chainIdHex);
ok('network eip155:4217', cfg.network === 'eip155:4217', cfg.network);
ok('rpcUrl is Tempo', /rpc\.tempo\.xyz/.test(cfg.rpcUrl), cfg.rpcUrl);
ok('explorer is Tempo', /explore\.tempo\.xyz/.test(cfg.explorerUrl), cfg.explorerUrl);
ok('usdc is Tempo USDC.e', /^0x20c0/i.test(cfg.usdcAddress), cfg.usdcAddress);
ok('room token remapped to Tempo', /^0x20c0/i.test(cfg.paymentTokenAddress), cfg.paymentTokenAddress);
ok('legacy modularWallets gone', cfg.modularWallets === null);
if (cfg.privy?.appId) ok('privy app id configured', true, 'set');
else note('privy app id', 'NEXT_PUBLIC_PRIVY_APP_ID empty — Privy modal cannot open until set');

console.log('\n— 2. live Tempo balance reads —');
for (const [label, addr] of [['seller', SELLER], ['test viewer', VIEWER]]) {
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) { note(`${label} wallet`, 'not set in .env'); continue; }
  const r = await fetch(`${BASE}/api/balance/${addr}?room=default`);
  const b = await r.json();
  ok(`${label} balance read (${addr.slice(0, 8)}…)`, r.ok && b.source === 'onchain', JSON.stringify({ available: b.available, spendable: b.spendable, canJoin: b.canJoin }));
  if (r.ok && parseFloat(b.available) === 0) note(`${label} balance`, '0 USDC.e on Tempo — fund before live meter tests');
}

console.log('\n— 3. legacy Arc room remap (read-time, file untouched) —');
const legacyRoom = '0d71e866'; // persisted with Arc USDC 0x3600… in rooms.json
const lr = await fetch(`${BASE}/api/config?room=${legacyRoom}`);
if (lr.status === 404) note('legacy room', 'room not in rooms.json on this machine');
else {
  const lcfg = await lr.json();
  ok('legacy room token remapped', /^0x20c0/i.test(lcfg.paymentTokenAddress), lcfg.paymentTokenAddress);
}
const roomsRaw = readFileSync(new URL('./data/rooms.json', import.meta.url), 'utf8');
ok('rooms.json still carries Arc addresses on disk (not rewritten)', roomsRaw.includes('0x3600000000000000000000000000000000000000'));

console.log('\n— 4. retired Gateway join —');
const gj = await fetch(`${BASE}/api/join`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'gate', room: 'default' }),
});
ok('POST /api/join → 501', gj.status === 501, String(gj.status));

console.log('\n— 5. /join page serves the Privy-era UI —');
const page = await (await fetch(`${BASE}/join?room=default`)).text();
ok('page 200 + has sign-up button', page.includes('Sign up — email or passkey'));
ok('page has Fund wallet button', page.includes('Fund wallet'));
ok('no Gateway deposit button', !page.includes('Deposit USDC to Gateway'));

console.log('\n— 6. direct Tempo RPC sanity —');
const rpc = await (await fetch(cfg.rpcUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
})).json();
ok('eth_chainId === 0x1079', rpc.result === '0x1079', rpc.result);

console.log(`\nRESULT: ${pass} pass, ${fail} fail, ${warn} warn`);
process.exit(fail === 0 ? 0 : 1);
