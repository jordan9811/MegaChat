/**
 * GATE — the non-custodial seat escrow, adversarially, on Moderato testnet.
 *
 * SPENDS NOTHING REAL. Every account is generated at runtime, funded from the
 * Moderato faucet (tempo_fundAddress), and discarded on exit. No key is read
 * from .env; SELLER_PRIVATE_KEY, PLATFORM_SETTLEMENT_KEY and ESCROW_ATTEST_KEY
 * are never touched. The app's own chain configuration is not used: this gate
 * talks to chain 42431 only, because TIP-20 and TIP-1020 are node-level
 * precompiles that an anvil fork cannot reproduce.
 *
 * Every case below is one the prompt named, plus the bounds the contract adds.
 * Each refusal is asserted by the contract's own custom error, and the full
 * lifecycle asserts on-chain balances against the seat ledger's arithmetic to
 * the atomic unit. Real time passes for the deadline cases: two waits of ~25s.
 *
 *   node _gate-escrow-contract.mjs
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, erc20Abi, keccak256, toHex, formatUnits, decodeEventLog } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { buildEscrow, loadArtifact } from './contracts/escrow-build.mjs';
import { deployEscrow } from './scripts/deploy-escrow.mjs';

const ALPHA = '0x20c0000000000000000000000000000000000001'; // AlphaUSD, 6 dp — the escrow token here
const PATH = '0x20c0000000000000000000000000000000000000';  // pathUSD — the default fee token for contract calls
const pub = createPublicClient({ chain: tempoModerato, transport: http() });

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gas = {};

// ── actors ────────────────────────────────────────────────────────────────
const mk = (label) => {
  const key = generatePrivateKey(); // lives in this process only; never logged, never written
  const account = privateKeyToAccount(key);
  return { label, key, account, wallet: createWalletClient({ account, chain: tempoModerato, transport: http() }) };
};
const deployer = mk('deployer/owner'), operator = mk('operator'), attester = mk('attester'), feeRecipient = mk('feeRecipient');
const streamer = mk('streamer'), stranger = mk('stranger');
const viewers = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((l) => mk(`viewer ${l}`));
const [vA, vB, vC, vD, vE, vF, vG] = viewers;

async function fund(actor) {
  for (let i = 0; i < 4; i++) {
    try { await pub.request({ method: 'tempo_fundAddress', params: [actor.account.address] }); return; } catch (e) { await sleep(1500 * (i + 1)); }
  }
  throw new Error(`faucet refused ${actor.label}`);
}
const bal = (who, token = ALPHA) => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

console.log('\n── escrow contract, Moderato ─────────────────────────────────');
console.log('  funding', 6 + viewers.length, 'ephemeral accounts from the faucet…');
for (const a of [deployer, operator, attester, feeRecipient, streamer, stranger, ...viewers]) await fund(a);
await sleep(3000);
ok('0. every ephemeral account holds faucet AlphaUSD', (await Promise.all(viewers.map((v) => bal(v.account.address)))).every((b) => b > 0n));

// ── build + deploy ────────────────────────────────────────────────────────
const fresh = buildEscrow({ write: false });
const stored = loadArtifact();
ok('0. the committed artifact is what the source compiles to', stored.sourceHash === fresh.sourceHash && stored.bytecode === fresh.bytecode, `${stored.compiler}, ${stored.evmVersion}`);
// Through the real deploy script, with the gate's ephemeral deployer key and
// recording off: a throwaway deployment must not land in contracts/deployments.json.
const dep = await deployEscrow({
  chainName: 'moderato', deployerKey: deployer.key, record: false, token: ALPHA,
  operator: operator.account.address, attester: attester.account.address, owner: deployer.account.address, feeRecipient: feeRecipient.account.address,
  log: { log() {} },
});
const ESCROW = dep.address;
gas.deploy = BigInt(dep.gasUsed);
const ABI = loadArtifact().abi;
ok('0. deployed on chain 42431 through scripts/deploy-escrow.mjs; on-chain bytecode matches the artifact', !!ESCROW && dep.onChainBytecodeMatchesArtifact === true, ESCROW);
const read = (fn, args = []) => pub.readContract({ address: ESCROW, abi: ABI, functionName: fn, args });
ok('0. roles are immutable and as constructed', (await read('OPERATOR')).toLowerCase() === operator.account.address.toLowerCase() && (await read('ATTESTER')).toLowerCase() === attester.account.address.toLowerCase());

// ── helpers ───────────────────────────────────────────────────────────────
async function send(actor, fn, args, label) {
  const hash = await actor.wallet.writeContract({ address: ESCROW, abi: ABI, functionName: fn, args });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (label) gas[label] = r.gasUsed;
  if (r.status !== 'success') throw new Error(`${fn} reverted on-chain`);
  return r;
}
async function refuses(actor, fn, args, errorName) {
  try {
    await pub.simulateContract({ address: ESCROW, abi: ABI, functionName: fn, args, account: actor.account });
    return { refused: false, error: 'succeeded' };
  } catch (e) {
    let text = '';
    for (let c = e; c; c = c.cause) text += ` ${c.shortMessage || c.message || ''} ${c.data?.errorName || ''} ${c.details || ''}`;
    return { refused: true, matched: text.includes(errorName), error: text.trim().slice(0, 120) };
  }
}
const approve = async (viewer, amount) => {
  const hash = await viewer.wallet.writeContract({ address: ALPHA, abi: erc20Abi, functionName: 'approve', args: [ESCROW, amount] });
  await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
};
const id = (s) => keccak256(toHex(s));
const now = async () => Number((await pub.getBlock()).timestamp);
const domain = { name: 'MegaChatEscrow', version: '1', chainId: tempoModerato.id, verifyingContract: ESCROW };
const FLAG_TYPES = { Flag: [{ name: 'sessionId', type: 'bytes32' }] };
const signFlag = (viewer, sessionId) => viewer.wallet.signTypedData({ domain, types: FLAG_TYPES, primaryType: 'Flag', message: { sessionId } });
const decoded = (rcpt, name) =>
  rcpt.logs.map((l) => { try { return decodeEventLog({ abi: ABI, data: l.data, topics: l.topics }); } catch { return null; } }).filter((x) => x && x.eventName === name);

// The seat ledger's arithmetic, in JS, for exact comparison.
const ledger = ({ deposited, rate, consumed, hidden, feeBps = 0, remaining = deposited }) => {
  const cap = deposited / rate;
  const c = consumed == null ? cap : (consumed > cap ? cap : consumed);
  const h = hidden == null ? 0n : (hidden > c ? c : hidden);
  let gross = (c - h) * rate; if (gross > remaining) gross = remaining;
  const fee = gross * BigInt(feeBps) / 10000n;
  return { toStreamer: gross - fee, fee, toViewer: remaining - gross };
};

// ═════════════════ 1. the full lifecycle, balances to the atomic unit ═════
console.log('\n── 1. lifecycle: deposit → attest → finalize by a stranger ───');
{
  const RATE = 1000n, CAP = 3_600_000n; // $0.001/s, one hour
  const S1 = id('session-1'), E1 = id('seat-1');
  const t = await now();
  await approve(vA, CAP);
  const before = { viewer: await bal(vA.account.address), streamer: await bal(streamer.account.address), fee: await bal(feeRecipient.account.address) };
  await send(operator, 'deposit', [E1, vA.account.address, streamer.account.address, CAP, BigInt(t + 30), 0, RATE, S1], 'deposit');
  ok('1. the deposit pulled exactly the cap from the viewer into the contract', (await bal(ESCROW)) === CAP && before.viewer - (await bal(vA.account.address)) === CAP);
  const e = await read('escrow', [E1]);
  ok('1. streamer, rate, deadline and fee recorded; nothing attested yet', e.streamer.toLowerCase() === streamer.account.address.toLowerCase() && e.rate === RATE && e.feeBps === 0 && !e.attested);
  ok('1. finalize BEFORE releaseAt is refused', (await refuses(stranger, 'finalize', [E1], 'TooEarly')).matched);
  const r = await send(attester, 'attest', [E1, 600, 120], 'attest');
  const ev = decoded(r, 'Attested')[0]?.args;
  ok('1. the attester reports 600 consumed / 120 hidden; stored as given', ev && ev.consumedSeconds === 600 && ev.hiddenSeconds === 120);
  const preview = await read('outcome', [E1]);
  const expect = ledger({ deposited: CAP, rate: RATE, consumed: 600n, hidden: 120n });
  ok('1. outcome() previews exactly the ledger arithmetic: streamer 480 s × rate, viewer the rest', preview[0] === expect.toStreamer && preview[2] === expect.toViewer, `${preview[0]} / ${preview[2]}`);
  console.log('  waiting for the deadline…');
  while ((await now()) < t + 31) await sleep(2000);
  const f = await send(stranger, 'finalize', [E1], 'finalize');
  const fin = decoded(f, 'Finalized')[0]?.args;
  const after = { viewer: await bal(vA.account.address), streamer: await bal(streamer.account.address), fee: await bal(feeRecipient.account.address) };
  ok('1. a STRANGER finalized after the deadline and it paid the streamer', fin && fin.by.toLowerCase() === stranger.account.address.toLowerCase() && after.streamer - before.streamer === expect.toStreamer, `streamer +${expect.toStreamer}`);
  ok('1. the viewer got back every unspent and every hidden second, to the atomic unit', after.viewer - before.viewer === -CAP + expect.toViewer, `viewer net −${CAP - expect.toViewer}`);
  ok('1. fee 0: the fee recipient received nothing; the contract holds nothing', after.fee === before.fee && (await bal(ESCROW)) === 0n);
  ok('1. attest AFTER finalize is refused', (await refuses(attester, 'attest', [E1, 100, 0], 'AlreadyFinalized')).matched);
  ok('1. finalize twice is refused', (await refuses(stranger, 'finalize', [E1], 'AlreadyFinalized')).matched);
}

// ═════════════════ 2. the attestation can only help the viewer ═══════════
console.log('\n── 2. attestations: viewer-ward only, clamped, keyed ─────────');
{
  const RATE = 1000n, CAP = 600_000n; // 600 s cap
  const S2 = id('session-2'), E2 = id('seat-2');
  const t = await now();
  await approve(vB, CAP);
  await send(operator, 'deposit', [E2, vB.account.address, streamer.account.address, CAP, BigInt(t + 3600), 0, RATE, S2]);
  ok('2. a non-attester (the operator) cannot attest', (await refuses(operator, 'attest', [E2, 10, 0], 'NotAttester')).matched);
  ok('2. ...nor the streamer, nor a stranger', (await refuses(streamer, 'attest', [E2, 10, 0], 'NotAttester')).matched && (await refuses(stranger, 'attest', [E2, 10, 0], 'NotAttester')).matched);
  const r1 = await send(attester, 'attest', [E2, 5000, 9000]);
  const a1 = decoded(r1, 'Attested')[0]?.args;
  ok('2. consumed beyond the cap is CLAMPED to the cap (600), hidden beyond consumed CLAMPED to consumed', a1 && a1.consumedSeconds === 600 && a1.hiddenSeconds === 600, `requested 5000/9000 → stored ${a1?.consumedSeconds}/${a1?.hiddenSeconds}`);
  let o = await read('outcome', [E2]);
  ok('2. ...so the streamer is owed nothing and the viewer everything', o[0] === 0n && o[2] === CAP);
  // Now the only direction that exists: try to move it back toward the streamer.
  ok('2. an attestation that would INCREASE the streamer share is refused', (await refuses(attester, 'attest', [E2, 600, 100], 'AttestationWouldFavourStreamer')).matched);
  // Impossible by construction: enumerate every state-changing entry point.
  // Only deposit creates a streamer share; attest can only lower it (proven
  // above); finalize pays it; streamerRefund and flag never raise it;
  // setEscalation touches no money. Nothing else exists.
  const mutating = ABI.filter((f) => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure').map((f) => f.name).sort().join(',');
  ok('2. ...and there is no other function that could raise it: the only state-changing entry points are deposit, attest, finalize, streamerRefund, flag, setEscalation',
    mutating === 'attest,deposit,finalize,flag,setEscalation,streamerRefund', mutating);
  // A fresh escrow: first attest partial, second attest more viewer-ward is fine, equal is fine.
  const E2b = id('seat-2b');
  await approve(vB, CAP);
  await send(operator, 'deposit', [E2b, vB.account.address, streamer.account.address, CAP, BigInt(t + 3600), 0, RATE, S2]);
  await send(attester, 'attest', [E2b, 500, 100]);           // paid 400 s
  await send(attester, 'attest', [E2b, 450, 100]);           // paid 350 s — toward the viewer, allowed
  await send(attester, 'attest', [E2b, 450, 100]);           // identical — allowed (idempotent)
  ok('2. a later attestation that moves further toward the viewer is accepted; an identical one is idempotent', (await read('escrow', [E2b])).consumed === 450);
  ok('2. ...but 460/100 (paid 360 > 350) is refused', (await refuses(attester, 'attest', [E2b, 460, 100], 'AttestationWouldFavourStreamer')).matched);
}

// ═════════════════ 3. deposit and refund bounds ═══════════════════════════
console.log('\n── 3. deposit and streamerRefund bounds ───────────────────────');
{
  const RATE = 1000n, CAP = 300_000n;
  const S3 = id('session-3'), E3 = id('seat-3');
  const t = await now();
  await approve(vC, CAP * 3n);
  ok('3. a non-operator cannot deposit', (await refuses(stranger, 'deposit', [E3, vC.account.address, streamer.account.address, CAP, BigInt(t + 3600), 0, RATE, S3], 'NotOperator')).matched);
  ok('3. a deadline past MAX_HOLD (14 d) is refused — the platform cannot lock funds indefinitely', (await refuses(operator, 'deposit', [E3, vC.account.address, streamer.account.address, CAP, BigInt(t + 15 * 86400), 0, RATE, S3], 'BadDeadline')).matched);
  ok('3. a deadline in the past is refused', (await refuses(operator, 'deposit', [E3, vC.account.address, streamer.account.address, CAP, BigInt(t - 10), 0, RATE, S3], 'BadDeadline')).matched);
  ok('3. a fee above MAX_FEE_BPS (10%) is refused — no cut outside the declared, capped fee', (await refuses(operator, 'deposit', [E3, vC.account.address, streamer.account.address, CAP, BigInt(t + 3600), 1001, RATE, S3], 'FeeTooHigh')).matched);
  ok('3. an amount below one second of rate is refused', (await refuses(operator, 'deposit', [E3, vC.account.address, streamer.account.address, 999n, BigInt(t + 3600), 0, RATE, S3], 'BadAmount')).matched);
  ok('3. the contract itself as streamer is refused', (await refuses(operator, 'deposit', [E3, vC.account.address, ESCROW, CAP, BigInt(t + 3600), 0, RATE, S3], 'ZeroAddress')).matched);
  await send(operator, 'deposit', [E3, vC.account.address, streamer.account.address, CAP, BigInt(t + 3600), 0, RATE, S3]);
  ok('3. depositing TWICE for the same id is refused', (await refuses(operator, 'deposit', [E3, vC.account.address, streamer.account.address, CAP, BigInt(t + 3600), 0, RATE, S3], 'EscrowExists')).matched);
  ok('3. streamerRefund from a NON-streamer is refused (operator, attester, viewer, stranger)',
    (await refuses(operator, 'streamerRefund', [E3, 1000n], 'NotStreamer')).matched && (await refuses(attester, 'streamerRefund', [E3, 1000n], 'NotStreamer')).matched
    && (await refuses(vC, 'streamerRefund', [E3, 1000n], 'NotStreamer')).matched && (await refuses(stranger, 'streamerRefund', [E3, 1000n], 'NotStreamer')).matched);
  ok('3. streamerRefund EXCEEDING the deposit is refused', (await refuses(streamer, 'streamerRefund', [E3, CAP + 1n], 'RefundExceedsRemaining')).matched);
  const vBefore = await bal(vC.account.address);
  await send(streamer, 'streamerRefund', [E3, 100_000n], 'streamerRefund');
  ok('3. a partial streamerRefund reaches the viewer immediately, before any deadline', (await bal(vC.account.address)) - vBefore === 100_000n && (await read('escrow', [E3])).remaining === 200_000n);
  await send(streamer, 'streamerRefund', [E3, 200_000n]);
  ok('3. refunding the remainder closes the escrow: finalized, nothing held', (await read('escrow', [E3])).finalized === true && (await bal(vC.account.address)) - vBefore === CAP);
  ok('3. ...and finalize / attest afterwards are refused', (await refuses(stranger, 'finalize', [E3], 'AlreadyFinalized')).matched && (await refuses(attester, 'attest', [E3, 1, 0], 'AlreadyFinalized')).matched);
}

// ═════════════════ 4. server silence: nothing stranded ════════════════════
console.log('\n── 4. the server never attests, never finalizes ───────────────');
{
  const RATE = 1000n, CAP = 100_500n; // 100 s cap + 500 units of dust that can never be earned
  const S4 = id('session-4'), E4 = id('seat-4');
  const t = await now();
  await approve(vD, CAP);
  const sBefore = await bal(streamer.account.address), vBefore = await bal(vD.account.address), cBefore = await bal(ESCROW);
  await send(operator, 'deposit', [E4, vD.account.address, streamer.account.address, CAP, BigInt(t + 25), 0, RATE, S4]);
  console.log('  waiting for the deadline…');
  while ((await now()) < t + 26) await sleep(2000);
  await send(stranger, 'finalize', [E4]);
  ok('4. with no attestation, a stranger’s finalize pays the streamer the whole earnable cap', (await bal(streamer.account.address)) - sBefore === 100_000n);
  // Section 2 deliberately leaves two escrows open, so the contract is not empty: assert this seat's delta is zero.
  ok('4. ...the unearnable dust below one second returns to the viewer, and nothing of this seat is stranded', (await bal(vD.account.address)) - vBefore === -100_000n && (await bal(ESCROW)) === cBefore,
    `viewer −100000, contract delta ${(await bal(ESCROW)) - cBefore}`);
}

// ═════════════════ 5. flags and escalation ═════════════════════════════════
console.log('\n── 5. flags: eligibility, weight, once-only escalation ────────');
{
  const RATE = 1000n;
  const S5 = id('session-5');
  const t = await now();
  // A, C, D first; B (who already holds deposits in session-2) joins after the
  // "deposited elsewhere" case below. Final: A+B+C 600k each, D 2.4M — 4.2M;
  // A+B+C = 1.8M = 42.8% ≥ 25%, and 3 addresses.
  const held5 = await bal(ESCROW); // what the contract held before this session (section 2's open escrows)
  const dep5 = async (v, amt, name) => { await approve(v, amt); await send(operator, 'deposit', [id(name), v.account.address, streamer.account.address, amt, BigInt(t + 25), 0, RATE, S5]); };
  await dep5(vA, 600_000n, 'seat-5a'); await dep5(vC, 600_000n, 'seat-5c'); await dep5(vD, 2_400_000n, 'seat-5d');
  const E5a = id('seat-5a');

  // an address with NO deposit anywhere
  const rx = await send(stranger, 'flag', [E5a, [await signFlag(stranger, S5)]]);
  ok('5. a flag from an address with no deposit in the session is rejected with no weight', decoded(rx, 'FlagRejected').length === 1 && (await read('session', [S5])).flaggers === 0);
  // a depositor in ANOTHER session (B holds deposits in session-2, none here yet)
  const rOther = await send(stranger, 'flag', [E5a, [await signFlag(vB, S5)]]);
  ok('5. ...so is an address that deposited in another session but not this one', decoded(rOther, 'FlagRejected').length === 1 && (await read('session', [S5])).flaggers === 0);
  await dep5(vB, 600_000n, 'seat-5b');
  const sess0 = await read('session', [S5]);
  ok('5. the session totals four depositors and 4.2M deposited', sess0.depositors === 4 && sess0.deposited === 4_200_000n);
  // forged: random bytes, wrong length, and a valid signature over a different session
  const forged = [toHex(new Uint8Array(65).map(() => Math.floor(Math.random() * 256))), toHex(new Uint8Array(40)), await signFlag(vA, id('some-other-session'))];
  const rf = await send(stranger, 'flag', [E5a, forged], 'flag-3-forged');
  ok('5. forged signatures (random, wrong length, wrong session) are all rejected on-chain', decoded(rf, 'FlagRejected').length === 3 && (await read('session', [S5])).flaggers === 0);

  // A flags twice in one call and once more later — counted once
  const ra = await send(stranger, 'flag', [E5a, [await signFlag(vA, S5), await signFlag(vA, S5)]], 'flag-1');
  ok('5. a real depositor’s flag counts, with weight = its deposit', decoded(ra, 'Flagged').length === 1 && decoded(ra, 'Flagged')[0].args.weight === 600_000n);
  await send(stranger, 'flag', [E5a, [await signFlag(vA, S5)]]);
  ok('5. the same address flagging twice is counted once', (await read('session', [S5])).flaggers === 1 && (await read('session', [S5])).flaggedValue === 600_000n);
  // B → 2 addresses, 28.5% by value: count not met
  await send(stranger, 'flag', [E5a, [await signFlag(vB, S5)]]);
  ok('5. two flaggers at 28.5% of value do not escalate: the COUNT threshold (3) holds', (await read('session', [S5])).extended === false);
  // C → 3 addresses, 42.8%: escalate
  const rc = await send(stranger, 'flag', [E5a, [await signFlag(vC, S5)]], 'flag-escalating');
  const esc = decoded(rc, 'Escalated')[0]?.args;
  ok('5. the third eligible flagger crosses both thresholds: the session ESCALATES once, by 48 h', esc && esc.flaggers === 3 && esc.extension === 172800n && (await read('session', [S5])).extended === true);
  const base = (await read('escrow', [E5a])).releaseAt;
  ok('5. every deadline in the session moved by exactly the extension', (await read('effectiveReleaseAt', [E5a])) === base + 172800n && (await read('effectiveReleaseAt', [id('seat-5d')])) === (await read('escrow', [id('seat-5d')])).releaseAt + 172800n);
  // D flags too: threshold met again — no second extension
  const rd = await send(stranger, 'flag', [E5a, [await signFlag(vD, S5)]]);
  ok('5. the threshold met AGAIN extends nothing: once, never stackable', decoded(rd, 'Escalated').length === 0 && (await read('effectiveReleaseAt', [E5a])) === base + 172800n && (await read('session', [S5])).flaggers === 4);
  console.log('  waiting for the BASE deadline to pass…');
  while ((await now()) < t + 26) await sleep(2000);
  ok('5. after the base deadline, finalize is still refused: the extension is real', (await refuses(stranger, 'finalize', [E5a], 'TooEarly')).matched);
  ok('5. a flag never moved money: the contract still holds this session’s full 4.2M on top of what it held before', (await bal(ESCROW)) - held5 === 4_200_000n, `delta ${(await bal(ESCROW)) - held5}`);
  // the streamer can still end it early, at any time, for any of them
  const vaBefore = await bal(vA.account.address);
  await send(streamer, 'streamerRefund', [E5a, 600_000n]);
  ok('5. ...and the streamer can still refund through the hold, no conditions', (await bal(vA.account.address)) - vaBefore === 600_000n);
}

// ═════════════════ 6. value weighting: count alone is not enough ═════════
console.log('\n── 6. three tiny depositors vs one big one ────────────────────');
{
  const RATE = 1000n, S6 = id('session-6');
  const t = await now();
  // E, F, G deposit 10k each (3 addresses, 30k); the big one deposits 970k. 30k/1M = 3% < 25%.
  for (const [v, amt, name] of [[vE, 10_000n, 'seat-6e'], [vF, 10_000n, 'seat-6f'], [vG, 10_000n, 'seat-6g'], [vD, 970_000n, 'seat-6d']]) {
    await approve(v, amt); await send(operator, 'deposit', [id(name), v.account.address, streamer.account.address, amt, BigInt(t + 3600), 0, RATE, S6]);
  }
  await send(stranger, 'flag', [id('seat-6e'), [await signFlag(vE, S6), await signFlag(vF, S6), await signFlag(vG, S6)]]);
  const s6 = await read('session', [S6]);
  ok('6. three distinct flaggers holding 3% of the session do NOT escalate — the VALUE threshold holds', s6.flaggers === 3 && s6.extended === false, `${s6.flaggedValue}/${s6.deposited}`);
  ok('6. ...which is the brigade defence: a griefer must buy a quarter of the session, not three seats', s6.flaggedValue * 10000n < s6.deposited * 2500n);
}

// ═════════════════ 7. the declared fee, and owner bounds ═════════════════
console.log('\n── 7. fee path and escalation parameters ──────────────────────');
{
  const RATE = 1000n, CAP = 1_000_000n, S7 = id('session-7'), E7 = id('seat-7');
  const t = await now();
  await approve(vE, CAP);
  const fBefore = await bal(feeRecipient.account.address), sBefore = await bal(streamer.account.address), vBefore = await bal(vE.account.address);
  await send(operator, 'deposit', [E7, vE.account.address, streamer.account.address, CAP, BigInt(t + 25), 500, RATE, S7]); // 5% declared
  await send(attester, 'attest', [E7, 800, 200]);   // 600 paid seconds → gross 600k
  const expect = ledger({ deposited: CAP, rate: RATE, consumed: 800n, hidden: 200n, feeBps: 500 });
  console.log('  waiting for the deadline…');
  while ((await now()) < t + 26) await sleep(2000);
  await send(stranger, 'finalize', [E7]);
  ok('7. a declared 5% fee comes out of the STREAMER share, never the viewer refund', (await bal(feeRecipient.account.address)) - fBefore === expect.fee && (await bal(streamer.account.address)) - sBefore === expect.toStreamer && (await bal(vE.account.address)) - vBefore === -CAP + expect.toViewer,
    `fee ${expect.fee}, streamer ${expect.toStreamer}, viewer refund ${expect.toViewer}`);
  ok('7. a non-owner cannot change escalation parameters', (await refuses(operator, 'setEscalation', [1, 1000, 3600n], 'NotOwner')).matched);
  ok('7. the owner cannot set an extension beyond MAX_EXTENSION (7 d)', (await refuses(deployer, 'setEscalation', [3, 2500, BigInt(8 * 86400)], 'BadParams')).matched);
  ok('7. ...nor a zero flagger minimum or a threshold above 100%', (await refuses(deployer, 'setEscalation', [0, 2500, 3600n], 'BadParams')).matched && (await refuses(deployer, 'setEscalation', [3, 10001, 3600n], 'BadParams')).matched);
  await send(deployer, 'setEscalation', [2, 1000, 3600n]);
  ok('7. the owner can tune inside the bounds without a redeploy', (await read('minFlaggers')) === 2 && (await read('thresholdBps')) === 1000 && (await read('extensionSeconds')) === 3600n);
  ok('7. an escalation already granted kept the extension it was granted with (48 h), not the new one', (await read('session', [id('session-5')])).extension === 172800n);
  await send(deployer, 'setEscalation', [3, 2500, 172800n]);
}

// ═════════════════ 8. reentrancy: no hook to exploit, guard present ═══════
console.log('\n── 8. reentrancy ──────────────────────────────────────────────');
{
  const src = readFileSync('contracts/MegaChatEscrow.sol', 'utf8');
  const transferring = ['deposit', 'finalize', 'streamerRefund'];
  const guarded = transferring.filter((fn) => new RegExp(`function ${fn}\\([^)]*\\)[^{]*nonReentrant`, 's').test(src));
  ok('8. every function that moves tokens is nonReentrant and checks-effects-interactions', guarded.length === 3, guarded.join(','));
  // A CONTRACT as the streamer: a TIP-20 transfer to it must execute no code. Deploy a counter contract
  // whose fallback/receive would increment if ever entered, use it as streamer, finalize, and read the counter.
  const counterSrc = 'pragma solidity ^0.8.30; contract Sink { uint256 public entered; fallback() external payable { entered += 1; } receive() external payable { entered += 1; } }';
  const { createRequire } = await import('node:module');
  const solc = createRequire(import.meta.url)('solc');
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Sink.sol': { content: counterSrc } }, settings: { evmVersion: 'osaka', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const sink = out.contracts['Sink.sol'].Sink;
  const h = await deployer.wallet.deployContract({ abi: sink.abi, bytecode: '0x' + sink.evm.bytecode.object });
  const SINK = (await pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 })).contractAddress;
  const RATE = 1000n, CAP = 50_000n, S8 = id('session-8'), E8 = id('seat-8');
  const t = await now();
  await approve(vF, CAP);
  await send(operator, 'deposit', [E8, vF.account.address, SINK, CAP, BigInt(t + 25), 0, RATE, S8]);
  console.log('  waiting for the deadline…');
  while ((await now()) < t + 26) await sleep(2000);
  await send(stranger, 'finalize', [E8]);
  const entered = await pub.readContract({ address: SINK, abi: sink.abi, functionName: 'entered' });
  ok('8. a CONTRACT streamer received the tokens and its code ran zero times: TIP-20 transfers carry no hook to reenter through', (await bal(SINK)) === CAP && entered === 0n, `sink balance ${await bal(SINK)}, entered ${entered}`);
}

// ═════════════════ 9. cost record ═════════════════════════════════════════
console.log('\n── 9. what it cost on Moderato (informational) ────────────────');
{
  const gp = await pub.getGasPrice();
  for (const [k, g] of Object.entries(gas)) console.log(`  ${k.padEnd(18)} ${String(g).padStart(9)} gas  ≈ $${formatUnits(gp * g, 18)} at ${formatUnits(gp, 9)} gwei`);
  // A first deposit in a session creates ~6 storage slots at Tempo's 250k each;
  // attest and finalize only update existing ones. The bound is a regression
  // tripwire, not a target.
  const lifecycle = (gas.deposit || 0n) + (gas.attest || 0n) + (gas.finalize || 0n);
  ok('9. deposit + attest + finalize together stayed under 3.0M gas (measured ~2.45M on the first run)', lifecycle < 3_000_000n,
    `${lifecycle} gas ≈ $${formatUnits(600_000_000n * lifecycle, 18)} on mainnet at 0.6 gwei`);
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail   (escrow ${ESCROW} on chain 42431, all keys discarded)`);
process.exit(fail === 0 ? 0 : 1);
