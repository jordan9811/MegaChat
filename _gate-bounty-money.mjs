/**
 * GATE — bounty real money (bounty-money.js, 2026-11-04).
 *
 * NO REAL CHAIN AND NO REAL MONEY. Section A drives bounty-escrow.js and
 * bounty-money.js against the REAL settlement door (createSettlement over a
 * temp ledger) with a mock chain adapter — the same has / transferFrom /
 * transfer / receipt shape as viemChainAdapter — and mock chain reads (an
 * approval table, a receipt built from the door's own pull row). Section B
 * boots the REAL server with BOUNTY_FUNDING=1, a bounty spender key generated
 * for this run and never funded anywhere, and TEMPO_RPC_URL pointed at a
 * JSON-RPC stand-in on 127.0.0.1: the real viemChainAdapter signs ahead, the
 * stand-in takes the raw transaction and answers its receipt with a Transfer
 * log, and nothing leaves the loopback. Section C boots the same server
 * WITHOUT the flag and shows the two modes disagree on the same request.
 *
 *   A1  real mode: a pledge is UNFUNDED — in no pool, not claimable, not sweepable
 *   A2  fund is refused, each reason by code, and every refusal charges nothing
 *   A3  fund: pulled ONCE by the bounty spender, OPEN, HELD, money-in row once,
 *       the pool shows it; a second fund, a reused approve, a reused signature refused
 *   A4  the receipt decides: reverted → unfunded and retryable; no receipt →
 *       pending then funded by sync; short → a person, no retry; a foreign
 *       receipt proves nothing; a pre-send throw → unfunded; a post-send throw →
 *       pending for a person, never pulled twice, then decided from the chain
 *   A5  release: owed until the owner sets a payout wallet, then two door
 *       intents (contributor, platform match) exactly the ledger amounts;
 *       PENDING without a payout key, DONE and `paid` with one; the funded cap
 *   A6  refund on expiry → a door intent to the FUNDING wallet, once; a seeded
 *       (ledger-only) contribution pays nobody
 *   A7  abandon: an unfunded pledge is closed after the window; one with a pull
 *       in flight is not
 *   A8  DISCRIMINATES: ledger-only mode (the flag off) makes the same pledge HELD
 *       at once and records only stub intents
 *   B   HTTP, real server + real adapter + RPC stand-in: pledge → needsApproval
 *       → upload refused → fund (approve + EIP-712) → one raw send → OPEN → upload
 *       → expiry → a PENDING door refund → listed and VOIDED by an admin
 *   C   HTTP, flag off: the same pledge is HELD and uploadable at once
 */
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { encodeEventTopics, encodeAbiParameters, erc20Abi, keccak256 } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const quiet = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e }; } };

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-bounty-money-'));
const DATA = path.join(SCRATCH, 'data');
mkdirSync(DATA, { recursive: true });
// The bounty store and the evidence log resolve DATA_DIR at import.
process.env.DATA_DIR = DATA;
process.env.BOUNTY_CLAIM = '1';
process.env.BOUNTY_FUNDING = '1';
process.env.BOUNTY_IDENTITY_STUB = '1';
process.env.BOUNTY_PLEDGE_MIN_EXPIRY_MS = '300';

const TOKEN = { address: '0x20c000000000000000000000b9537d11c60e8b50', decimals: 6, symbol: 'USDC' };
const PLATFORM = '0xBda93161Cca91A8e7953Ee5AF8807e9752Fcb55E';
const SPENDER = '0x00000000000000000000000000000000000000c3';
const STREAMER_WALLET = '0x00000000000000000000000000000000000000b2';

const store = await import('./bounty-store.js');
const escrow = await import('./bounty-escrow.js');
const { bountyConfig } = await import('./bounty-claim.config.js');
const facadeMod = await import('./bounty-settlement.js');
const { createBountyMoney, pledgeTypedData, STUCK_FUNDING_MS } = await import('./bounty-money.js');
const { createSettlement } = await import('./settlement.js');
// What attachBountyRoutes does at boot: a release refuses to pay against an
// evidence log nobody validated (evidence_unverified).
store.verifyLedgerIntegrity();
store.verifyEvidenceIntegrity();

function fakeChain({ signers = ['bountyPull', 'platform'] } = {}) {
  let seq = 0;
  const chain = {
    transfers: [], pulls: [], receiptMode: 'success',
    has(slot) { return signers.includes(slot); },
    address(slot) { return slot === 'bountyPull' ? SPENDER : slot === 'platform' ? PLATFORM : null; },
    async transferFrom(a) { chain.pulls.push(a); return `0xpull${String(++seq).padStart(60, '0')}`; },
    async transfer(a) { if (!signers.includes(a.signer)) throw new Error(`no ${a.signer} signer`); chain.transfers.push(a); return `0xsend${String(++seq).padStart(60, '0')}`; },
    async receipt() { return chain.receiptMode === 'none' ? null : { status: chain.receiptMode === 'reverted' ? 'reverted' : 'success', blockNumber: '1' }; },
  };
  return chain;
}
function transferLog({ token, from, to, value }) {
  return { address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(value)]) };
}
/** The receipt of the pull the door recorded under `hash`, as the chain would answer. */
function receiptFor(door, hash, { status = 'success', value = null, hashOverride = null } = {}) {
  if (!status) return null;
  const rec = door.all().find((r) => r.kind === 'pull' && String(r.txHash || '').toLowerCase() === String(hash || '').toLowerCase());
  const row = rec?.rows?.find((x) => x.type === 'PULL' || x.type === 'PULL_SENT');
  const logs = status === 'success' && row ? [transferLog({ token: row.token.address, from: row.from, to: row.to, value: value ?? row.amountAtomic })] : [];
  return { status, transactionHash: hashOverride || hash, logs };
}
const APPROVALS = new Map();
let approveSeq = 0;
function approvalFor(p, wallet, over = {}) {
  const hash = `0x${(++approveSeq).toString(16).padStart(64, 'a')}`;
  const atomic = BigInt(Math.round(parseFloat(p.amount) * 1e6)).toString();
  APPROVALS.set(hash, { from: wallet, to: TOKEN.address, status: 'success', timestampMs: Date.now(), approvals: [{ token: TOKEN.address, owner: wallet, spender: SPENDER, value: atomic }], ...over });
  return hash;
}
let proofSeq = 0;
async function proofFor(p, acct, { deadline = null, over = {} } = {}) {
  const atomic = BigInt(Math.round(parseFloat(p.amount) * 1e6)).toString();
  // A distinct deadline per proof: one signed message funds at most one
  // attempt (the hash covers the deadline), and a real wallet signs a fresh
  // one on each retry; two proofs inside one second here would collide.
  const dl = deadline ?? Math.floor(Date.now() / 1000) + 300 + (++proofSeq);
  const td = pledgeTypedData({ chainId: 4217, pledgeId: p.id, wallet: acct.address, token: TOKEN.address, amountAtomic: atomic, deadline: dl, ...over });
  const signature = await acct.signTypedData(td);
  return { signature, typedData: { ...td, message: { ...td.message, amountAtomic: String(td.message.amountAtomic), deadline: String(td.message.deadline) } } };
}
const WALLETS = new Map();
const doorAt = (name, chain = fakeChain()) => createSettlement({ dataDir: path.join(SCRATCH, name), chain, platformAddress: PLATFORM, log: quiet });
function makeMoney(door, over = {}) {
  return createBountyMoney({
    door, token: TOKEN, platformAddress: PLATFORM, spender: SPENDER, chainId: 4217,
    readAllowance: async () => 10n ** 12n,
    readApproval: async (h) => APPROVALS.get(h) || null,
    confirmTx: async (h) => receiptFor(door, h),
    payoutWalletFor: (id) => WALLETS.get(id) || null,
    log: quiet, ...over,
  });
}
const fan = privateKeyToAccount(generatePrivateKey());
const fanB = privateKeyToAccount(generatePrivateKey());
const ACCT = 'acct_gatefan0001';
const who = { accountId: ACCT };
const pledgeFor = (handle, amount, { contributor = ACCT, expiresInMs = 24 * 3600_000 } = {}) =>
  escrow.pledge({ targets: [{ platform: 'twitch', handle }], contributor, amount, expiresInMs });
const fundOk = async (money, p, acct = fan) => money.fund(p.id, { wallet: acct.address, approveTx: approvalFor(p, acct.address), ...(await proofFor(p, acct)) }, who);

console.log('\n── Gate: bounty real money ─────────────────────────────────');
console.log(`   scratch ${SCRATCH}`);

try {
  // ── A1: real mode — a pledge is UNFUNDED and counts nowhere ───────────────
  {
    const door = doorAt('a1');
    const money = makeMoney(door);
    facadeMod.setBountySettlement(money);
    const out = pledgeFor('bm-a1', '5');
    const key = out.pledge.targets[0];
    ok('A1. real mode: a new pledge is UNFUNDED and its contribution UNFUNDED', out.requiresFunding === true && out.pledge.status === 'UNFUNDED' && out.contribution.status === 'UNFUNDED');
    const pool = store.getPool(key);
    ok('A1. ...it counts in NO pool figure', pool.totalContributed === 0 && pool.remaining === 0 && pool.contributionCount === 0, JSON.stringify({ t: pool.totalContributed, r: pool.remaining, c: pool.contributionCount }));
    ok('A1. ...no money-in row is on the bounty ledger yet', store.listLedger({ handleKey: key, type: 'CONTRIBUTION' }).length === 0);
    ok('A1. ...it is not OPEN: not claimable, not shown as money', store.listPledges({ status: 'OPEN', handleKey: key }).length === 0 && escrow.poolView(key).openPledges === 0);
    ok('A1. ...and a claim wins nothing from it', escrow.claimPledges(key).length === 0 && store.getPledge(out.pledge.id).status === 'UNFUNDED');
    ok('A1. ...nor does the expiry sweep refund it (nothing came in)', escrow.sweepExpiredPledges({ settlement: facadeMod.settlement }).length === 0 && door.all().length === 0);
    ok('A1. ...and moneyCameIn says so', store.moneyCameIn(out.contribution) === false);
  }

  // ── A2: every refusal, by code; nothing charged ───────────────────────────
  {
    const chain = fakeChain();
    const door = doorAt('a2', chain);
    const money = makeMoney(door);
    facadeMod.setBountySettlement(money);
    const { pledge: p } = pledgeFor('bm-a2', '7');
    const code = async (fn) => (await attempt(fn)).error?.code || 'OK';
    bountyConfig.fundingEnabled = false;
    ok('A2. funding off → funding_off', await code(() => money.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fan.address) }, who)) === 'funding_off');
    bountyConfig.fundingEnabled = true;
    const noSpender = makeMoney(door, { spender: null });
    ok('A2. no spender configured → no_pull_signer', await code(() => noSpender.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fan.address) }, who)) === 'no_pull_signer');
    const noSigner = makeMoney(doorAt('a2b', fakeChain({ signers: ['platform'] })));
    ok('A2. the door has no bountyPull signer → no_pull_signer', await code(() => noSigner.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fan.address) }, who)) === 'no_pull_signer');
    ok('A2. not the owner → forbidden', await code(() => money.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fan.address) }, { accountId: 'acct_someone' })) === 'forbidden');
    ok('A2. a bad wallet → invalid', await code(() => money.fund(p.id, { wallet: 'nope', approveTx: approvalFor(p, fan.address) }, who)) === 'invalid');
    ok('A2. no approve tx → approve_required', await code(() => money.fund(p.id, { wallet: fan.address }, who)) === 'approve_required');
    ok('A2. an approve not on chain → approve_invalid', await code(() => money.fund(p.id, { wallet: fan.address, approveTx: `0x${'ff'.repeat(32)}` }, who)) === 'approve_invalid');
    ok('A2. an approve from another wallet → approve_invalid', await code(() => money.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fanB.address) }, who)) === 'approve_invalid');
    ok('A2. an approve made before the pledge existed → approve_invalid', await code(() => money.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fan.address, { timestampMs: p.createdAt - 5000 }) }, who)) === 'approve_invalid');
    ok('A2. an approve for the wrong amount → approve_invalid', await code(() => money.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fan.address, { approvals: [{ token: TOKEN.address, owner: fan.address, spender: SPENDER, value: '1' }] }) }, who)) === 'approve_invalid');
    ok('A2. an approve to another spender → approve_invalid', await code(() => money.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fan.address, { approvals: [{ token: TOKEN.address, owner: fan.address, spender: PLATFORM, value: '7000000' }] }) }, who)) === 'approve_invalid');
    ok('A2. a good approve and no signature → signature_required', await code(() => money.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fan.address) }, who)) === 'signature_required');
    ok('A2. a signature by another key → signature_invalid', await code(async () => money.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fan.address), ...(await proofFor(p, fanB)) }, who)) === 'signature_invalid');
    ok('A2. an expired signature → signature_expired', await code(async () => money.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fan.address), ...(await proofFor(p, fan, { deadline: Math.floor(Date.now() / 1000) - 10 })) }, who)) === 'signature_expired');
    ok('A2. a signature naming another pledge → signature_invalid', await code(async () => money.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fan.address), ...(await proofFor({ ...p, id: 'other-pledge' }, fan)) }, who)) === 'signature_invalid');
    const poor = makeMoney(door, { readAllowance: async () => 1n });
    const r = await attempt(async () => poor.fund(p.id, { wallet: fan.address, approveTx: approvalFor(p, fan.address), ...(await proofFor(p, fan)) }, who));
    ok('A2. an allowance below the pledge → insufficient_allowance, with the allowance', r.error?.code === 'insufficient_allowance' && r.error.allowance === '1');
    const after = store.getPledge(p.id);
    ok('A2. after every refusal: still UNFUNDED, no funding attempt, ZERO pulls on the chain, the pool still empty',
      after.status === 'UNFUNDED' && !after.funding && chain.pulls.length === 0 && door.all().length === 0 && store.getPool(p.targets[0]).totalContributed === 0);
  }

  // ── A3: fund — pulled once, OPEN, HELD, the pool shows it ─────────────────
  {
    const chain = fakeChain();
    const door = doorAt('a3', chain);
    const money = makeMoney(door);
    facadeMod.setBountySettlement(money);
    const { pledge: p, contribution: c } = pledgeFor('bm-a3', '5');
    const key = p.targets[0];
    const approveTx = approvalFor(p, fan.address);
    const proof = await proofFor(p, fan);
    const funded = await money.fund(p.id, { wallet: fan.address, approveTx, ...proof }, who);
    const pull = chain.pulls[0];
    ok('A3. fund: the door pulled ONCE, by the bounty spender, exactly the pledge, into the platform wallet',
      chain.pulls.length === 1 && pull.signer === 'bountyPull' && pull.from === fan.address && pull.to === PLATFORM && pull.amountAtomic === 5000000n, `${chain.pulls.length} pull(s)`);
    ok('A3. ...the pledge is OPEN with a confirmed funding record, the contribution HELD', funded.status === 'OPEN' && funded.funding?.state === 'confirmed' && funded.funding.wallet === fan.address && store.getContribution(c.id).status === 'HELD');
    ok('A3. ...the door row is PULLED under bounty:fund:<pledge>:1', door.status(`bounty:fund:${p.id}:1`)?.status === 'PULLED');
    const rows = store.listLedger({ handleKey: key, type: 'CONTRIBUTION' });
    ok('A3. ...ONE money-in row on the bounty ledger, naming the funding', rows.length === 1 && rows[0].meta?.funding?.ref === `bounty:fund:${p.id}:1` && rows[0].amount === '5');
    const pool = store.getPool(key);
    ok('A3. ...the pool shows the money', pool.totalContributed === 5 && pool.remaining === 5 && pool.contributionCount === 1 && escrow.poolView(key).openPledges === 1);
    ok('A3. ...fundedAtomicFor reads it back from the funding record', money.fundedAtomicFor(key) === 5000000n);
    const again = await attempt(() => money.fund(p.id, { wallet: fan.address, approveTx, ...proof }, who));
    ok('A3. a second fund of a funded pledge → already_funded, no second pull', again.error?.code === 'already_funded' && chain.pulls.length === 1);
    // Reuse needs an approve that POSTDATES both pledges (an older one is
    // refused earlier, as made before the pledge existed): pledge first.
    const { pledge: p2 } = pledgeFor('bm-a3b', '5');
    const { pledge: pA } = pledgeFor('bm-a3a', '5');
    const sharedApprove = approvalFor(pA, fan.address);
    await money.fund(pA.id, { wallet: fan.address, approveTx: sharedApprove, ...(await proofFor(pA, fan)) }, who);
    const reuse = await attempt(async () => money.fund(p2.id, { wallet: fan.address, approveTx: sharedApprove, ...(await proofFor(p2, fan)) }, who));
    ok('A3. the same approve on ANOTHER pledge → approve_reused', reuse.error?.code === 'approve_reused' && chain.pulls.length === 2, reuse.error?.code);
    const { pledge: p3 } = pledgeFor('bm-a3c', '5');
    const sigReuse = await attempt(() => money.fund(p3.id, { wallet: fan.address, approveTx: approvalFor(p3, fan.address), ...proof }, who));
    ok('A3. the same signature again → refused (it names the first pledge)', ['signature_reused', 'signature_invalid'].includes(sigReuse.error?.code) && chain.pulls.length === 2, sigReuse.error?.code);
    ok('A3. markPledgeFunded is idempotent: an OPEN pledge is returned as is', escrow.markPledgeFunded(p.id, { funding: funded.funding }).deduped === true && store.listLedger({ handleKey: key, type: 'CONTRIBUTION' }).length === 1);
  }

  // ── A4: the receipt decides ──────────────────────────────────────────────
  {
    // (a) reverted → back to unfunded, retryable, exactly one more pull
    const chain = fakeChain();
    const door = doorAt('a4', chain);
    let receiptStatus = 'reverted';
    const money = makeMoney(door, { confirmTx: async (h) => receiptFor(door, h, { status: receiptStatus }) });
    facadeMod.setBountySettlement(money);
    const { pledge: p } = pledgeFor('bm-a4', '2');
    const rev = await attempt(() => fundOk(money, p));
    let cur = store.getPledge(p.id);
    ok('A4a. a REVERTED receipt → pull_reverted; the pledge is UNFUNDED again with the failure on record', rev.error?.code === 'pull_reverted' && cur.status === 'UNFUNDED' && cur.funding === null && cur.fundingFailures?.length === 1);
    receiptStatus = 'success';
    const second = await fundOk(money, p);
    ok('A4a. ...a fresh approve and signature fund it on attempt 2', second.status === 'OPEN' && second.funding.attempt === 2 && chain.pulls.length === 2 && door.status(`bounty:fund:${p.id}:2`)?.status === 'PULLED');

    // (b) no receipt → pending; sync with a receipt → funded, no second pull
    let answer = null;
    const money2 = makeMoney(door, { confirmTx: async (h) => (answer ? receiptFor(door, h) : null) });
    facadeMod.setBountySettlement(money2);
    const { pledge: q } = pledgeFor('bm-a4b', '2');
    const pend = await fundOk(money2, q);
    ok('A4b. NO receipt yet → the pledge stays UNFUNDED with funding `pending` and the hash on record', pend.status === 'UNFUNDED' && pend.funding?.state === 'pending' && !!pend.funding.txHash);
    const busy = await attempt(() => fundOk(money2, q));
    ok('A4b. ...a second fund meanwhile → funding_in_progress (never pulled twice)', busy.error?.code === 'funding_in_progress' && chain.pulls.length === 3);
    answer = true;
    const s = await money2.sync();
    await sleep(50);
    cur = store.getPledge(q.id);
    ok('A4b. ...sync asks the chain again and the receipt funds it, once', s.pending === 1 && cur.status === 'OPEN' && cur.funding.state === 'confirmed' && chain.pulls.length === 3);

    // (c) short transfer → a person; no retry
    const money3 = makeMoney(door, { confirmTx: async (h) => receiptFor(door, h, { value: '1000000' }) });
    facadeMod.setBountySettlement(money3);
    const { pledge: sh } = pledgeFor('bm-a4c', '2');
    const short = await attempt(() => fundOk(money3, sh));
    cur = store.getPledge(sh.id);
    ok('A4c. a receipt whose Transfer is SHORT → funding_short; UNFUNDED, flagged for a person, nothing credited',
      short.error?.code === 'funding_short' && cur.status === 'UNFUNDED' && cur.funding?.state === 'short' && !!cur.funding.needsPerson && store.getPool(sh.targets[0]).totalContributed === 0);
    const retry = await attempt(() => fundOk(money3, sh));
    ok('A4c. ...the fan cannot fund it again (a retry could charge twice) → funding_needs_person', retry.error?.code === 'funding_needs_person');
    ok('A4c. ...an unproven receipt (no Transfer at all) is the same: a person', (await attempt(async () => {
      const m = makeMoney(door, { confirmTx: async (h) => ({ ...receiptFor(door, h), logs: [] }) });
      facadeMod.setBountySettlement(m);
      const { pledge: u } = pledgeFor('bm-a4c2', '2');
      return fundOk(m, u);
    })).error?.code === 'funding_unproven');

    // (d) a receipt for ANOTHER hash proves nothing
    const money4 = makeMoney(door, { confirmTx: async (h) => receiptFor(door, h, { hashOverride: `0x${'ee'.repeat(32)}` }) });
    facadeMod.setBountySettlement(money4);
    const { pledge: f } = pledgeFor('bm-a4d', '2');
    const foreign = await fundOk(money4, f);
    ok('A4d. a receipt answering for a DIFFERENT hash is ignored: pending, not funded', foreign.status === 'UNFUNDED' && foreign.funding?.state === 'pending');

    // (e) a pull that throws BEFORE anything was sent → unfunded, retryable
    const chainE = fakeChain();
    chainE.transferFrom = async () => { throw Object.assign(new Error('execution reverted'), { name: 'EstimateGasExecutionError' }); };
    const doorE = doorAt('a4e', chainE);
    const moneyE = makeMoney(doorE);
    facadeMod.setBountySettlement(moneyE);
    const { pledge: e } = pledgeFor('bm-a4e', '2');
    const pre = await attempt(() => fundOk(moneyE, e));
    cur = store.getPledge(e.id);
    ok('A4e. a pull refused BEFORE sending (the gas estimate reverted) → pull_failed; UNFUNDED, no funding record, a failure logged', pre.error?.code === 'pull_failed' && cur.status === 'UNFUNDED' && cur.funding === null && cur.fundingFailures?.length === 1);

    // (f) a pull that throws AFTER it may have been sent → pending for a person; decided from the chain
    const chainF = fakeChain();
    chainF.transferFrom = async (a) => { chainF.pulls.push(a); throw new Error('HTTP request failed: timeout'); };
    const doorF = doorAt('a4f', chainF);
    let found = null;
    const moneyF = makeMoney(doorF, { findFundingTransfer: async () => found });
    facadeMod.setBountySettlement(moneyF);
    const { pledge: g } = pledgeFor('bm-a4f', '2');
    const post = await attempt(() => fundOk(moneyF, g));
    cur = store.getPledge(g.id);
    ok('A4f. a pull that threw after it MAY have been sent → pull_unconfirmed; the pledge stays locked for a person', post.error?.code === 'pull_unconfirmed' && cur.status === 'UNFUNDED' && cur.funding?.state === 'pulling' && !!cur.funding.needsPerson);
    const again = await attempt(() => fundOk(moneyF, g));
    ok('A4f. ...a second fund is refused; exactly ONE transfer reached the chain', ['funding_in_progress', 'funding_needs_person'].includes(again.error?.code) && chainF.pulls.length === 1, again.error?.code);
    found = { found: false };
    const s1 = await moneyF.sync({ force: true });
    cur = store.getPledge(g.id);
    ok('A4f. ...forced sync with NO Transfer on chain → back to unfunded (the fan may try again)', s1.failed.length === 1 && cur.status === 'UNFUNDED' && cur.funding === null);
    const { pledge: g2 } = pledgeFor('bm-a4f2', '2');
    await attempt(() => fundOk(moneyF, g2));
    found = { found: true, txHash: `0x${'dd'.repeat(32)}` };
    const moneyF2 = makeMoney(doorF, { findFundingTransfer: async () => found, confirmTx: async (h) => ({ status: 'success', transactionHash: h, logs: [transferLog({ token: TOKEN.address, from: fan.address, to: PLATFORM, value: '2000000' })] }) });
    facadeMod.setBountySettlement(moneyF2);
    const s2 = await moneyF2.sync({ force: true });
    cur = store.getPledge(g2.id);
    ok('A4f. ...and with the Transfer FOUND on chain, that transaction\'s receipt funds it', s2.funded.length === 1 && cur.status === 'OPEN' && cur.funding.txHash === found.txHash);
  }

  // ── A5: release — owed, then paid; the cap ───────────────────────────────
  {
    const chain = fakeChain({ signers: ['bountyPull'] }); // no payout key: intents stay PENDING
    const door = doorAt('a5', chain);
    const money = makeMoney(door);
    facadeMod.setBountySettlement(money);
    const { pledge: p } = pledgeFor('bm-a5', '5');
    const key = p.targets[0];
    await fundOk(money, p);
    store.updateReservedHandle(key, { claimedBy: 'streamerA', claimedByAccount: 'acct_streamerA' });
    const rel = escrow.release({ handleKey: key, claimId: null, airSessionId: null, verifiedClips: 1, verifiedClipSeconds: 10, confidence: 0.9, idempotencyKey: 'release:bm-a5', settlement: facadeMod.settlement });
    ok('A5. verified airtime releases from the ledger (0.25 + a 0.0625 match)', rel.released === 0.25 && rel.match === 0.0625 && rel.rows.length === 2, JSON.stringify({ r: rel.released, m: rel.match, skipped: rel.skipped, detail: rel.detail }));
    if (!rel.rows.length) throw new Error(`A5 release skipped: ${rel.skipped} ${JSON.stringify(rel.detail)}`);
    ok('A5. ...with no payout wallet the releases are OWED: no door intent yet', door.intentsFor('bounty:release:').length === 0 && money.payoutState(rel.rows[0].id) === 'owed');
    WALLETS.set('acct_streamerA', STREAMER_WALLET);
    const n = money.payAccount('acct_streamerA');
    const recs = door.intentsFor('bounty:release:');
    const contrib = door.status(`bounty:release:${rel.rows[0].id}`);
    const match = door.status(`bounty:release:${rel.rows[1].id}`);
    ok('A5. the wallet arrives → payAccount records TWO door intents, exactly the ledger amounts, to the payout wallet',
      n === 2 && recs.length === 2 && contrib?.amountAtomic === '250000' && contrib.to === STREAMER_WALLET && contrib.meta?.ledgerBucket === 'contributor' && contrib.meta?.bucket === 'bounty' && match?.amountAtomic === '62500' && match.meta?.ledgerBucket === 'platform_match' && match.meta?.bucket === 'bounty-match',
      `n=${n} recs=${recs.length} ${JSON.stringify(contrib?.meta)} ${match?.amountAtomic}`);
    ok('A5. ...PENDING on a door with no payout key; pending() lists them in the stub\'s shape', contrib.status === 'PENDING' && money.pending().length === 2 && money.pending()[0].kind === 'release' && money.payoutState(rel.rows[0].id) === 'pending');
    ok('A5. ...payOwed again records nothing new (idempotent on the door)', money.payOwed() === 0 && door.intentsFor('bounty:release:').length === 2);
    const dup = escrow.release({ handleKey: key, claimId: null, airSessionId: null, verifiedClips: 1, verifiedClipSeconds: 10, confidence: 0.9, idempotencyKey: 'release:bm-a5', settlement: facadeMod.settlement });
    ok('A5. the same verification again is deduped on the bounty ledger: no third intent', dup.deduped === true && door.intentsFor('bounty:release:').length === 2);
    const over = money.release({ amount: '100', bucket: 'contributor', ref: 'bm-a5-fake-row', handleKey: key, payeeAccount: 'acct_streamerA' });
    ok('A5. the funded cap: a contributor release past what was funded is REFUSED, not recorded', over.ok === false && over.refused === 'exceeds_funded' && door.status('bounty:release:bm-a5-fake-row') === null);
    // The payout key lands: a door over the same ledger with a platform signer pays both, once.
    const paid = fakeChain({ signers: ['bountyPull', 'platform'] });
    const door2 = createSettlement({ dataDir: path.join(SCRATCH, 'a5'), chain: paid, platformAddress: PLATFORM, log: quiet });
    const f = await door2.flush();
    const money2 = makeMoney(door2);
    ok('A5. the payout key lands → the first flush pays both intents, once; the fan\'s view says paid',
      f.sent.length === 2 && paid.transfers.length === 2 && paid.transfers.every((t) => t.to === STREAMER_WALLET && t.signer === 'platform') && money2.payoutState(rel.rows[0].id) === 'paid' && (await door2.flush()).sent.length === 0);
  }

  // ── A6: refund → the FUNDING wallet, once; ledger-only money pays nobody ──
  {
    const chain = fakeChain({ signers: ['bountyPull'] });
    const door = doorAt('a6', chain);
    const money = makeMoney(door);
    facadeMod.setBountySettlement(money);
    const { pledge: p, contribution: c } = pledgeFor('bm-a6', '3', { expiresInMs: 300 });
    await fundOk(money, p);
    await sleep(400);
    const swept = escrow.sweepExpiredPledges({ settlement: facadeMod.settlement });
    const rec = door.status(`bounty:refund:${c.id}`);
    ok('A6. an expired funded pledge → one door REFUND intent to the wallet that funded it, exactly the amount',
      swept.length === 1 && rec?.kind === 'refund' && rec.to === fan.address && rec.amountAtomic === '3000000' && rec.status === 'PENDING' && store.getContribution(c.id).status === 'REFUNDED');
    escrow.sweepExpiredPledges({ settlement: facadeMod.settlement });
    ok('A6. ...sweeping again records nothing more', door.intentsFor('bounty:refund:').length === 1 && money.refundState(c.id) === 'pending');
    const seed = escrow.pledge({ targets: [{ platform: 'twitch', handle: 'bm-a6seed' }], contributor: 'seed:demo', amount: '100', expiresInMs: 300, actor: 'admin' });
    ok('A6. a SEEDED pledge stays ledger-only even in real mode (HELD at once, nothing to fund)', seed.requiresFunding === false && seed.contribution.status === 'HELD' && seed.pledge.status === 'OPEN');
    await sleep(400);
    const swept2 = escrow.sweepExpiredPledges({ settlement: facadeMod.settlement });
    ok('A6. ...its expiry refund pays NOBODY: no funding wallet, no door intent', swept2.length === 1 && door.status(`bounty:refund:${seed.contribution.id}`) === null && store.getContribution(seed.contribution.id).status === 'REFUNDED');
    ok('A6. ...and fundedAtomicFor ignores ledger-only money', money.fundedAtomicFor(seed.pledge.targets[0]) === 0n);
  }

  // ── A7: abandon ──────────────────────────────────────────────────────────
  {
    const door = doorAt('a7');
    const money = makeMoney(door);
    facadeMod.setBountySettlement(money);
    const { pledge: p, contribution: c } = pledgeFor('bm-a7', '4');
    const { pledge: inflight } = pledgeFor('bm-a7b', '4');
    store.updatePledge(inflight.id, { funding: { state: 'pulling', ref: `bounty:fund:${inflight.id}:1`, at: new Date().toISOString() } });
    const early = escrow.sweepUnfundedPledges({ olderThanMs: 60_000 });
    ok('A7. inside the window nothing is abandoned', early.length === 0 && store.getPledge(p.id).status === 'UNFUNDED');
    const late = escrow.sweepUnfundedPledges({ olderThanMs: 0 });
    // Earlier sections left unfunded pledges of their own behind; this one is
    // among the abandoned, and the in-flight one is not.
    ok('A7. past it an unfunded pledge is ABANDONED with its contribution, no door row, no refund', late.some((x) => x.pledgeId === p.id) && !late.some((x) => x.pledgeId === inflight.id) && store.getPledge(p.id).status === 'ABANDONED' && store.getContribution(c.id).status === 'ABANDONED' && door.all().length === 0, `${late.length} abandoned`);
    ok('A7. ...a pledge with a pull IN FLIGHT is never abandoned by the timer', store.getPledge(inflight.id).status === 'UNFUNDED' && (await attempt(() => escrow.abandonPledge(inflight.id))).ok === false);
    ok('A7. ...the pool never saw either', store.getPool(p.targets[0]).totalContributed === 0 && store.getPool(p.targets[0]).contributionCount === 0);
  }

  // ── A8: DISCRIMINATES — ledger-only mode is the old behaviour ────────────
  {
    bountyConfig.fundingEnabled = false;
    facadeMod.setBountySettlement(null);
    const door = doorAt('a8');
    const out = pledgeFor('bm-a8', '9');
    const pool = store.getPool(out.pledge.targets[0]);
    ok('A8. flag OFF: the same pledge is HELD and OPEN at once, in the pool, with its money-in row', out.requiresFunding === false && out.contribution.status === 'HELD' && out.pledge.status === 'OPEN' && pool.totalContributed === 9 && store.listLedger({ handleKey: out.pledge.targets[0], type: 'CONTRIBUTION' }).length === 1);
    store.updateReservedHandle(out.pledge.targets[0], { claimedBy: 'x', claimedByAccount: 'acct_streamerA' });
    const rel = escrow.release({ handleKey: out.pledge.targets[0], claimId: null, airSessionId: null, verifiedClips: 1, verifiedClipSeconds: 10, confidence: 0.9, idempotencyKey: 'release:bm-a8', settlement: facadeMod.settlement });
    ok('A8. flag OFF: a release reaches the STUB (recorded, pays nobody) and the door never hears of it', rel.released > 0 && facadeMod.settlement.mode === 'ledger-only' && facadeMod.settlement.pending().length === 2 && door.all().length === 0);
    bountyConfig.fundingEnabled = true;
  }
} catch (e) {
  ok(`A. the section ran to the end (it crashed: ${e.stack || e.message})`, false);
}

// ── B: HTTP — the real server, the real adapter, an RPC stand-in ───────────
{
  const { startGateServer } = await import('./_gate-helpers.mjs');
  const { startRpcStandIn, block, receipt, tx, hex } = await import('./_gate-rpc-standin.mjs');
  const word = (n) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(n)]);
  const spenderKey = generatePrivateKey();
  const spender = privateKeyToAccount(spenderKey).address;
  const fanHttp = privateKeyToAccount(generatePrivateKey());
  const APPROVE_HASH = `0x${'ab'.repeat(32)}`;
  const AMOUNT = 5_000_000n;
  const st = { head: 2000, sends: 0, raw: null, pullHash: null };
  const node = await startRpcStandIn({
    eth_chainId: () => hex(4217),
    eth_blockNumber: () => hex(++st.head),
    eth_getBlockByNumber: ([n]) => block(n === 'latest' || n === 'pending' ? st.head : Number(BigInt(n))),
    eth_getTransactionCount: () => hex(st.sends),
    eth_gasPrice: () => hex(1_000_000_000n),
    eth_maxPriorityFeePerGas: () => '0x0',
    eth_estimateGas: () => hex(60_000),
    eth_getCode: () => '0x',
    eth_call: ([call]) => {
      const to = String(call?.to || '').toLowerCase();
      const sel = String(call?.data || call?.input || '').slice(0, 10);
      if (to === TOKEN.address.toLowerCase()) {
        if (sel === '0x313ce567') return word(6);
        if (sel === '0x95d89b41') return encodeAbiParameters([{ type: 'string' }], ['USDC']);
        if (sel === '0xdd62ed3e') return word(AMOUNT); // allowance(owner, spender)
        return word(0);
      }
      return word(1); // a deployless signature check, if viem makes one: valid
    },
    eth_sendRawTransaction: ([raw]) => { st.sends += 1; st.raw = raw; st.pullHash = keccak256(raw); return st.pullHash; },
    eth_getTransactionReceipt: ([h]) => {
      if (String(h).toLowerCase() === APPROVE_HASH) {
        const r = receipt(h, st.head - 1, fanHttp.address, TOKEN.address);
        r.logs = [{ address: TOKEN.address, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Approval', args: { owner: fanHttp.address, spender } }), data: word(AMOUNT), blockNumber: hex(st.head - 1), transactionHash: h, transactionIndex: '0x0', blockHash: `0x${(st.head - 1).toString(16).padStart(64, '0')}`, logIndex: '0x0', removed: false }];
        return r;
      }
      if (st.pullHash && String(h).toLowerCase() === st.pullHash.toLowerCase()) {
        const r = receipt(h, st.head, spender, TOKEN.address);
        r.logs = [{ ...transferLog({ token: TOKEN.address, from: fanHttp.address, to: PLATFORM, value: AMOUNT }), blockNumber: hex(st.head), transactionHash: h, transactionIndex: '0x0', blockHash: `0x${st.head.toString(16).padStart(64, '0')}`, logIndex: '0x0', removed: false }];
        return r;
      }
      return null;
    },
    eth_getTransactionByHash: ([h]) => {
      if (String(h).toLowerCase() === APPROVE_HASH) return tx(h, fanHttp.address, 0, TOKEN.address, '0x', st.head - 1);
      if (st.pullHash && String(h).toLowerCase() === st.pullHash.toLowerCase()) return tx(h, spender, 0, TOKEN.address, '0x', st.head);
      return null;
    },
  });
  const PORT = 3261;
  const base = `http://localhost:${PORT}`;
  let srv = null;
  try {
    srv = await startGateServer({
      port: PORT, dataDir: mkdtempSync(path.join(tmpdir(), 'mc-bm-http-')), label: 'bounty-money',
      bountyAuth: { handles: ['bmfan', 'bmstreamer'] },
      env: {
        BOUNTY_CLAIM: '1', BOUNTY_FUNDING: '1', BOUNTY_IDENTITY_STUB: '1', BOUNTY_PLEDGE_MIN_EXPIRY_MS: '400',
        BOUNTY_SPENDER_KEY: spenderKey, SELLER_WALLET_ADDRESS: PLATFORM, PLATFORM_SETTLEMENT_KEY: '',
        TEMPO_RPC_URL: node.url, TEMPO_USDC_ADDRESS: TOKEN.address,
        KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '', TWITCH_CLIENT_ID: '', KICK_CLIENT_ID: '',
      },
    });
    const call = (method, p, body, as = 'bmfan', extra = {}) => fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(as ? srv.headers(as) : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const cfg = await call('GET', '/api/bounty/config', undefined, null);
    ok('B. /api/bounty/config says real money, funding open, and names the spender a wallet approves', cfg.body.money?.mode === 'real' && cfg.body.money.fundingOpen === true && String(cfg.body.money.spender).toLowerCase() === spender.toLowerCase() && cfg.body.fundingEnabled === true, JSON.stringify(cfg.body.money));
    const pl = await call('POST', '/api/bounty/pledge', { targets: [{ platform: 'twitch', handle: 'bmtarget' }], contributor: 'Gate', amount: '5', expiresInMs: 400 });
    ok('B. POST /pledge → UNFUNDED, requiresFunding, and the approval ask (spender, holder, EIP-712 terms)',
      pl.status === 200 && pl.body.requiresFunding === true && pl.body.pledge?.status === 'UNFUNDED' && pl.body.funding?.needsApproval?.sign?.primaryType === 'Pledge' && pl.body.funding.needsApproval.holder === PLATFORM, `${pl.status} ${JSON.stringify(pl.body.funding?.needsApproval?.sign?.message)}`);
    const pledgeId = pl.body.pledge?.id;
    const up0 = await fetch(`${base}${pl.body.uploadUrl}?durationS=5`, { method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers('bmfan') }, body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 9)]) });
    ok('B. the clip upload is REFUSED before funding (409: the contribution is UNFUNDED)', up0.status === 409);
    const noWallet = await call('POST', `/api/bounty/pledge/${pledgeId}/fund`, {});
    const noApprove = await call('POST', `/api/bounty/pledge/${pledgeId}/fund`, { wallet: fanHttp.address });
    ok('B. fund with no wallet / no approve → needsApproval (walletRequired, approveRequired), nothing sent', noWallet.body.needsApproval?.walletRequired === true && noApprove.body.needsApproval?.approveRequired === true && st.sends === 0);
    const sign = pl.body.funding.needsApproval.sign;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const td = { domain: sign.domain, types: sign.types, primaryType: 'Pledge', message: { ...sign.message, wallet: fanHttp.address, deadline: String(deadline) } };
    const signature = await fanHttp.signTypedData({ domain: sign.domain, types: sign.types, primaryType: 'Pledge', message: { pledgeId: sign.message.pledgeId, wallet: fanHttp.address, token: sign.message.token, amountAtomic: BigInt(sign.message.amountAtomic), deadline: BigInt(deadline) } });
    const funded = await call('POST', `/api/bounty/pledge/${pledgeId}/fund`, { wallet: fanHttp.address, approveTx: APPROVE_HASH, signature, typedData: td });
    ok('B. fund with the approve and the signature → the REAL adapter signed ahead and sent ONE raw transaction to the node; the pledge is OPEN',
      funded.status === 200 && funded.body.ok === true && funded.body.pledge?.status === 'OPEN' && funded.body.funding?.state === 'funded' && st.sends === 1 && !!st.raw, `${funded.status} ${JSON.stringify(funded.body).slice(0, 220)}`);
    const again = await call('POST', `/api/bounty/pledge/${pledgeId}/fund`, { wallet: fanHttp.address, approveTx: APPROVE_HASH, signature, typedData: td });
    ok('B. fund again → already funded, no second send', again.status === 200 && again.body.already === true && st.sends === 1);
    const mine = await call('GET', '/api/bounty/my');
    const row = mine.body.contributions?.find((c) => c.pledgeId === pledgeId);
    ok('B. /api/bounty/my: pending_upload with funding `funded`', row?.state === 'pending_upload' && row.funding?.state === 'funded', JSON.stringify(row?.funding));
    const up1 = await fetch(`${base}${pl.body.uploadUrl}?durationS=5`, { method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers('bmfan') }, body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 9)]) });
    ok('B. ...and now the clip upload is accepted', up1.status === 200);
    const view = await call('GET', '/api/bounty/pool-view?platform=twitch&handle=bmtarget', undefined, null);
    ok('B. the pool shows the funded pledge', (view.body.view?.totalContributed ?? view.body.totalContributed) === 5, JSON.stringify(view.body).slice(0, 160));
    const seed = await call('POST', '/api/bounty/admin/seed-pledge', { targets: [{ platform: 'twitch', handle: 'bmseed' }], amount: '100' }, 'bmfan');
    ok('B. the admin seed route is refused in real-money mode (409)', seed.status === 409);
    await sleep(600);
    const swept = await call('POST', '/api/bounty/admin/sweep-pledges', {}, 'bmfan');
    ok('B. the pledge expires and the sweep refunds it', swept.status === 200 && swept.body.swept?.length === 1, JSON.stringify(swept.body).slice(0, 120));
    const anon = await fetch(`${base}/api/money/intents`).then((r) => r.status);
    const list = await call('GET', '/api/money/intents?status=PENDING', undefined, 'bmfan');
    const intent = list.body.intents?.find((i) => String(i.ref).startsWith('bounty:refund:'));
    ok('B. /api/money/intents: anonymous 401; the admin sees the PENDING refund — to the funding wallet, 5 USDC, with no payout key to pay it',
      anon === 401 && list.status === 200 && intent?.kind === 'refund' && String(intent.to).toLowerCase() === fanHttp.address.toLowerCase() && intent.amount === '5' && list.body.summary?.signers?.platform === false && list.body.summary.signers.bountyPull === true, `${anon} ${list.status} ${JSON.stringify(intent).slice(0, 160)}`);
    const noWhy = await call('POST', `/api/money/intents/${encodeURIComponent(intent?.ref || 'x')}/void`, {}, 'bmfan');
    const voided = await call('POST', `/api/money/intents/${encodeURIComponent(intent?.ref || 'x')}/void`, { why: 'gate: withdrawn by the owner' }, 'bmfan');
    const twice = await call('POST', `/api/money/intents/${encodeURIComponent(intent?.ref || 'x')}/void`, { why: 'again' }, 'bmfan');
    const voidedList = await call('GET', '/api/money/intents?status=VOIDED', undefined, 'bmfan');
    ok('B. void: refused without a why; VOIDED once by the admin; a second void → 409; listed as VOIDED with who and why',
      noWhy.status === 400 && voided.status === 200 && voided.body.status === 'VOIDED' && twice.status === 409 && voidedList.body.intents?.[0]?.voidWhy === 'gate: withdrawn by the owner', `${noWhy.status}/${voided.status}/${twice.status}`);
    const sync = await call('POST', '/api/bounty/admin/sync-funding', {}, 'bmfan');
    ok('B. the admin funding sync runs (nothing pending, nothing abandoned)', sync.status === 200 && sync.body.ok === true, JSON.stringify(sync.body).slice(0, 120));
    const sessions = await call('GET', '/api/bounty/admin/sessions', undefined, 'bmfan');
    ok('B. the admin sessions view reads the door\'s bounty intents (the voided refund is no longer pending)', sessions.status === 200 && Array.isArray(sessions.body.settlementIntents) && sessions.body.settlementIntents.length === 0);
    ok('B. the stand-in saw exactly one send and nothing left the loopback', st.sends === 1, `${node.seen.filter((m) => m === 'eth_sendRawTransaction').length} send(s) seen`);
  } catch (e) {
    ok(`B. the section ran to the end (it crashed: ${e.stack || e.message})`, false);
  } finally {
    srv?.kill();
    node?.close?.();
  }
}

// ── C: HTTP — flag OFF: the same request is ledger-only ────────────────────
{
  const { startGateServer } = await import('./_gate-helpers.mjs');
  const PORT = 3262;
  const base = `http://localhost:${PORT}`;
  let srv = null;
  try {
    srv = await startGateServer({
      port: PORT, dataDir: mkdtempSync(path.join(tmpdir(), 'mc-bm-off-')), label: 'bounty-money-off',
      bountyAuth: { handles: ['bmfan'] },
      env: { BOUNTY_CLAIM: '1', BOUNTY_FUNDING: '', BOUNTY_IDENTITY_STUB: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '', TWITCH_CLIENT_ID: '', KICK_CLIENT_ID: '' },
    });
    const call = (method, p, body, as = 'bmfan') => fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(as ? srv.headers(as) : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const cfg = await call('GET', '/api/bounty/config', undefined, null);
    const pl = await call('POST', '/api/bounty/pledge', { targets: [{ platform: 'twitch', handle: 'bmoff' }], contributor: 'Gate', amount: '5', expiresInMs: 86_400_000 });
    const up = await fetch(`${base}${pl.body.uploadUrl}?durationS=5`, { method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers('bmfan') }, body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 9)]) });
    const fund = await call('POST', `/api/bounty/pledge/${pl.body.pledge?.id}/fund`, { wallet: PLATFORM });
    ok('C. DISCRIMINATES (flag off): ledger-only config, the pledge is OPEN/HELD at once, the upload is accepted, and fund answers 503 funding_off',
      cfg.body.money?.mode === 'ledger-only' && pl.body.requiresFunding === false && pl.body.pledge?.status === 'OPEN' && pl.body.contribution?.status === 'HELD' && up.status === 200 && fund.status === 503 && fund.body.reason === 'funding_off',
      `${cfg.body.money?.mode} ${pl.body.pledge?.status} up=${up.status} fund=${fund.status}`);
  } catch (e) {
    ok(`C. the section ran to the end (it crashed: ${e.stack || e.message})`, false);
  } finally {
    srv?.kill();
  }
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
