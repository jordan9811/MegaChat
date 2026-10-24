/**
 * GATE — escrow-chain.js, deposit / attest / finalize, with NO chain and NO funds.
 *
 * Until now only _gate-escrow-seat.mjs (mainnet dust, the owner's call)
 * exercised this module's money logic (verify-money N5). This gate drives the
 * real createEscrowChain — real viem signing on viem's Tempo chain, keys
 * generated for the run — against a JSON-RPC stand-in on 127.0.0.1 that plays
 * contracts/MegaChatEscrow.sol's rules for deposit, attest and finalize.
 *
 *   E0  an empty ESCROW_CONTRACT_ADDRESS is escrow OFF: no deposit, no sweep
 *   E1  a deposit whose answer is lost is LANDED: read back, DONE, no degrade (money-4)
 *   E2  an escrow on chain whose seat was refused is attested 0/0: full refund
 *   E3  two overlapping sweeps finalize each escrow once (money-11)
 *   E4  a join's deposit is signed before a 20-finalize sweep ends (money-11)
 *   E5  a corrupt escrow ledger halts every escrow write
 *
 * Each case names what the old code did; the mutation run in
 * scratchpad/audit/fix-money proves the old module fails it.
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { decodeFunctionData, encodeFunctionResult, encodeErrorResult, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createEscrowChain, escrowIdFor, loadEscrowAbi } from './escrow-chain.js';
import { startRpcStandIn, block, receipt, tx, hex } from './_gate-rpc-standin.mjs';
import { deserialize } from './node_modules/viem/_esm/tempo/Transaction.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-gate-escrow-chain-'));
const dir = (n) => path.join(SCRATCH, n);
const abi = loadEscrowAbi();
const CONTRACT = '0x432bb6c62503711ad4e70a91247a110e61779213';
const TOKEN = { address: '0x20c000000000000000000000b9537d11c60e8b50', decimals: 6, symbol: 'USDC.e' };
const VIEWER = '0x00000000000000000000000000000000000000a1';
const STREAMER = '0x00000000000000000000000000000000000000b2';
const ZERO = `0x${'0'.repeat(40)}`;
const quiet = { log() {}, warn() {}, error() {} };

console.log('\n── escrow-chain.js against a contract stand-in ─────────────');

/**
 * The contract's rules, as a node would apply them. `opts.onSend(fn, st)` may
 * throw {httpStatus} to lose the answer AFTER the transaction is applied;
 * `opts.readBroken()` makes escrow() reads fail; `opts.receiptDelayMs` delays
 * every receipt.
 */
function contractNode(opArgs = {}) {
  const opts = { receiptDelayMs: 0, ...opArgs };
  const st = { head: 100, escrows: new Map(), sent: [], receipts: new Map(), nonce: 0, operator: null, attester: null, estimateReverts: [] };
  const revert = (errorName, args) => { throw { rpcError: { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi, errorName, args }) } }; };
  const dataOf = (call) => call.data || call.input || call.calls?.[0]?.data;
  function check(fn, args) {
    const e = st.escrows.get(args[0]);
    if (fn === 'deposit' && e) revert('EscrowExists');
    if ((fn === 'attest' || fn === 'finalize') && !e) revert('NoSuchEscrow');
    if ((fn === 'attest' || fn === 'finalize') && e.finalized) revert('AlreadyFinalized');
  }
  function apply(fn, args) {
    if (fn === 'deposit') {
      const [id, viewer, streamer, amount, releaseAt, feeBps, rate, sessionId] = args;
      st.escrows.set(id, { viewer, deposited: amount, streamer, remaining: amount, rate, releaseAt, consumed: 0, hidden: 0, feeBps, attested: false, finalized: false, sessionId });
    } else if (fn === 'attest') {
      const e = st.escrows.get(args[0]);
      const cap = Number(e.deposited / e.rate);
      e.consumed = Math.min(Number(args[1]), cap); e.hidden = Math.min(Number(args[2]), e.consumed); e.attested = true;
    } else if (fn === 'finalize') {
      const e = st.escrows.get(args[0]);
      const paid = e.attested ? BigInt(e.consumed - e.hidden) * e.rate : (e.deposited / e.rate) * e.rate;
      const gross = paid > e.remaining ? e.remaining : paid;
      e.outcome = { toStreamer: gross, refund: e.remaining - gross };
      e.finalized = true; e.remaining = 0n;
    }
  }
  st.handlers = {
    eth_chainId: () => hex(4217),
    eth_blockNumber: () => hex(++st.head),
    eth_getBlockByNumber: ([n]) => block(n === 'latest' || n === 'pending' ? st.head : Number(BigInt(n))),
    eth_getTransactionCount: () => hex(st.nonce),
    eth_maxPriorityFeePerGas: () => '0x0',
    eth_gasPrice: () => hex(1_000_000_000n),
    eth_getCode: () => '0x6080604052',
    eth_estimateGas: ([call]) => {
      const { functionName, args } = decodeFunctionData({ abi, data: dataOf(call) });
      try { check(functionName, args); } catch (e) { st.estimateReverts.push(functionName); throw e; }
      return hex(400_000);
    },
    eth_call: ([call]) => {
      const { functionName, args } = decodeFunctionData({ abi, data: dataOf(call) });
      if (functionName === 'TOKEN') return encodeFunctionResult({ abi, functionName, result: TOKEN.address });
      if (functionName === 'OPERATOR') return encodeFunctionResult({ abi, functionName, result: st.operator });
      if (functionName === 'ATTESTER') return encodeFunctionResult({ abi, functionName, result: st.attester });
      if (functionName === 'escrow') {
        if (opts.readBroken?.()) throw { httpStatus: 502 };
        const e = st.escrows.get(args[0]);
        const r = e || { viewer: ZERO, deposited: 0n, streamer: ZERO, remaining: 0n, rate: 0n, releaseAt: 0n, consumed: 0, hidden: 0, feeBps: 0, attested: false, finalized: false, sessionId: `0x${'0'.repeat(64)}` };
        return encodeFunctionResult({ abi, functionName, result: { viewer: r.viewer, deposited: r.deposited, streamer: r.streamer, remaining: r.remaining, rate: r.rate, releaseAt: r.releaseAt, consumed: r.consumed, hidden: r.hidden, feeBps: r.feeBps, attested: r.attested, finalized: r.finalized, sessionId: r.sessionId } });
      }
      throw { rpcError: { code: -32000, message: `stand-in: no ${functionName}` } };
    },
    eth_sendRawTransaction: async ([raw]) => {
      const t = deserialize(raw);
      const { functionName, args } = decodeFunctionData({ abi, data: t.calls?.[0]?.data || t.data });
      const h = keccak256(raw);
      st.nonce += 1;
      let status = '0x1';
      try { check(functionName, args); apply(functionName, args); } catch { status = '0x0'; }
      st.sent.push({ fn: functionName, id: args[0], hash: h, nonce: Number(t.nonce ?? 0), at: Date.now() });
      const ready = Date.now() + opts.receiptDelayMs;
      st.receipts.set(h, { status, ready });
      if (opts.onSend) await opts.onSend(functionName, st);
      return h;
    },
    // The transaction itself, as a node knows it (viem asks for it while it waits on a receipt).
    eth_getTransactionByHash: ([h]) => {
      const x = st.sent.find((y) => y.hash === h);
      if (!x) return null;
      const r = st.receipts.get(h);
      return tx(h, x.fn === 'attest' ? st.attester : st.operator, x.nonce, CONTRACT, '0x', r && Date.now() >= r.ready ? st.head : null);
    },
    eth_getTransactionReceipt: ([h]) => {
      const r = st.receipts.get(h);
      return r && Date.now() >= r.ready ? receipt(h, st.head, ZERO, CONTRACT, r.status) : null;
    },
  };
  return st;
}

async function chainFor(st, name, extra = {}) {
  const rpc = await startRpcStandIn(st.handlers);
  const operatorKey = generatePrivateKey(), attesterKey = generatePrivateKey();
  st.operator = privateKeyToAccount(operatorKey).address;
  st.attester = privateKeyToAccount(attesterKey).address;
  const esc = createEscrowChain({
    chain: { id: 4217 }, rpcUrl: rpc.url, contractAddress: CONTRACT, token: TOKEN,
    operatorKey, attesterKey, feeToken: TOKEN.address, dataDir: dir(name), tailMs: 0, reviewMs: 0, log: quiet, ...extra,
  });
  await esc.preflight({ force: true });
  return { esc, rpc };
}
const depositArgs = (seatId, amount = 30_000n) => ({ seatId, roomId: 'room', viewer: VIEWER, streamer: STREAMER, amountAtomic: amount, rateAtomic: 1_000n, tickMs: 1000 });

try {
  // ── E0: an empty contract address is escrow OFF (production: present but empty) ──
  try {
    const st = contractNode();
    const rpc = await startRpcStandIn(st.handlers);
    const seen = rpc.seen.length;
    const esc = createEscrowChain({ chain: { id: 4217 }, rpcUrl: rpc.url, contractAddress: '', token: TOKEN, operatorKey: generatePrivateKey(), attesterKey: generatePrivateKey(), dataDir: dir('e0'), log: quiet });
    let threw = null;
    try { await esc.deposit(depositArgs('e0-seat')); } catch (e) { threw = e.message; }
    const sweep = await esc.finalizeDue({ now: Date.now() + 30 * 86_400_000 });
    const pf = await esc.preflight({ force: true });
    ok('E0. ESCROW_CONTRACT_ADDRESS="" is escrow OFF: not enabled, mode direct, the reason named, no deposit, no sweep, not one RPC call',
      esc.enabled === false && esc.mode().mode === 'direct' && /no contract address/.test(esc.status().reason) && threw === 'escrow not enabled'
        && sweep.finalized.length === 0 && pf.ready === false && rpc.seen.length === seen, `${esc.status().reason}; ${rpc.seen.length - seen} RPC calls`);
    const blank = createEscrowChain({ chain: { id: 4217 }, rpcUrl: rpc.url, contractAddress: '   ', token: TOKEN, operatorKey: generatePrivateKey(), attesterKey: generatePrivateKey(), dataDir: dir('e0b'), log: quiet });
    ok('E0. ...and so is a whitespace-only one', blank.enabled === false);
    await rpc.close();
  } catch (e) { ok(`E0. the case ran to the end (it crashed: ${e.message})`, false); }

  // ── E1: the node takes the deposit, the answer is lost ───────────────────
  try {
    const st = contractNode({ onSend: (fn) => { if (fn === 'deposit') throw { httpStatus: 504 }; } });
    const { esc, rpc } = await chainFor(st, 'e1');
    const modeBefore = esc.mode().mode;
    let r = null, threw = null;
    try { r = await esc.deposit(depositArgs('e1-seat')); } catch (e) { threw = e; }
    const s = esc.seatStatus('e1-seat');
    const sentRow = esc.ledger.all().find((x) => x.phase === 'SENT' && x.kind === 'DEPOSIT');
    ok('E1. LOST ANSWER: deposit() resolves — the escrow read back from the chain matches, so it is LANDED (it threw and recorded FAILED)',
      !threw && r?.reconciled === true && s.deposit?.phase === 'DONE', threw ? threw.message : `phase ${s.deposit?.phase}`);
    ok('E1. ...the escrow stays usable: mode escrow, not degraded to direct (it degraded every room for 10 min)', modeBefore === 'escrow' && esc.mode().mode === 'escrow', esc.mode().reason || 'escrow');
    ok('E1. ...ONE deposit reached the node, its hash was on the ledger before the send, and nothing was retried into an EscrowExists revert',
      st.sent.filter((x) => x.fn === 'deposit').length === 1 && sentRow?.txHash === st.sent[0].hash && st.estimateReverts.length === 0, `${st.sent.length} send(s), ${st.estimateReverts.length} reverted estimate(s)`);
    const att = await esc.attest({ seatId: 'e1-seat', consumedUnits: 10, hiddenUnits: 0 });
    ok('E1. ...so the seat attests its real figures at the end', !!att.txHash && st.escrows.get(escrowIdFor('e1-seat')).consumed === 10);
    await rpc.close();
  } catch (e) { ok(`E1. the case ran to the end (it crashed: ${e.message})`, false); }

  // ── E2: an escrow the chain holds for a seat that was refused ────────────
  try {
    let broken = true;
    const st = contractNode({ onSend: (fn) => { if (fn === 'deposit') throw { httpStatus: 504 }; }, readBroken: () => broken });
    const { esc, rpc } = await chainFor(st, 'e2');
    let threw = null;
    try { await esc.deposit(depositArgs('e2-seat', 50_000n)); } catch (e) { threw = e; }
    const phase = esc.seatStatus('e2-seat').deposit?.phase;
    ok('E2. sent, and the chain cannot be read back: the deposit is UNKNOWN, not FAILED — the seat is refused, the escrow not degraded',
      !!threw && phase === 'UNKNOWN' && esc.mode().mode === 'escrow', `phase ${phase}, ${threw?.message}`);
    broken = false; // the RPC recovers; the deposit had landed
    const sweep1 = await esc.finalizeDue({ now: Date.now() });
    const e = st.escrows.get(escrowIdFor('e2-seat'));
    ok('E2. ORPHAN: the sweep finds the escrow on chain and attests it 0/0 (unattested, finalize paid the streamer the whole cap)',
      (sweep1.orphans || []).includes('e2-seat') && e.attested === true && e.consumed === 0 && e.hidden === 0 && esc.seatStatus('e2-seat').deposit?.phase === 'ORPHAN',
      `attested ${e.attested} ${e.consumed}/${e.hidden}`);
    await esc.finalizeDue({ now: Date.now() + 30 * 86_400_000 });
    ok('E2. ...and at the deadline finalize refunds the viewer IN FULL', e.finalized === true && e.outcome?.refund === 50_000n && e.outcome?.toStreamer === 0n, e.outcome ? `refund ${e.outcome.refund}, streamer ${e.outcome.toStreamer}` : 'not finalized');
    await rpc.close();
  } catch (e) { ok(`E2. the case ran to the end (it crashed: ${e.message})`, false); }

  // ── E3: two sweeps at once finalize each escrow once ─────────────────────
  try {
    const st = contractNode({ receiptDelayMs: 300 });
    const { esc, rpc } = await chainFor(st, 'e3');
    for (const k of [1, 2, 3]) await esc.deposit(depositArgs(`e3-${k}`));
    const later = Date.now() + 30 * 86_400_000;
    const [a, b] = await Promise.all([esc.finalizeDue({ now: later }), esc.finalizeDue({ now: later })]);
    const fins = st.sent.filter((x) => x.fn === 'finalize');
    const byOther = esc.ledger.all().filter((x) => x.kind === 'FINALIZE' && x.byOther);
    ok('E3. TWO OVERLAPPING SWEEPS: the second stands down, each escrow is finalized once, and no finalize of ours is booked as someone else\'s',
      (a.busy || b.busy) && fins.length === 3 && new Set(fins.map((x) => x.id)).size === 3 && byOther.length === 0 && st.estimateReverts.length === 0,
      `${fins.length} finalize send(s), ${byOther.length} byOther, ${st.estimateReverts.length} reverted estimate(s)`);
    await rpc.close();
  } catch (e) { ok(`E3. the case ran to the end (it crashed: ${e.message})`, false); }

  // ── E4: a join is not held behind a sweep ────────────────────────────────
  try {
    const st = contractNode({ receiptDelayMs: 250 });
    const { esc, rpc } = await chainFor(st, 'e4');
    for (let k = 0; k < 20; k++) await esc.deposit(depositArgs(`e4-${k}`));
    const later = Date.now() + 30 * 86_400_000;
    const capped = await esc.finalizeDue({ now: later });
    ok('E4. one sweep finalizes at most FINALIZE_PER_SWEEP (10), the rest wait for the next', capped.finalized.length === 10, `${capped.finalized.length} finalized`);
    const sweep = esc.finalizeDue({ now: later, max: 20 });
    await sleep(120);
    await esc.deposit(depositArgs('e4-join'));
    await sweep;
    const order = st.sent.map((x) => x.fn);
    const joinAt = st.sent.findIndex((x) => x.id === escrowIdFor('e4-join'));
    const lastFinalize = order.lastIndexOf('finalize');
    ok('E4. A JOIN DURING A SWEEP: its deposit is signed and sent before the sweep\'s last finalize (it waited behind every finalize\'s receipt)',
      joinAt > 0 && joinAt < lastFinalize && esc.seatStatus('e4-join').deposit?.phase === 'DONE', `deposit at send #${joinAt}, last finalize at #${lastFinalize}`);
    await rpc.close();
  } catch (e) { ok(`E4. the case ran to the end (it crashed: ${e.message})`, false); }

  // ── E5: a corrupt escrow ledger halts every escrow write ─────────────────
  try {
    const st = contractNode();
    const { esc, rpc } = await chainFor(st, 'e5');
    await esc.deposit(depositArgs('e5-a'));
    const file = path.join(dir('e5'), 'escrow-chain.jsonl');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines[0] = lines[0].replace('"amountAtomic":"30000"', '"amountAtomic":"30001"');
    writeFileSync(file, lines.join('\n'));
    const before = st.sent.length;
    const again = createEscrowChain({ chain: { id: 4217 }, rpcUrl: rpc.url, contractAddress: CONTRACT, token: TOKEN, operatorKey: generatePrivateKey(), attesterKey: generatePrivateKey(), dataDir: dir('e5'), log: quiet });
    let threw = null;
    try { await again.deposit(depositArgs('e5-b')); } catch (e) { threw = e; }
    const sweep = await again.finalizeDue({ now: Date.now() + 30 * 86_400_000 });
    ok('E5. a damaged escrow ledger halts deposits and sweeps — nothing is signed, boot does not stop, status() says why',
      !!threw && !!sweep.halted && st.sent.length === before && /corrupt/.test(again.status().halted || ''), threw?.message);
    await rpc.close();
  } catch (e) { ok(`E5. the case ran to the end (it crashed: ${e.message})`, false); }
} catch (e) {
  fail++;
  console.log(`  FAIL  the gate crashed: ${e.stack || e}`);
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
await sleep(200);
process.exit(fail === 0 ? 0 : 1);
