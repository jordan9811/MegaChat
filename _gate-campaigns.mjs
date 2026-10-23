/**
 * GATE — targeted reward campaigns (campaign-engine.js and everything around it).
 *
 * NO REAL X CALLS AND NO REAL MONEY. The X adapter is a mock object handed to
 * the engine; the settlement door is the REAL createSettlement over a temp
 * ledger with a mock chain adapter (the same has / transferFrom / transfer /
 * receipt shape as viemChainAdapter). The HTTP section runs the real server
 * with every payout key blank and a freshly generated, empty pull key, so
 * nothing it records can be sent anywhere.
 *
 *   A  eligibility, rule by rule, with reasons — and DISCRIMINATION: a copy of
 *      campaign-eligibility.js with the "at least N" comparison broken fails
 *      the same assertions
 *   B  the frozen-list fingerprint: stable for the same ids, different for
 *      different ids, proofs verify
 *   C  the engine against the real door: funding (refused without the flag,
 *      without a pull signer, without allowance; pulled ONCE), one claim per X
 *      id and per account, budget and maxClaims, ineligible cannot record, the
 *      required state before any payout, never twice, never over budget,
 *      never for an ineligible claim, never on a closed campaign, the refund
 *      exactly once = funded − Σ releases, followedByFromSet disabled by
 *      default / cost-capped / counting the right direction, reference sets
 *      frozen, custom tokens
 *   C10 adversarial cases, each one a real-money defect an adversarial review
 *      reproduced against this engine (break.mjs): the token switched mid-pull,
 *      an unconfirmed or reverted funding receipt, close during a pull, parallel
 *      X spend past the budget, a stale check overwriting an owed claim, X cost
 *      after the refund, a FAILED payout, someone else's wallet as the funding
 *      source, claims honoured after close, a followedByFromSet rule with no
 *      `enabled`, deadline/budget validation, the funding-off route answer
 *   C10.F-K round 2: the funding wallet's EIP-712 signature (N10), the terms
 *      clock and same-second approves, the dedicated campaign spender, stuck
 *      funding, hidden stops payouts, the X-check ceiling, binding after the
 *      deadline, a LiveKit subscriber token posing as a webhook
 *   C10.U round 4 (the cold review, break-4.mjs) over `nonceChain`, a port of
 *      its mock: one nonce stream per spender, a mempool, blocks, Transfer logs
 *      and viem's replacement semantics — concurrent funds on one spender, a
 *      replacement receipt, a receipt with no matching Transfer, a short
 *      Transfer, a foreign send hash, a pull dropped by a same-nonce race, an
 *      off-air Call in, the door's x-cost, the overlay key in production, the
 *      unlock rate limit
 *   D  HTTP: every non-public route refuses an anonymous caller, admin routes
 *      refuse a non-admin, a Holler and a Call in with ?campaign= move a claim
 *      through the real letters queue and join route — the Call in ONLY from a
 *      signed LiveKit webhook, never from the client's camera_ready, and a
 *      Holler counts as aired only while the room is ON AIR (D4b) and only with
 *      the room's KEYED overlay connected (D4c, OPEN-ISSUES N14), a Call in only
 *      on air (D5b), /api/dashboard/unlock rate-limited and keyless for a
 *      password (D9) — the public page renders with its share metadata (after
 *      assertFreshBuild)
 *   E  Gate H, run as a subprocess: still 38/0
 *
 * `--engine-only` runs A–C only (the mutation runs that prove each C10 case
 * discriminates use it; see docs/internal/campaigns.md).
 */
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createHash, createHmac, randomBytes } from 'crypto';
import { pathToFileURL, fileURLToPath } from 'url';
import WebSocket from 'ws';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeEventTopics, encodeAbiParameters, erc20Abi } from 'viem';

// ── receipts as a chain writes them (cold review, round 4) ─────────────────
// The engine credits a pull only from the Transfer log in ITS OWN receipt
// (campaign-engine.js settleFunding), so every mock receipt here carries one:
// a raw ERC-20 Transfer log, encoded exactly as a node returns it.
function transferLog({ token, from, to, value }) {
  return { address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(value)]) };
}
/** The receipt of the pull the door recorded under `hash`: the chain did what it was asked. null status → no receipt yet. */
function receiptFor(door, hash, status = 'success') {
  if (!status) return null;
  const rec = door.all().find((r) => r.kind === 'pull' && String(r.txHash || '').toLowerCase() === String(hash || '').toLowerCase());
  const row = rec?.rows?.find((x) => x.type === 'PULL' || x.type === 'PULL_SENT');
  return { status, transactionHash: hash, logs: status === 'success' && row ? [transferLog({ token: row.token.address, from: row.from, to: row.to, value: row.amountAtomic })] : [] };
}

// ── seed mode: run as a child by section D (see there for why) ──────────────
globalThis.__seedApprovals = new Map();
if (process.argv[2] === '--seed-http') {
  const [dir, owner] = process.argv.slice(3);
  const rs = await import('./rooms-store.js');
  const { createSettlement: mkDoor } = await import('./settlement.js');
  const { createCampaignEngine: mkEngine, fundTypedData } = await import('./campaign-engine.js');
  const free = { passkeyTickPrice: '0', maxSeats: 3, letters: { enabled: true, price: '0', minSeconds: 1, maxSeconds: 10, autoRefundOnReject: true, moderation: 'auto' } };
  const stage = rs.createRoom('Gate stage', free);
  rs.setRoomHandle(stage.id, 'gatestage'); rs.setRoomOwner(stage.id, owner);
  const prod = rs.createRoom('Gate producer', { ...free, letters: { ...free.letters, moderation: 'approve' } });
  rs.setRoomHandle(prod.id, 'gateprod'); rs.setRoomOwner(prod.id, owner);
  const silent = { log() {}, warn() {}, error() {} };
  let n = 0;
  const chainStub = { has: () => true, async transferFrom() { n += 1; return `0x${String(n).padStart(64, 'f')}`; }, async transfer() { throw new Error('seed never pays'); }, async receipt() { return { status: 'success' }; } };
  const door = mkDoor({ dataDir: dir, chain: chainStub, platformAddress: '0x00000000000000000000000000000000000000aa', log: silent });
  const engine = mkEngine({
    dataDir: dir, settlement: door, platformAddress: '0x00000000000000000000000000000000000000aa',
    usdc: { address: '0x20c000000000000000000000b9537d11c60e8b50', decimals: 6, symbol: 'USDC' },
    readAllowance: async () => 10n ** 12n, confirmTx: async (h) => receiptFor(door, h), log: silent,
    readApproval: async (h) => SEED_APPROVALS.get(h) || null,
    resolveRoom: (h) => { const c = rs.getRoomByHandle(h); return c ? { id: c.id, ownerKey: rs.roomOwnerOf(c.id) } : null; },
  });
  const w = { accountId: owner, isAdmin: false };
  const SEED_APPROVALS = globalThis.__seedApprovals;
  const base = (title, action) => ({ title, blurb: 'Send a Holler on my stream and get paid for it.', action, reward: { type: 'usdc', amount: '5' }, budget: { amount: '12' }, maxClaims: 5, deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(), rules: { minFollowers: 10000 } });
  const funder = privateKeyToAccount(generatePrivateKey());
  const seedOne = async (input) => {
    const c = await engine.createCampaign(input, w);
    const wallet = funder.address;
    const hash = `0x${randomBytes(32).toString('hex')}`;
    SEED_APPROVALS.set(hash, { from: wallet, to: c.token.address, status: 'success', timestampMs: Date.parse(c.createdAt) + 1000, approvals: [{ token: c.token.address, owner: wallet, spender: '0x00000000000000000000000000000000000000aa', value: c.budget.atomic }] });
    const td = fundTypedData({ chainId: 4217, campaignId: c.id, wallet, token: c.token.address, amountAtomic: c.budget.atomic, deadline: Math.floor(Date.now() / 1000) + 300 });
    const signature = await funder.signTypedData(td);
    await engine.fund(c.id, { wallet, approveTx: hash, signature, typedData: { ...td, message: { ...td.message, amountAtomic: c.budget.atomic, deadline: String(td.message.deadline) } } }, w); engine.open(c.id, w); return engine.store.getCampaign(c.id);
  };
  const P = await seedOne(base('Approved Holler pays', { kind: 'holler', roomHandle: 'gatestage', require: 'approved' }));
  const Q = await seedOne(base('Aired Holler pays', { kind: 'holler', roomHandle: 'gateprod', require: 'aired' }));
  // The Call in room: ON AIR, like the producer room (a Call in counts only on
  // air since the cold review, B2). R2 is the same offer in the OFF-AIR stage
  // room (D5b).
  const call = rs.createRoom('Gate call', free);
  rs.setRoomHandle(call.id, 'gatecall'); rs.setRoomOwner(call.id, owner);
  const R = await seedOne(base('Call in pays', { kind: 'callin', roomHandle: 'gatecall', require: 'joined' }));
  const R2 = await seedOne(base('Call in off air', { kind: 'callin', roomHandle: 'gatestage', require: 'joined' }));
  // The producer room is ON AIR (an open airing, as followTick records when
  // Twitch says the channel is live); the stage room is not. A Holler counts
  // as aired only on air (D4 vs D4b).
  (await import('./airings-store.js')).openAiring({ roomId: prod.id, channel: 'gateprod' });
  (await import('./airings-store.js')).openAiring({ roomId: call.id, channel: 'gatecall' });
  const O = await seedOne(base('Aired Holler off air', { kind: 'holler', roomHandle: 'gatestage', require: 'aired' }));
  // N14 (D4c): ON AIR, but the overlay socket is not the room's keyed overlay.
  const Q2 = await seedOne(base('Aired Holler unkeyed overlay', { kind: 'holler', roomHandle: 'gateprod', require: 'aired' }));
  const Q3 = await seedOne(base('Aired Holler wrong overlay key', { kind: 'holler', roomHandle: 'gateprod', require: 'aired' }));
  const Q4 = await seedOne(base('Aired Holler keyed overlay too late', { kind: 'holler', roomHandle: 'gateprod', require: 'aired' }));
  console.log(JSON.stringify({ stage: { id: stage.id }, prod: { id: prod.id }, call: { id: call.id }, P, Q, R, R2, O, Q2, Q3, Q4 }));
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const ENGINE_ONLY = process.argv.includes('--engine-only');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log() {}, warn() {}, error() {} };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const attempt = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: e }; } };

for (const k of ['CAMPAIGN_FUNDING', 'X_BEARER_TOKEN', 'X_TOKEN_KEY']) delete process.env[k];
const SC = mkdtempSync(path.join(tmpdir(), 'mc-campaigns-'));
process.env.DATA_DIR = SC;

// ═══ A. eligibility ═══════════════════════════════════════════════════════
console.log('\n── A. eligibility, rule by rule ─────────────────────────────');
const elig = await import('./campaign-eligibility.js');
const NOW = Date.parse('2026-10-23T12:00:00Z');
const BASE = {
  followersCount: 12000, verifiedFollowersCount: 40, verified: true, verifiedType: 'blue', identityVerified: false,
  accountCreatedAt: '2020-01-01T00:00:00Z', postCount: 900, listedCount: 12, parody: false, protected: false,
  hasProfileImage: true, hasDescription: true,
};
const recs = (attrs, at = new Date().toISOString()) => Object.entries(attrs).map(([attribute, value]) => ({ attribute, value, source: 'x-api', trust: 100, fetchedAt: at }));
const xAccount = (attrs, platformId = '111') => ({ links: [{ provider: 'x', platformId, username: 'u', attributes: recs(attrs, '2026-10-23T00:00:00Z') }] });

function eligibilitySuite(evaluate) {
  const out = [];
  const ev = (rules, attrs = BASE, set = null, extra = {}) => evaluate({ rules }, xAccount(attrs), set, { now: NOW, ...extra });
  const row = (r, name) => r.checks.find((c) => c.rule === name) || {};
  let r = ev({ minFollowers: 10000 });
  out.push(['minFollowers passes at 12,000 ≥ 10,000', r.eligible && row(r, 'minFollowers').pass, row(r, 'minFollowers').detail]);
  r = ev({ minFollowers: 10000 }, { ...BASE, followersCount: 9999 });
  out.push(['minFollowers FAILS at 9,999, and the reason names both numbers', !r.eligible && /9,999/.test(row(r, 'minFollowers').detail) && /10,000/.test(row(r, 'minFollowers').detail), row(r, 'minFollowers').detail]);
  r = ev({ minVerifiedFollowers: 50 });
  out.push(['minVerifiedFollowers fails at 40 < 50', !r.eligible && !row(r, 'minVerifiedFollowers').pass, row(r, 'minVerifiedFollowers').detail]);
  r = ev({ verified: true }, { ...BASE, verified: false });
  out.push(['verified fails for an unverified account', !r.eligible && /verified/.test(row(r, 'verified').detail)]);
  r = ev({ verifiedTypes: ['business', 'government'] });
  out.push(['verifiedTypes fails for "blue" when business/government is required', !r.eligible && /blue/.test(row(r, 'verifiedTypes').detail), row(r, 'verifiedTypes').detail]);
  r = ev({ identityVerified: true });
  out.push(['identityVerified fails when X says false', !r.eligible && !row(r, 'identityVerified').pass]);
  r = ev({ minAccountAgeDays: 2000 });
  const r2 = ev({ minAccountAgeDays: 3000 });
  out.push(['minAccountAgeDays: ~2,487 days passes 2,000 and fails 3,000', r.eligible && !r2.eligible, row(r2, 'minAccountAgeDays').detail]);
  r = ev({ minTweetCount: 1000 });
  out.push(['minTweetCount fails at 900 posts', !r.eligible && /900/.test(row(r, 'minTweetCount').detail)]);
  r = ev({ minListedCount: 10 });
  out.push(['minListedCount passes at 12', r.eligible]);
  r = ev({ hasProfileImage: true, hasDescription: true }, { ...BASE, hasProfileImage: false });
  out.push(['hasProfileImage fails on the default avatar; hasDescription passes', !r.eligible && !row(r, 'hasProfileImage').pass && row(r, 'hasDescription').pass]);
  r = ev({}, { ...BASE, parody: true });
  out.push(['a parody account is refused with no rule set (always on)', !r.eligible && /Parody/.test(row(r, 'notParodyOrProtected').detail)]);
  r = ev({}, { ...BASE, protected: true });
  out.push(['a protected account is refused (always on)', !r.eligible && /protected/.test(row(r, 'notParodyOrProtected').detail)]);
  const { verifiedFollowersCount, ...noVfc } = BASE;
  r = ev({ minVerifiedFollowers: 1 }, noVfc);
  out.push(['a MISSING attribute fails closed with a reason, never passes', !r.eligible && /could not read/.test(row(r, 'minVerifiedFollowers').detail), row(r, 'minVerifiedFollowers').detail]);
  r = ev({ minFollowers: 10 }, BASE, null, { stale: 'Reconnect X (one click) to refresh them.' });
  out.push(['a STALE read fails closed and says how to refresh', !r.eligible && /Reconnect X/.test(row(r, 'minFollowers').detail)]);
  const set = { id: 'rs_1', name: 'Gate list', count: 2, snapshotAt: '2026-10-23T00:00:00Z', ids: ['111', '222'] };
  r = ev({ referenceSetId: 'rs_1' }, BASE, set);
  out.push(['inReferenceSet passes for an id on the frozen list', r.eligible && row(r, 'inReferenceSet').pass]);
  r = evaluate({ rules: { referenceSetId: 'rs_1' } }, xAccount(BASE, '999'), set, { now: NOW });
  out.push(['inReferenceSet fails for an id not on it, naming the list', !r.eligible && /Gate list/.test(row(r, 'inReferenceSet').detail)]);
  r = ev({ referenceSetId: 'rs_1' }, BASE, null);
  out.push(['inReferenceSet fails closed when the set is unavailable', !r.eligible]);
  const fb = { enabled: true, min: 2, perClaimCostCapUsd: 0.05, referenceSetId: 'rs_1' };
  out.push(['followedByFromSet passes at 3 ≥ 2', ev({ followedByFromSet: fb }, BASE, null, { followedBy: { count: 3 } }).eligible]);
  out.push(['followedByFromSet fails at 1 < 2', !ev({ followedByFromSet: fb }, BASE, null, { followedBy: { count: 1 } }).eligible]);
  out.push(['followedByFromSet fails closed on a lookup error', !ev({ followedByFromSet: fb }, BASE, null, { followedBy: { error: 'x down', count: 0 } }).eligible]);
  out.push(['followedByFromSet, disabled, is not evaluated at all', !ev({ followedByFromSet: { ...fb, enabled: false } }).checks.some((c) => c.rule === 'followedByFromSet')]);
  r = evaluate({ rules: {} }, { links: [] }, null, { now: NOW });
  out.push(['no X link → not eligible, "Connect your X account"', !r.eligible && /Connect your X/.test(r.checks[0].detail)]);
  return out;
}

const real = eligibilitySuite(elig.evaluate);
for (const [n, c, x] of real) ok(`A. ${n}`, c, x);
{
  // DISCRIMINATION: break ONE comparison in a copy of the module and run the
  // very same assertions. They must fail, or they prove nothing.
  const dir = mkdtempSync(path.join(tmpdir(), 'mc-elig-mutant-'));
  const src = readFileSync(path.join(HERE, 'campaign-eligibility.js'), 'utf8');
  const broken = src.replace('add(rule, have >= min,', 'add(rule, true,');
  ok('A. the mutant really differs from the module (one comparison replaced)', broken !== src);
  writeFileSync(path.join(dir, 'campaign-eligibility.js'), broken);
  const mutant = await import(pathToFileURL(path.join(dir, 'campaign-eligibility.js')).href);
  const caught = eligibilitySuite(mutant.evaluate).filter(([, c]) => !c).map(([n]) => n);
  ok('A. DISCRIMINATES: with "at least N" broken, the same suite fails', caught.length >= 3, `${caught.length} assertion(s) caught it: ${caught.slice(0, 3).join(' | ')}`);
}
{
  const bad = ['Follow me to qualify and send a Holler', 'Retweet this and win', 'Quote tweet with your take', 'reply below for a spot'];
  ok('A. copy that asks for an action on X is refused, every phrasing tried', bad.every((t) => elig.copyViolation(t)), bad.filter((t) => !elig.copyViolation(t)).join(' | '));
  ok('A. ...and plain campaign copy is not', !elig.copyViolation('Send a Holler on my stream and get paid for it'));
  const words = elig.describeRules({ minFollowers: 10000, verified: true, referenceSetId: 'rs_1', followedByFromSet: { enabled: true, min: 2, perClaimCostCapUsd: 0.05, referenceSetId: 'rs_1' } }, { refSets: { rs_1: { name: 'Gate list', count: 2, snapshotAt: '2026-10-23' } } });
  ok('A. the plain-language rules never ask for an action on X', words.every((w) => !elig.copyViolation(w)), words.join(' / '));
}

// ═══ B. fingerprint ═══════════════════════════════════════════════════════
console.log('\n── B. the frozen-list fingerprint ───────────────────────────');
{
  const m = await import('./campaign-merkle.js');
  const a = m.merkleRoot(['300', '100', '200', '100']);
  const b = m.merkleRoot(['100', '200', '300']);
  const c = m.merkleRoot(['100', '200', '301']);
  ok('B. the same ids give the same root, whatever the order or duplicates', a === b, a);
  ok('B. different ids give a different root', b !== c);
  ok('B. a 64-bit id near the top of the range sorts numerically, not as text', m.normaliseIds(['9', '10', '18446744073709551615'])[0] === '9');
  const ids = Array.from({ length: 13 }, (_, i) => String(1000 + i * 7));
  const root = m.merkleRoot(ids);
  ok('B. every member of an odd-sized set has a proof that verifies', ids.every((id) => m.verifyProof(root, id, m.merkleProof(ids, id))));
  ok('B. a non-member has no proof, and a member\'s proof does not verify another id', m.merkleProof(ids, '1') === null && !m.verifyProof(root, '1', m.merkleProof(ids, ids[0])));
}

// ═══ C. the engine against the real settlement door ══════════════════════
console.log('\n── C. engine + the real settlement door (mock chain) ───────');
const accounts = await import('./accounts.js');
const { createSettlement } = await import('./settlement.js');
const { createCampaignEngine } = await import('./campaign-engine.js');
const PLATFORM = '0x00000000000000000000000000000000000000aa';
const USDC = { address: '0x20c000000000000000000000b9537d11c60e8b50', decimals: 6, symbol: 'USDC' };
const GT = '0x00000000000000000000000000000000000000c7';
// Every wallet here has a key (deterministic, from n), so a funding wallet
// can SIGN its Fund message (N10). Lowercase, like the addresses they replace.
const KEYS = new Map();
const W = (n) => {
  const a = privateKeyToAccount(`0x${BigInt(n).toString(16).padStart(64, '0')}`);
  const addr = a.address.toLowerCase();
  KEYS.set(addr, a);
  return addr;
};
// The dedicated campaign spender a creator approves (not the seat spender).
const CSPEND = '0x00000000000000000000000000000000000000cc';

function mockChain({ signers = ['pull', 'platform', 'campaignPull'] } = {}) {
  let seq = 0;
  const c = {
    pulls: [], transfers: [],
    has: (s) => signers.includes(s),
    async transferFrom(a) { c.pulls.push(a); return `0x${(++seq).toString(16).padStart(64, 'a')}`; },
    async transfer(a) { if (!signers.includes(a.signer)) throw new Error(`no ${a.signer} signer`); c.transfers.push(a); return `0x${(++seq).toString(16).padStart(64, 'b')}`; },
    async receipt() { return { status: 'success', blockNumber: '1' }; },
  };
  return c;
}

const xcalls = { lookup: 0, pages: 0, pageMax: [], byId: 0 };
const FOLLOWS = new Set();           // "holderXId>targetXId": holder follows target
const FOLLOWING_9000 = Array.from({ length: 2500 }, (_, i) => String(50000 + i));
const LIST_77 = Array.from({ length: 150 }, (_, i) => String(70000 + i));
const LIST_88 = Array.from({ length: 900 }, (_, i) => String(80000 + i));   // $9.00 to read
const LISTS = { 77: LIST_77, 88: LIST_88 };
const mockX = {
  X_COST_PER_USER_USD: 0.01,
  bearer: false,
  appBearerConfigured() { return this.bearer; },
  async fetchUserById({ userId }) { xcalls.byId++; return { ok: true, records: recs(BASE), costUsd: 0.01, user: { id: String(userId), username: `u${userId}`, followingCount: 2500 } }; },
  async fetchUserByUsername({ username }) { return { ok: true, costUsd: 0.01, user: { id: '9000', username, followingCount: FOLLOWING_9000.length } }; },
  async fetchList({ listId }) { return { ok: true, costUsd: 0.01, list: { id: String(listId), name: 'Gate X list', memberCount: (LISTS[listId] || LIST_77).length } }; },
  async pageUsers({ kind, id, maxResults, paginationToken }) {
    xcalls.pages++; xcalls.pageMax.push(maxResults);
    const all = kind === 'following' ? FOLLOWING_9000 : kind === 'list-members' ? (LISTS[id] || LIST_77) : [...FOLLOWERS_OF(id)];
    const from = Number(paginationToken || 0);
    const users = all.slice(from, from + maxResults).map((u) => ({ id: u, username: `h${u}` }));
    const next = from + maxResults < all.length ? String(from + maxResults) : null;
    return { ok: true, users, nextToken: next, costUsd: users.length * 0.01 };
  },
  async lookupConnection({ accessToken, ids }) {
    xcalls.lookup++;
    const holder = accessToken.replace('tok-', '');
    return { ok: true, byId: { [ids[0]]: { following: FOLLOWS.has(`${holder}>${ids[0]}`), followedBy: FOLLOWS.has(`${ids[0]}>${holder}`) } }, costUsd: 0.01 };
  },
};
const FOLLOWERS_OF = (id) => (id === '3008' ? ['70001', '70002', '1', '2', '3'] : []);
const HOLDERS = new Map();           // xUserId -> accountId
const mockTokens = {
  holdersByXUserId: () => new Map(HOLDERS),
  async getXAccessToken(accountId) { for (const [x, a] of HOLDERS) if (a === accountId) return `tok-${x}`; return null; },
};

let clock = Date.now();
let allowance = 0n;
const rooms = {};
const OFF_AIR = new Set();           // room ids a case has taken off air
// Approve transactions as the chain reports them (readApproval). A fund must
// cite one: from the funding wallet, to the token, for exactly the budget,
// after the campaign was created (finding A).
const APPROVALS = new Map();
function approvalFor(c, wallet, over = {}) {
  const hash = `0x${randomBytes(32).toString('hex')}`;
  APPROVALS.set(hash, { from: wallet, to: c.token.address, status: 'success', timestampMs: Date.parse(c.termsAt || c.createdAt) + 1000, approvals: [{ token: c.token.address, owner: wallet, spender: CSPEND, value: c.budget.atomic }], ...over });
  return hash;
}
// The funding wallet's EIP-712 Fund signature, as approve-step.tsx sends it.
// Each call gets its own deadline, so no two calls sign the same message.
const { fundTypedData } = await import('./campaign-engine.js');
let sigSeq = 0;
async function fundProof(c, wallet, { signer = null, deadline = null, over = {} } = {}) {
  const acct = signer || KEYS.get(String(wallet).toLowerCase());
  const dl = deadline ?? Math.floor(clock / 1000) + 300 - (sigSeq++ % 250);
  const td = fundTypedData({ chainId: 4217, campaignId: c.id, wallet, token: c.token.address, amountAtomic: c.budget.atomic, deadline: dl, ...over });
  const signature = await acct.signTypedData(td);
  return { signature, typedData: { ...td, message: { ...td.message, amountAtomic: String(td.message.amountAtomic), deadline: String(td.message.deadline) } } };
}
const fundAs = async (e, c, wallet, who = null) => {
  const cur = e.store.getCampaign(c.id) || c;
  const proof = await fundProof(cur, wallet);
  return e.fund(c.id, { wallet, approveTx: approvalFor(cur, wallet), ...proof }, who || as(creator));
};
// Transfer logs as the chain would report them (server.js findFundingTransfer
// reads the token's Transfer events). Only what a case puts here exists.
const TRANSFERS = [];
const sameA = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
async function findTransferMock({ token, from, to, atomic, sinceMs }) {
  const hit = TRANSFERS.find((t) => sameA(t.token, token) && sameA(t.from, from) && sameA(t.to, to) && String(t.atomic) === String(atomic) && t.atMs >= sinceMs - 60_000);
  return hit ? { found: true, txHash: hit.txHash } : { found: false };
}
function makeEngine(dir, door, over = {}) {
  return createCampaignEngine({
    dataDir: dir, settlement: door, platformAddress: PLATFORM, spender: CSPEND, usdc: USDC,
    readAllowance: async () => allowance,
    findFundingTransfer: findTransferMock,
    readTokenMeta: async (a) => { if (a.toLowerCase() === GT) return { decimals: 18, symbol: 'GT' }; throw new Error('execution reverted'); },
    confirmTx: async (h) => receiptFor(door, h),
    readApproval: async (h) => APPROVALS.get(h) || null,
    resolveRoom: (h) => rooms[h] || null,
    seatSignalAvailable: () => true,
    // Every room here is ON AIR unless a case takes it off (OFF_AIR).
    roomOnAir: (roomId) => !OFF_AIR.has(roomId),
    xApi: mockX, xTokens: mockTokens, now: () => clock, log: quiet,
    ...over,
  });
}

const creator = accounts.upsertAccountForLink({ provider: 'twitch', platformId: 't1', username: 'gatecreator' });
const mkX = (name, xid, attrs = BASE) => accounts.upsertAccountForLink({ provider: 'x', platformId: xid, username: name, attributes: recs(attrs) });
const alice = mkX('alice', '3001');
const bob = mkX('bob', '3002', { ...BASE, followersCount: 300 });
const carol = mkX('carol', '3003');
const dave = mkX('dave', '3004');
const erin = mkX('erin', '3005');
const frank = mkX('frank', '3006');
const grace = mkX('grace', '3008');
rooms.gatestage = { id: 'room-holler', ownerKey: creator.id };
rooms.gatecall = { id: 'room-call', ownerKey: creator.id, transport: 'livekit' };
rooms.vdoroom = { id: 'room-vdo', ownerKey: creator.id, transport: 'vdo' };
rooms.otherroom = { id: 'room-other', ownerKey: 'acct_someoneelse' };

const chain = mockChain();
const door = createSettlement({ dataDir: SC, chain, platformAddress: PLATFORM, log: quiet });
const eng = makeEngine(SC, door);
const as = (acct) => ({ accountId: acct.id, isAdmin: false });
const code = (r) => r.error?.code || (r.value ? 'ok' : 'none');
const pulls = () => door.all().filter((r) => r.kind === 'pull');
const payIntents = (cid) => door.intentsFor('campaign:pay:').filter((r) => (r.rows?.[0]?.meta || {}).campaignId === cid);

const holler = (over = {}) => ({
  title: 'Gate Holler offer', blurb: 'Send a Holler on my stream and get paid for it.',
  action: { kind: 'holler', roomHandle: 'gatestage', require: 'aired' },
  reward: { type: 'usdc', amount: '5' }, budget: { amount: '12' }, maxClaims: 5,
  deadline: new Date(clock + 7 * 86_400_000).toISOString(), rules: { minFollowers: 10000 }, ...over,
});

// ── C1 funding ──
let r = await attempt(() => eng.createCampaign(holler({ blurb: 'Follow me and send a Holler' }), as(creator)));
ok('C1. a campaign whose copy asks for a follow is refused (X policy)', code(r) === 'x_policy');
r = await attempt(() => eng.createCampaign(holler({ action: { kind: 'holler', roomHandle: 'otherroom', require: 'aired' } }), as(creator)));
ok('C1. a campaign cannot send people to somebody else\'s room', code(r) === 'not_your_room');
const A = await eng.createCampaign(holler(), as(creator));
ok('C1. a draft is created by any signed-in account, the slug minted from the title', A.status === 'draft' && A.slug === 'gate-holler-offer', A.slug);
const A2 = await eng.createCampaign(holler(), as(creator));
ok('C1. a second campaign with the same title gets a de-duplicated slug', A2.slug === 'gate-holler-offer-2', A2.slug);
r = await attempt(() => fundAs(eng, A, W(1)));
ok('C1. funding is refused while CAMPAIGN_FUNDING is not 1, and the refusal does not name the env var', code(r) === 'funding_off' && !/CAMPAIGN_FUNDING|SELLER_PRIVATE_KEY/.test(r.error.message), r.error?.message);
{
  // finding D: the ROUTE refuses before asking for an approve (nobody pays gas
  // for an approval that would be refused), with the same plain message.
  const { CAMPAIGN_ROUTES: table } = await import('./campaign-routes.js');
  const fundRoute = table.find(([m, p]) => m === 'POST' && p === '/api/campaigns/:id/fund');
  let asked = null;
  const stub = { getManaged: () => A, fundTerms: () => ({ pullSigner: true, spender: PLATFORM }), fund: async () => { asked = 'fund'; } };
  const rr = await attempt(() => fundRoute[3](stub, { params: { id: A.id }, body: {} }, as(creator)));
  ok('C10.D the fund ROUTE answers "not open" before any needsApproval when funding is off (no approve, no gas)', code(rr) === 'funding_off' && rr.error.status === 503 && !rr.value?.needsApproval && asked === null && /aren.t open/.test(rr.error.message) && !/CAMPAIGN_FUNDING/.test(rr.error.message), rr.error?.message);
}
process.env.CAMPAIGN_FUNDING = '1';
{
  const dir2 = mkdtempSync(path.join(tmpdir(), 'mc-campaigns-nopull-'));
  const door2 = createSettlement({ dataDir: dir2, chain: mockChain({ signers: ['platform'] }), platformAddress: PLATFORM, log: quiet });
  const eng2 = makeEngine(dir2, door2);
  const c2 = await eng2.createCampaign(holler(), as(creator));
  allowance = 10n ** 12n;
  const r2 = await attempt(() => fundAs(eng2, c2, W(1)));
  ok('C1. with no pull signer the campaign cannot be funded, and pull is never called (no dry row)', code(r2) === 'no_pull_signer' && door2.all().length === 0, `${door2.all().length} door rows`);
  allowance = 0n;
}
r = await attempt(() => fundAs(eng, A, W(1)));
ok('C1. an allowance below the budget is refused, nothing pulled', code(r) === 'insufficient_allowance' && pulls().length === 0);
r = await attempt(() => eng.fund(A.id, { wallet: W(1) }, { accountId: alice.id }));
ok('C1. someone else cannot fund (or touch) your campaign', code(r) === 'forbidden');
allowance = 12_000_000n;
{
  // finding A: SOMEONE ELSE'S WALLET. The victim has allowance to the platform
  // (left over from a seat), so only the approve proof stands in the way.
  const victim = W(0xbad);
  const tries = {
    'no approve tx': await attempt(() => eng.fund(A.id, { wallet: victim }, as(creator))),
    'the victim’s OLD approve (before this campaign existed)': await attempt(() => eng.fund(A.id, { wallet: victim, approveTx: approvalFor(A, victim, { timestampMs: Date.parse(A.createdAt) - 3_600_000 }) }, as(creator))),
    'an approve sent by a DIFFERENT wallet': await attempt(() => eng.fund(A.id, { wallet: victim, approveTx: approvalFor(A, W(0xa77ac)) }, as(creator))),
    'the victim’s approve for another amount': await attempt(() => eng.fund(A.id, { wallet: victim, approveTx: approvalFor(A, victim, { approvals: [{ token: USDC.address, owner: victim, spender: CSPEND, value: '999000000' }] }) }, as(creator))),
    'an approve to another spender': await attempt(() => eng.fund(A.id, { wallet: victim, approveTx: approvalFor(A, victim, { approvals: [{ token: USDC.address, owner: victim, spender: W(0x5bad), value: A.budget.atomic }] }) }, as(creator))),
    'a reverted approve': await attempt(() => eng.fund(A.id, { wallet: victim, approveTx: approvalFor(A, victim, { status: 'reverted' }) }, as(creator))),
    'an approve tx the chain has never seen': await attempt(() => eng.fund(A.id, { wallet: victim, approveTx: `0x${'ab'.repeat(32)}` }, as(creator))),
  };
  const let_through = Object.entries(tries).filter(([, x]) => !['approve_required', 'approve_invalid'].includes(code(x))).map(([k, x]) => `${k} → ${code(x)}`);
  ok('C10.A SOMEONE ELSE’S WALLET: every fund citing a wallet the caller has not proven (7 ways) is refused and pulls nothing', let_through.length === 0 && pulls().length === 0 && chain.pulls.length === 0 && eng.store.getCampaign(A.id).status === 'draft', let_through.join(' | ') || '7/7 refused, 0 pulls');
}
const approveA = approvalFor(A, W(1));
await eng.fund(A.id, { wallet: W(1), approveTx: approveA, ...(await fundProof(A, W(1))) }, as(creator));
{
  allowance = 12_000_000n;
  const pr2 = await fundProof(A2, W(1));
  const ru = await attempt(() => eng.fund(A2.id, { wallet: W(1), approveTx: approveA, ...pr2 }, as(creator)));
  ok('C10.A one approve funds one campaign: reusing A’s approval for another campaign is refused', code(ru) === 'approve_reused' && chain.pulls.length === 1, code(ru));
}
r = await attempt(() => fundAs(eng, A, W(1)));
ok('C1. FUND PULL ONCE: funded, and funding again is refused', eng.store.getCampaign(A.id).status === 'funded' && code(r) === 'already_funded' && pulls().length === 1 && chain.pulls.length === 1,
  `pulls=${chain.pulls.length} amount=${chain.pulls[0]?.amountAtomic}`);
ok('C1. ...for exactly the budget, from the creator\'s wallet, to the platform wallet, by the CAMPAIGN spender slot', chain.pulls[0].amountAtomic === 12_000_000n && chain.pulls[0].from === W(1) && chain.pulls[0].to === PLATFORM && chain.pulls[0].signer === 'campaignPull');
ok('C1. a funded campaign is not public until it opens', eng.publicView(A.slug) === null && code(await attempt(() => eng.check(A.slug, as(alice)))) === 'not_found');
eng.open(A.id, as(creator));
ok('C1. open → live, and the public view shows the offer and the budget left', eng.publicView(A.slug)?.status === 'live' && eng.publicView(A.slug).budget.left === '12');

// ── C2 eligibility and claims ──
let ca = await eng.check(A.slug, as(alice));
ok('C2. alice (12,000 followers) is eligible', ca.result.eligible && ca.claim.status === 'eligible');
const cb = await eng.check(A.slug, as(bob));
ok('C2. bob (300 followers) is not, with the reason', !cb.result.eligible && cb.claim.status === 'ineligible' && /300/.test(cb.result.checks.find((c) => c.rule === 'minFollowers').detail));
r = await attempt(() => eng.reserve({ slug: A.slug, accountId: bob.id, kind: 'holler', roomId: 'room-holler' }));
ok('C2. INELIGIBLE CANNOT RECORD: bob\'s Holler is refused before anything is reserved', code(r) === 'ineligible' && eng.store.getClaim(cb.claim.id).status === 'ineligible');
const ca2 = await eng.check(A.slug, as(alice));
ok('C2. ONE CLAIM PER ACCOUNT: checking again returns the same claim', ca2.claim.id === ca.claim.id && eng.store.listClaims(A.id).filter((k) => k.accountId === alice.id).length === 1);
{
  const sw = accounts.upsertAccountForLink({ provider: 'twitch', platformId: 't-switch', username: 'switcher' });
  accounts.attachLink(sw.id, { provider: 'x', platformId: '3009', username: 'moving', attributes: recs(BASE) });
  await eng.check(A.slug, as(sw));
  accounts.detachLink(sw.id, 'x');
  const thief = mkX('moving2', '3009');
  const rt = await attempt(() => eng.check(A.slug, as(thief)));
  ok('C2. ONE CLAIM PER X ID: the same X account on a second Holler account is refused', code(rt) === 'x_already_claimed');
}
r = await attempt(() => eng.reserve({ slug: A.slug, accountId: alice.id, kind: 'holler', roomId: 'room-call' }));
ok('C2. a Holler in the wrong room does not count', code(r) === 'wrong_room');
r = await attempt(() => eng.reserve({ slug: A.slug, accountId: alice.id, kind: 'callin', roomId: 'room-holler' }));
ok('C2. a Call in does not count toward a Holler campaign', code(r) === 'wrong_action');
const resA = eng.reserve({ slug: A.slug, accountId: alice.id, kind: 'holler', roomId: 'room-holler' });
eng.bind(resA.claimId, { letterId: 'L-alice' });
eng.onLetterEvent('L-alice', 'approved');
ok('C2. approved, but this campaign requires aired: no payout intent yet', eng.store.getClaim(resA.claimId).status === 'approved' && payIntents(A.id).length === 0);
eng.onLetterEvent('L-alice', 'aired');
let ka = eng.store.getClaim(resA.claimId);
ok('C2. aired → owed; with no payout wallet there is still no intent, and the page is told to ask', ka.status === 'owed' && payIntents(A.id).length === 0 && eng.claimView(ka).needsWallet);
accounts.setAccountPayoutWallet(alice.id, W(0xa11ce));
eng.sync(); eng.sync(); eng.tryPay(resA.claimId); eng.onLetterEvent('L-alice', 'aired');
ok('C2. NEVER TWICE: the wallet arrives → ONE intent, after sync ×2, tryPay and a repeated aired event',
  payIntents(A.id).length === 1 && door.status(`campaign:pay:${resA.claimId}`).status === 'PENDING', `${payIntents(A.id).length} intent(s)`);
await door.flush(); await door.flush();
eng.sync();
ok('C2. the door pays it once, for exactly the reward, to the wallet; the claim reads paid',
  chain.transfers.length === 1 && chain.transfers[0].amountAtomic === 5_000_000n && chain.transfers[0].to === W(0xa11ce) && chain.transfers[0].signer === 'platform' && eng.store.getClaim(resA.claimId).status === 'paid');
eng.advance(eng.store.getClaim(cb.claim.id), 'aired');
ok('C2. NEVER FOR AN INELIGIBLE CLAIM: forcing "aired" onto bob\'s claim moves nothing', eng.store.getClaim(cb.claim.id).status === 'ineligible' && payIntents(A.id).length === 1);

// ── C3 budget and maxClaims ──
await eng.check(A.slug, as(carol)); await eng.check(A.slug, as(dave));
const resC = eng.reserve({ slug: A.slug, accountId: carol.id, kind: 'holler', roomId: 'room-holler' });
eng.bind(resC.claimId, { letterId: 'L-carol' });
r = await attempt(() => eng.reserve({ slug: A.slug, accountId: dave.id, kind: 'holler', roomId: 'room-holler' }));
ok('C3. BUDGET: a third 5 USDC slot on a 12 USDC budget is refused', code(r) === 'budget_spent', `remaining=${eng.totals(A.id).remaining}`);
eng.onLetterEvent('L-carol', 'dropped', 'upload_expired');
ok('C3. a dropped Holler gives its slot back (carol is eligible again)', eng.store.getClaim(resC.claimId).status === 'eligible');
const resD = eng.reserve({ slug: A.slug, accountId: dave.id, kind: 'holler', roomId: 'room-holler' });
eng.bind(resD.claimId, { letterId: 'L-dave' });
ok('C3. ...and dave can take it', eng.store.getClaim(resD.claimId).status === 'recorded');
{
  allowance = 100_000_000n;
  const B = await eng.createCampaign(holler({ title: 'One place only', maxClaims: 1, budget: { amount: '50' } }), as(creator));
  await fundAs(eng, B, W(2)); eng.open(B.id, as(creator));
  await eng.check(B.slug, as(carol)); await eng.check(B.slug, as(erin));
  eng.reserve({ slug: B.slug, accountId: carol.id, kind: 'holler', roomId: 'room-holler' });
  const rf = await attempt(() => eng.reserve({ slug: B.slug, accountId: erin.id, kind: 'holler', roomId: 'room-holler' }));
  ok('C3. MAXCLAIMS: the second place on a one-place campaign is refused though budget remains', code(rf) === 'full');
}

// ── C4 close and refund ──
eng.close(A.id, as(creator));
let kd = eng.store.getClaim(resD.claimId);
ok('C10.B CLOSE HONOURS A SUBMITTED HOLLER: dave’s (recorded, bound to its letter) is kept with a grace window, not expired', kd.status === 'recorded' && !!kd.honourUntil && kd.reservedAtomic === '5000000', `${kd.status} until ${kd.honourUntil}`);
ok('C10.B ...and the claim view the page reads carries honourUntil and whether payouts are sent (payoutsEnabled)', eng.claimView(kd).honourUntil === kd.honourUntil && eng.claimView(kd).payoutsEnabled === true);
eng.sync();
ok('C10.B ...and the refund WAITS for it, like it waits for an owed claim', !door.status(`campaign:refund:${A.id}`));
r = await attempt(() => eng.reserve({ slug: A.slug, accountId: carol.id, kind: 'holler', roomId: 'room-holler' }));
ok('C4. nothing new can be submitted after close', code(r) === 'closed');
eng.onLetterEvent('L-dave', 'aired');
accounts.setAccountPayoutWallet(dave.id, W(0xda7e));
eng.sync();
ok('C10.B ...dave’s Holler airs inside the window → owed → ONE payout intent', eng.store.getClaim(resD.claimId).status === 'releasing' && payIntents(A.id).length === 2);
eng.sync(); eng.sync(); eng.maybeRefund(A.id);
const refundA = door.status(`campaign:refund:${A.id}`);
const refundRows = door.all().filter((x) => x.ref.startsWith(`campaign:refund:${A.id}`));
ok('C4. REFUND EXACTLY ONCE, after close and after the honoured claim: funded − Σ releases = 12 − 5 − 5 = 2 USDC to the funding wallet',
  refundRows.length === 1 && refundA.amountAtomic === '2000000' && refundA.to === W(1) && refundA.kind === 'refund', `${refundA?.amountAtomic} → ${refundA?.to}`);
await door.flush(); await door.flush(); eng.sync();
{
  // Read from the DOOR, not restated constants: every row recorded for A.
  const fundedA = BigInt(eng.store.getCampaign(A.id).funding.atomic);
  const recsA = door.all().filter((x) => (x.rows?.[0]?.meta || {}).campaignId === A.id && x.kind !== 'pull');
  const sumOf = (pfx) => recsA.filter((x) => x.ref.startsWith(pfx)).reduce((t, x) => t + BigInt(x.rows[0].amountAtomic || 0), 0n);
  const pay = sumOf('campaign:pay:'), xc = sumOf('campaign:xcost:'), refund = sumOf('campaign:refund:');
  const moving = recsA.filter((x) => !x.ref.startsWith('campaign:xcost:'));
  const sentOnChain = chain.transfers.filter((t) => [W(0xa11ce), W(0xda7e), W(1)].includes(t.to)).reduce((t, x) => t + x.amountAtomic, 0n);
  ok('C4. THE LEDGER BALANCES, read from the door: Σ pay + Σ x-cost + refund = funded, every moving intent DONE, and the chain moved exactly pay + refund',
    pay + xc + refund === fundedA && moving.every((x) => x.status === 'DONE') && sentOnChain === pay + refund && eng.store.getClaim(resD.claimId).status === 'paid',
    `pay ${pay} + x ${xc} + refund ${refund} vs funded ${fundedA}; on chain ${sentOnChain}; ${moving.map((x) => x.status).join(',')}`);
}
{
  // The grace window has an end, and an unbound reservation is not honoured.
  allowance = 100_000_000n;
  const A3 = await eng.createCampaign(holler({ title: 'Grace window' }), as(creator));
  await fundAs(eng, A3, W(7)); eng.open(A3.id, as(creator));
  await eng.check(A3.slug, as(carol)); await eng.check(A3.slug, as(erin));
  const unbound = eng.reserve({ slug: A3.slug, accountId: carol.id, kind: 'holler', roomId: 'room-holler' });
  const bound = eng.reserve({ slug: A3.slug, accountId: erin.id, kind: 'holler', roomId: 'room-holler' });
  eng.bind(bound.claimId, { letterId: 'L-erin3' });
  eng.close(A3.id, as(creator));
  ok('C10.B a slot reserved but never bound to a Holler is NOT honoured: it expires at close', eng.store.getClaim(unbound.claimId).status === 'expired' && eng.store.getClaim(bound.claimId).status === 'recorded');
  clock += 49 * 3_600_000;
  eng.onLetterEvent('L-erin3', 'aired');
  ok('C10.B PAST THE GRACE WINDOW: a Holler airing 49h after close owes nothing', eng.store.getClaim(bound.claimId).status === 'recorded' && payIntents(A3.id).length === 0);
  eng.sync();
  ok('C10.B ...the sweep expires it, and the refund follows for the full budget', eng.store.getClaim(bound.claimId).status === 'expired' && door.status(`campaign:refund:${A3.id}`)?.amountAtomic === '12000000');
  clock -= 49 * 3_600_000;
}

// ── C5 Call in, and an owed claim with no wallet holds the refund ──
{
  allowance = 100_000_000n;
  const defH = await eng.createCampaign(holler({ title: 'Default holler require', action: { kind: 'holler', roomHandle: 'gatestage' } }), as(creator));
  const defC = await eng.createCampaign(holler({ title: 'Default callin require', action: { kind: 'callin', roomHandle: 'gatecall' } }), as(creator));
  ok('C10.4 AIRED IS THE DEFAULT for both actions (approved fires on upload in an auto room; joined on a bare publish)', defH.action.require === 'aired' && defC.action.require === 'aired', `${defH.action.require}/${defC.action.require}`);
  const vdo = await attempt(() => eng.createCampaign(holler({ title: 'Vdo call', action: { kind: 'callin', roomHandle: 'vdoroom' } }), as(creator)));
  ok('C10.4 a Call in campaign in a room NOT on LiveKit is refused (no server-side camera signal there)', code(vdo) === 'needs_livekit', code(vdo));

  const Cc = await eng.createCampaign(holler({ title: 'Call in now', action: { kind: 'callin', roomHandle: 'gatecall', require: 'joined' } }), as(creator));
  await fundAs(eng, Cc, W(3)); eng.open(Cc.id, as(creator));
  await eng.check(Cc.slug, as(erin));
  {
    const engNo = makeEngine(SC, door, { seatSignalAvailable: () => false });
    const ns = await attempt(() => engNo.reserve({ slug: Cc.slug, accountId: erin.id, kind: 'callin', roomId: 'room-call' }));
    ok('C10.4 with no LiveKit webhook signal on the server, a Call in cannot even reserve a slot', code(ns) === 'callin_unverifiable', code(ns));
  }
  const re = eng.reserve({ slug: Cc.slug, accountId: erin.id, kind: 'callin', roomId: 'room-call' });
  eng.bind(re.claimId, { seatId: 'S-erin' });
  eng.onSeatEvent('S-erin', 'joined');
  ok('C10.4 CLIENT SIGNAL IGNORED: the old camera_ready-driven "joined" event moves nothing', eng.store.getClaim(re.claimId).status === 'recorded', eng.store.getClaim(re.claimId).status);
  eng.onSeatEvent('S-erin', 'camera_on');
  ok('C5. Call in, require joined: the camera track published (signed LiveKit webhook) → owed', eng.store.getClaim(re.claimId).status === 'owed');
  eng.close(Cc.id, as(creator)); eng.sync();
  ok('C5. an owed claim with no wallet HOLDS the refund (every owed claim intended first)', !door.status(`campaign:refund:${Cc.id}`));
  clock += 15 * 86_400_000; eng.sync(); clock -= 15 * 86_400_000;
  ok('C5. past the wallet grace the claim is forfeited and the refund follows, once, for the full budget',
    eng.store.getClaim(re.claimId).status === 'expired' && door.status(`campaign:refund:${Cc.id}`)?.amountAtomic === '12000000');

  const Dd = await eng.createCampaign(holler({ title: 'Stay on camera', action: { kind: 'callin', roomHandle: 'gatecall', require: 'aired', minSeconds: 10 } }), as(creator));
  await fundAs(eng, Dd, W(4)); eng.open(Dd.id, as(creator));
  await eng.check(Dd.slug, as(frank));
  const rf1 = eng.reserve({ slug: Dd.slug, accountId: frank.id, kind: 'callin', roomId: 'room-call' });
  eng.bind(rf1.claimId, { seatId: 'S-f1' }); eng.onSeatEvent('S-f1', 'camera_on');
  ok('C5. Call in, require aired: a published camera is joined, not yet enough', eng.store.getClaim(rf1.claimId).status === 'joined');
  clock += 3000; eng.onSeatEvent('S-f1', 'ended');
  ok('C5. leaving after 3s (server-timed) of a 10s minimum gives the slot back', eng.store.getClaim(rf1.claimId).status === 'eligible');
  const rf2 = eng.reserve({ slug: Dd.slug, accountId: frank.id, kind: 'callin', roomId: 'room-call' });
  eng.bind(rf2.claimId, { seatId: 'S-f2' }); eng.onSeatEvent('S-f2', 'camera_on');
  clock += 6000; eng.onSeatEvent('S-f2', 'camera_off'); eng.onSeatEvent('S-f2', 'camera_on');
  clock += 6000; eng.onSeatEvent('S-f2', 'ended');
  ok('C5. the on-camera clock RESTARTS when the track is unpublished: 6s + 6s is not 10s continuous', eng.store.getClaim(rf2.claimId).status === 'eligible', eng.store.getClaim(rf2.claimId).status);
  const rf3 = eng.reserve({ slug: Dd.slug, accountId: frank.id, kind: 'callin', roomId: 'room-call' });
  eng.bind(rf3.claimId, { seatId: 'S-f3' }); eng.onSeatEvent('S-f3', 'camera_on');
  clock += 12_000; eng.onSeatEvent('S-f3', 'ended');
  ok('C5. 12s continuously on camera (from the webhook) → aired → owed', eng.store.getClaim(rf3.claimId).status === 'owed');
}

// ── C6 followedByFromSet ──
{
  allowance = 100_000_000n;
  const hs = ['4001', '4002', '4003', '4004', '4005'];
  hs.forEach((x, i) => HOLDERS.set(x, `acct_holder${i}`));
  FOLLOWS.add('4004>3008'); FOLLOWS.add('4005>3008');   // holders 4 and 5 follow grace
  FOLLOWS.add('3008>4001');                             // grace follows holder 1 — the WRONG direction
  const set = await eng.buildSet({ name: 'Vouchers', source: 'manual', sourceRef: [...hs, '99'].join('\n') }, as(creator));
  const fbRules = (cap, enabled = true) => ({ followedByFromSet: { enabled, min: 2, perClaimCostCapUsd: cap, referenceSetId: set.id } });
  const mk = async (title, rules, reward = { type: 'usdc', amount: '1' }) => {
    const c = await eng.createCampaign(holler({ title, rules, reward, budget: { amount: '10' } }), as(creator));
    await fundAs(eng, c, W(5)); eng.open(c.id, as(creator));
    return eng.store.getCampaign(c.id);
  };
  const E = await mk('Vouched capped', fbRules(0.03));
  const before = xcalls.lookup;
  const ge = await eng.check(E.slug, as(grace));
  const row = ge.result.checks.find((c) => c.rule === 'followedByFromSet');
  ok('C6. COST CAP: $0.03 at $0.01 a lookup asks exactly 3 holders, then stops', xcalls.lookup - before === 3, `${xcalls.lookup - before} lookups`);
  ok('C6. DIRECTION: grace follows holder 1 (followed_by) — that does NOT count; 0 of the 3 follow her', !ge.result.eligible && /0 accounts/.test(row.detail) && /cost cap/.test(row.detail), row.detail);
  ok('C6. the X cost is RETAINED at the door and comes out of the budget', eng.store.getCampaign(E.id).xCostAtomic === '30000'
    && door.intentsFor('campaign:xcost:check:').some((x) => x.status === 'RETAINED' && (x.rows[0].meta || {}).campaignId === E.id));
  const F = await mk('Vouched roomy', fbRules(0.05));
  const gf = await eng.check(F.slug, as(grace));
  ok('C6. with a $0.05 cap holders 4 and 5 are reached: 2 follow her → eligible', gf.result.eligible);
  const G = await mk('Not vouched', fbRules(0.05, false));
  const b2 = xcalls.lookup;
  const gg = await eng.check(G.slug, as(grace));
  ok('C6. explicitly enabled:false: the rule is dropped (not stored, not shown), no X call, no check', xcalls.lookup === b2 && !gg.result.checks.some((c) => c.rule === 'followedByFromSet') && !eng.store.getCampaign(G.id).rules.followedByFromSet);
  {
    // finding C: the form sends the rule WITHOUT `enabled`. Present = enforced.
    const { enabled: _e, ...noFlag } = fbRules(0.05).followedByFromSet;
    const N = await mk('Vouched, no enabled field', { followedByFromSet: noFlag });
    const b4 = xcalls.lookup;
    const gn = await eng.check(N.slug, as(grace));
    ok('C10.C A followedByFromSet rule sent with NO `enabled` field is ENFORCED (stored on, X asked, the check row present)',
      eng.store.getCampaign(N.id).rules.followedByFromSet?.enabled === true && xcalls.lookup > b4 && gn.result.checks.some((c) => c.rule === 'followedByFromSet'), `lookups ${xcalls.lookup - b4}`);
  }
  const nobody = await eng.buildSet({ name: 'No holders', source: 'manual', sourceRef: '70001\n70002\n70003' }, as(creator));
  const H = await mk('Fallback list', { followedByFromSet: { enabled: true, min: 2, perClaimCostCapUsd: 0.04, referenceSetId: nobody.id } });
  const b3 = xcalls.pages;
  const gh = await eng.check(H.slug, as(grace));
  ok('C6. no holder and no X_BEARER_TOKEN → fails closed, no X call', !gh.result.eligible && xcalls.pages === b3 && /not available/.test(gh.result.checks.find((c) => c.rule === 'followedByFromSet').detail));
  mockX.bearer = true;
  const H2 = await mk('Fallback list two', { followedByFromSet: { enabled: true, min: 2, perClaimCostCapUsd: 0.04, referenceSetId: nobody.id } });
  const gh2 = await eng.check(H2.slug, as(grace));
  ok('C6. with the app token, the capped fallback reads at most cap/$0.01 of her followers and counts the list',
    xcalls.pageMax[xcalls.pageMax.length - 1] <= 4 && gh2.claim.checks.find((c) => c.rule === 'followedByFromSet')?.pass === true, `max_results=${xcalls.pageMax[xcalls.pageMax.length - 1]}`);
  mockX.bearer = false;
  allowance = 10n ** 30n;
  process.env.CAMPAIGN_FEE_TOKENS = GT;   // GT stands in for a token tested on chain (finding 7)
  const T = await eng.createCampaign(holler({ title: 'Token vouched', reward: { type: 'token', address: GT, amount: '2' }, budget: { amount: '20' }, rules: fbRules(0.05) }), as(creator));
  await fundAs(eng, T, W(6)); eng.open(T.id, as(creator));
  const gt = await eng.check(T.slug, as(grace));
  ok('C6. followedByFromSet on a custom-token campaign fails closed (X bills dollars)', !gt.result.eligible && /USDC/.test(gt.result.checks.find((c) => c.rule === 'followedByFromSet').detail));
}

// ── C7 reference sets ──
{
  mockX.bearer = true;
  const admin = { accountId: null, isAdmin: true };
  const est = await eng.estimateSet({ source: 'x-following', sourceRef: '@somebody' });
  ok('C7. the estimate states count and cost before anything runs', est.count === 2500 && est.costUsd === 25 && est.requests === 3);
  const setsBefore = eng.store.listSets().length;
  const nc = await attempt(() => eng.buildSet({ name: 'F', source: 'x-following', sourceRef: '@somebody' }, admin));
  ok('C7. building without confirm is refused with the estimate, and nothing is stored', code(nc) === 'confirm_required' && nc.error.estimate?.costUsd === 25 && eng.store.listSets().length === setsBefore);
  const pagesBefore = xcalls.pages;
  const s1 = await eng.buildSet({ name: 'Accounts somebody follows', source: 'x-following', sourceRef: '@somebody', confirm: true, confirmCostUsd: 25 }, admin);
  const { merkleRoot } = await import('./campaign-merkle.js');
  ok('C7. confirmed: paginated (3 pages of ≤1,000), every id frozen, root over the ids', s1.count === 2500 && xcalls.pages - pagesBefore === 3 && s1.root === merkleRoot(FOLLOWING_9000));
  const stored = eng.store.getSet(s1.id);
  ok('C7. only ids and handles are kept from X', Object.keys(stored.handles).length === 2500 && Object.values(stored.handles).every((h) => typeof h === 'string') && !('users' in stored));
  const frozen = JSON.stringify(stored);
  FOLLOWING_9000.push('59999');
  const s2 = await eng.refreshSet(s1.id, { confirm: true, confirmCostUsd: 26 }, admin);
  ok('C7. FROZEN: a refresh is a NEW set (version 2, supersedes the old); the old one is byte-identical',
    s2.id !== s1.id && s2.version === 2 && s2.supersedes === s1.id && s2.count === 2501 && JSON.stringify(eng.store.getSet(s1.id)) === frozen && s2.root !== s1.root);
  let threw = null; try { eng.store.insertSet({ ...stored }); } catch (e) { threw = e; }
  ok('C7. the store refuses to write over an existing set', !!threw);
  const dr = await eng.createCampaign(holler({ title: 'Draft list' }), as(creator));
  const cr = await attempt(() => eng.buildSet({ name: 'X', source: 'x-list', sourceRef: '77', campaignId: dr.id, confirm: true, confirmCostUsd: 2 }, as(creator)));
  ok('C7. a creator\'s X build needs a FUNDED campaign to charge (draft refused, nothing spent)', code(cr) === 'needs_funded');
  mockX.bearer = false;
}

// ── C8 tokens ──
{
  delete process.env.CAMPAIGN_FEE_TOKENS;
  const unlisted = await attempt(() => eng.createCampaign(holler({ title: 'Unlisted token', reward: { type: 'token', address: GT, amount: '2' }, budget: { amount: '20' } }), as(creator)));
  const info = await eng.tokenInfo(GT);
  ok('C10.7 a custom ERC-20 NOT on CAMPAIGN_FEE_TOKENS is refused (fees are paid in the token moved; needs an on-chain test first), and the token lookup says so',
    code(unlisted) === 'token_not_allowed' && /on-chain test/.test(unlisted.error.message) && info.campaignAllowed === false, code(unlisted));
  ok('C10.7 ...USDC campaigns are untouched by the allowlist', (await eng.createCampaign(holler({ title: 'Plain USDC' }), as(creator))).token.address === USDC.address);
  process.env.CAMPAIGN_FEE_TOKENS = GT;
  const T = await eng.createCampaign(holler({ title: 'Paid in GT', reward: { type: 'token', address: GT, amount: '2' }, budget: { amount: '20' } }), as(creator));
  ok('C8. a custom ERC-20 reward reads its decimals and symbol from chain', T.token.decimals === 18 && T.token.symbol === 'GT' && T.reward.atomic === (2n * 10n ** 18n).toString());
  process.env.CAMPAIGN_FEE_TOKENS = `${GT},${W(0xdead)}`;   // listed, so the chain read is what refuses it
  const bad = await attempt(() => eng.createCampaign(holler({ title: 'Bad token', reward: { type: 'token', address: W(0xdead), amount: '1' } }), as(creator)));
  process.env.CAMPAIGN_FEE_TOKENS = GT;
  ok('C8. an address that is not an ERC-20 on Tempo is refused (even when listed)', code(bad) === 'invalid_token', code(bad));
  const none = await attempt(() => eng.createCampaign(holler({ title: 'No token', reward: { type: 'token', amount: '1' } }), as(creator)));
  ok('C8. a token reward with no address (off-chain credit) is refused', code(none) === 'invalid');
}

// ── C9 the invariants across every campaign the section made ──
/** Every funded campaign: one CONFIRMED pull under its funding ref (other pulls only for recorded failed attempts), Σ releases ≤ funded, ≤1 refund in the pulled token, refund + Σ releases = funded once refunded. */
function invariants(label, e, d) {
  let good = true; const notes = [];
  const funded = e.store.listCampaigns().filter((x) => x.funding && x.funding.state === 'confirmed');
  for (const c of funded) {
    const pullsFor = d.all().filter((x) => x.kind === 'pull' && x.ref.startsWith(`campaign:fund:${c.id}:`));
    const failedRefs = new Set((c.fundingFailures || []).map((f) => f.ref));
    const strayPulls = pullsFor.filter((x) => x.ref !== c.funding.ref && !failedRefs.has(x.ref));
    const rel = d.all().filter((x) => (x.rows?.[0]?.meta || {}).campaignId === c.id && x.rows[0].kind === 'release').reduce((t, x) => t + BigInt(x.rows[0].amountAtomic || 0), 0n);
    const refunds = d.all().filter((x) => x.ref === `campaign:refund:${c.id}`);
    if (!pullsFor.some((x) => x.ref === c.funding.ref) || strayPulls.length || rel > BigInt(c.funding.atomic) || refunds.length > 1) { good = false; notes.push(c.slug); }
    if (refunds.length === 1 && rel + BigInt(refunds[0].rows[0].amountAtomic || 0) !== BigInt(c.funding.atomic)) { good = false; notes.push(`${c.slug} unbalanced`); }
    if (refunds.length === 1 && String(refunds[0].token?.address || '').toLowerCase() !== String(c.funding.token.address).toLowerCase()) { good = false; notes.push(`${c.slug} refund in the wrong token`); }
  }
  ok(`${label}. every funded campaign: one confirmed pull, Σ releases ≤ funded, ≤1 refund in the pulled token, refund + Σ releases = funded when refunded`, good, notes.join(', ') || `${funded.length} campaigns`);
}
{
  invariants('C9', eng, door);
  const src = ['campaign-engine.js', 'campaign-routes.js', 'campaign-store.js', 'campaign-eligibility.js', 'campaign-merkle.js', 'x-token-store.js']
    .map((f) => readFileSync(path.join(HERE, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).join('\n');
  ok('C9. no campaign module imports a signer, the escrow, rewards or a private key', !/from '\.\/(escrow-chain|rewards|seat-escrow)\.js'|privateKeyToAccount|createWalletClient|process\.env\.[A-Z_]*PRIVATE_KEY/.test(src));
}
// ── C10 adversarial cases (break.mjs, reproduced against the real door) ──
console.log('\n── C10. adversarial: races, receipts, X spend, wallets, close ─');
{
  process.env.CAMPAIGN_FEE_TOKENS = GT;
  const dirR = mkdtempSync(path.join(tmpdir(), 'mc-campaigns-race-'));
  let receipt = { status: 'success' };
  const chainR = mockChain();
  const fastPull = chainR.transferFrom;
  chainR.transferFrom = async (a) => { await sleep(40); return fastPull(a); };
  const doorR = createSettlement({ dataDir: dirR, chain: chainR, platformAddress: PLATFORM, log: quiet });
  const engR = makeEngine(dirR, doorR, {
    readAllowance: async () => { await sleep(10); return 10n ** 30n; },
    confirmTx: async (h) => { await sleep(15); return receiptFor(doorR, h, receipt ? receipt.status : null); },
  });

  // ── finding 1: the token switched while the pull was in flight
  const T1 = await engR.createCampaign(holler({ title: 'Race token switch', reward: { type: 'token', address: GT, amount: '5' }, budget: { amount: '100' } }), as(creator));
  const p1 = fundAs(engR, T1, W(0x71));
  await sleep(25);
  const sw = await attempt(() => engR.updateCampaign(T1.id, { reward: { type: 'usdc', amount: '5' }, budget: { amount: '100' } }, as(creator)));
  const f1 = await p1;
  const pulled1 = chainR.pulls[chainR.pulls.length - 1];
  ok('C10.1 TOKEN SWITCH MID-FUNDING: updateCampaign during the pull is refused', code(sw) === 'funding_in_progress', code(sw));
  ok('C10.1 ...the campaign keeps the token that was PULLED (funding.token), and pays/refunds only in it',
    f1.status === 'funded' && pulled1.token.address === GT && f1.funding.token.address === GT && f1.token.address === GT, `pulled ${pulled1.token.symbol}, campaign ${f1.token?.symbol}, funding ${f1.funding?.token?.symbol}`);
  engR.close(T1.id, as(creator));
  const rf1 = doorR.status(`campaign:refund:${T1.id}`);
  ok('C10.1 ...the refund returns exactly what was pulled, in the pulled token, to the funding wallet',
    rf1?.token?.address === GT && rf1.amountAtomic === String(pulled1.amountAtomic) && rf1.to === W(0x71), `${rf1?.token?.symbol} ${rf1?.amountAtomic}`);

  // ── finding 1 (defence in depth): terms changed under the pull by a direct write
  const T3 = await engR.createCampaign(holler({ title: 'Race direct write' }), as(creator));
  const p3 = fundAs(engR, T3, W(0x73));
  await sleep(25);
  { const cur = engR.store.getCampaign(T3.id); engR.store.putCampaign({ ...cur, token: { address: GT, decimals: 18, symbol: 'GT' } }); }
  const f3 = await p3;
  const rf3 = doorR.status(`campaign:refund:${T3.id}`);
  ok('C10.1 a pull that no longer matches the campaign terms does NOT finish: closed, recorded, and the pulled USDC refunded',
    f3.status === 'closed' && /did not match/.test(f3.closeReason || '') && rf3?.token?.address === USDC.address && rf3.amountAtomic === '12000000'
    && engR.store.ledger().some((x) => x.kind === 'funding-mismatch' && x.campaignId === T3.id), `${f3.status} ${rf3?.token?.symbol} ${rf3?.amountAtomic}`);

  // ── finding 6: close during the pull
  const T2 = await engR.createCampaign(holler({ title: 'Race close' }), as(creator));
  const p2 = fundAs(engR, T2, W(0x72));
  await sleep(25);
  const cl = await attempt(() => engR.close(T2.id, as(creator)));
  const f2 = await p2;
  ok('C10.6 CLOSE DURING THE PULL is refused; the campaign ends funded, never closed-then-overwritten, no refund of an unconfirmed pull',
    code(cl) === 'funding_in_progress' && f2.status === 'funded' && !f2.closedAt && !doorR.status(`campaign:refund:${T2.id}`), `${code(cl)} → ${f2.status}${f2.closedAt ? ' closedAt set' : ''}`);

  // ── finding 2: no receipt / reverted receipt
  receipt = null;
  const U = await engR.createCampaign(holler({ title: 'Unconfirmed pull' }), as(creator));
  const fu = await fundAs(engR, U, W(0x74));
  ok('C10.2 NO RECEIPT → funding_pending, not funded: nothing counts as funded', fu.status === 'funding_pending' && engR.totals(U.id).funded === 0n, fu.status);
  const uo = await attempt(() => engR.open(U.id, as(creator)));
  const uu = await attempt(() => engR.updateCampaign(U.id, { budget: { amount: '1' } }, as(creator)));
  const uc = await attempt(() => engR.close(U.id, as(creator)));
  ok('C10.2 ...open, update and close are all refused while it is pending', code(uo) === 'not_funded' && code(uu) === 'funding_in_progress' && code(uc) === 'funding_in_progress', `${code(uo)} ${code(uu)} ${code(uc)}`);
  engR.sync(); await sleep(80);
  ok('C10.2 ...sync asks the chain again; still no receipt → still pending', engR.store.getCampaign(U.id).status === 'funding_pending');
  receipt = { status: 'success' };
  engR.sync(); await sleep(80);
  ok('C10.2 ...a SUCCESS receipt found by sync → funded, and only then does it open', engR.store.getCampaign(U.id).status === 'funded' && code(await attempt(() => engR.open(U.id, as(creator)))) === 'ok');
  receipt = null;
  const V = await engR.createCampaign(holler({ title: 'Reverted pull' }), as(creator));
  await fundAs(engR, V, W(0x75));
  receipt = { status: 'reverted' };
  engR.sync(); await sleep(80);
  const v1 = engR.store.getCampaign(V.id);
  ok('C10.2 A REVERTED PULL found by sync → back to draft, the failure on record, nothing funded', v1.status === 'draft' && !v1.funding && v1.fundingFailures?.length === 1 && /reverted/.test(v1.fundingFailures[0].why), v1.status);
  const vr = await attempt(() => fundAs(engR, V, W(0x75)));
  ok('C10.2 ...a reverted pull answered inside fund() is refused (pull_reverted) and recorded too', code(vr) === 'pull_reverted' && engR.store.getCampaign(V.id).fundingFailures.length === 2 && engR.store.getCampaign(V.id).status === 'draft', code(vr));
  receipt = { status: 'success' };
  const v3 = await fundAs(engR, V, W(0x75));
  ok('C10.2 ...the next attempt, confirmed, funds it under its own ref', v3.status === 'funded' && v3.funding.ref === `campaign:fund:${V.id}:3`);

  // ── finding 3: parallel X spend, estimates
  mockX.bearer = true;
  const X1 = await engR.createCampaign(holler({ title: 'X spend race', budget: { amount: '10' } }), as(creator));
  await fundAs(engR, X1, W(0x76));
  const pages0 = xcalls.pages;
  const runs = await Promise.allSettled(Array.from({ length: 5 }, () => engR.buildSet({ name: 'L', source: 'x-list', sourceRef: '88', confirm: true, confirmCostUsd: 9, campaignId: X1.id }, as(creator))));
  const tx1 = engR.totals(X1.id);
  ok('C10.3 FIVE CONCURRENT $9 BUILDS on a $10 budget: one runs, four are refused before any X call, X cost ≤ funded',
    runs.filter((x) => x.status === 'fulfilled').length === 1 && runs.filter((x) => x.reason?.code === 'budget_spent').length === 4 && tx1.xCost <= tx1.funded && tx1.remaining >= 0n && tx1.xHeld === 0n && xcalls.pages - pages0 === 9,
    `ok=${runs.filter((x) => x.status === 'fulfilled').length} xCost=${tx1.xCost} funded=${tx1.funded} pages=${xcalls.pages - pages0}`);
  const fbSet = await engR.buildSet({ name: 'Race vouchers', source: 'manual', sourceRef: '4001\n4002\n4003\n4004\n4005' }, as(creator));
  const X2 = await engR.createCampaign(holler({ title: 'Check race', reward: { type: 'usdc', amount: '1' }, budget: { amount: '1.05' }, rules: { followedByFromSet: { enabled: true, min: 2, perClaimCostCapUsd: 0.05, referenceSetId: fbSet.id } } }), as(creator));
  await fundAs(engR, X2, W(0x77)); engR.open(X2.id, as(creator));
  const twin = await Promise.all([engR.check(X2.slug, as(grace)), engR.check(X2.slug, as(alice))]);
  const tx2 = engR.totals(X2.id);
  const cover = twin.filter((x) => /cannot cover/.test(x.result.checks.find((c) => c.rule === 'followedByFromSet')?.detail || '')).length;
  ok('C10.3 two CONCURRENT vouched checks on a budget that covers one: one spends, the other fails closed; X cost ≤ one cap', tx2.xCost <= 50_000n && cover === 1 && tx2.remaining >= 0n, `xCost=${tx2.xCost} refusedForBudget=${cover}`);
  const X3 = await engR.createCampaign(holler({ title: 'Estimates', budget: { amount: '10' } }), as(creator));
  await fundAs(engR, X3, W(0x78));
  const { FREE_ESTIMATES } = await import('./campaign-engine.js');
  const e0 = engR.totals(X3.id).xCost;
  for (let i = 0; i < FREE_ESTIMATES; i++) await engR.estimateForCampaign({ source: 'x-list', sourceRef: '77', campaignId: X3.id }, as(creator));
  const e1 = engR.totals(X3.id).xCost;
  const e4 = await engR.estimateForCampaign({ source: 'x-list', sourceRef: '77', campaignId: X3.id }, as(creator));
  const e5 = await engR.estimateForCampaign({ source: 'x-list', sourceRef: '77', campaignId: X3.id }, as(creator));
  const e2 = engR.totals(X3.id).xCost;
  ok(`C10.3 ESTIMATES: the first ${FREE_ESTIMATES} are free, every one after is charged to the campaign ($0.01 lookup each)`, e1 === e0 && e2 - e1 === 20_000n && e4.charged && e5.charged, `free ${e1 - e0}, then ${e2 - e1}`);
  const xcRefs = doorR.intentsFor('campaign:xcost:').filter((x) => (x.rows[0].meta || {}).campaignId === X3.id);
  ok('C10.3 ...each X charge has its own ref (randomUUID): two charges, two RETAINED rows, none deduped away', xcRefs.length === 2 && new Set(xcRefs.map((x) => x.ref)).size === 2 && xcRefs.every((x) => x.status === 'RETAINED'));
  {
    const { estimateAllowed, ESTIMATE_PER_MIN } = await import('./campaign-routes.js');
    const key = `gate-${Math.random()}`, t0 = Date.now();
    const hits = Array.from({ length: ESTIMATE_PER_MIN + 1 }, (_, i) => estimateAllowed(key, t0 + i));
    ok(`C10.3 ...and the estimate route is rate-limited per account: ${ESTIMATE_PER_MIN} a minute, the next refused, allowed again a minute on`, ESTIMATE_PER_MIN === 10 && hits.slice(0, 10).every(Boolean) && !hits[10] && estimateAllowed(key, t0 + 61_000));
  }
  mockX.bearer = false;
  const nb = await attempt(() => engR.estimateForCampaign({ source: 'x-list', sourceRef: '77', campaignId: X3.id }, as(creator)));
  ok('C10.3 ...with no X_BEARER_TOKEN the estimate makes no X call and charges nothing', code(nb) === 'no_bearer' && engR.totals(X3.id).xCost === e2);

  // ── finding 5: a stale check must not overwrite a claim that moved on
  const S5 = await engR.createCampaign(holler({ title: 'Check vs reserve', action: { kind: 'holler', roomHandle: 'gatestage', require: 'approved' }, rules: { minFollowers: 10 } }), as(creator));
  await fundAs(engR, S5, W(0x79)); engR.open(S5.id, as(creator));
  const hank = mkX('hank', '3010');
  // Two days on: hank's X details (fetched in real time) are stale on the
  // engine's clock, so every check refreshes them through X — slowly, below.
  clock += 2 * 86_400_000;
  mockX.bearer = true;
  await engR.check(S5.slug, as(hank));
  const k0 = engR.store.claimFor({ campaignId: S5.id, accountId: hank.id }).byAccount;
  const origById = mockX.fetchUserById;
  mockX.fetchUserById = async function (a) { await sleep(80); return origById.call(this, a); };
  const pc = engR.check(S5.slug, as(hank));
  await sleep(10);
  const r5 = engR.reserve({ slug: S5.slug, accountId: hank.id, kind: 'holler', roomId: 'room-holler' });
  engR.bind(r5.claimId, { letterId: 'L-hank' }); engR.onLetterEvent('L-hank', 'approved');
  const mid5 = engR.store.getClaim(k0.id).status;
  await pc;
  clock -= 2 * 86_400_000;
  mockX.fetchUserById = origById; mockX.bearer = false;
  const k5 = engR.store.getClaim(k0.id);
  ok('C10.5 A STALE CHECK cannot overwrite a claim that reserved and went owed while X answered', mid5 === 'owed' && k5.status === 'owed' && k5.owedAtomic === '5000000' && engR.totals(S5.id).activeCount === 1, `${mid5} → ${k5.status}`);

  // ── finding 8: hidden / past the deadline
  const H8 = await engR.createCampaign(holler({ title: 'Hidden', action: { kind: 'holler', roomHandle: 'gatestage', require: 'approved' } }), as(creator));
  await fundAs(engR, H8, W(0x7a)); engR.open(H8.id, as(creator));
  await engR.check(H8.slug, as(carol));
  const r8 = engR.reserve({ slug: H8.slug, accountId: carol.id, kind: 'holler', roomId: 'room-holler' });
  engR.bind(r8.claimId, { letterId: 'L-h8' });
  engR.setHidden(H8.id, true);
  engR.onLetterEvent('L-h8', 'approved');
  ok('C10.8 HIDDEN by an admin: a Holler clearing moderation does not become owed', engR.store.getClaim(r8.claimId).status === 'recorded');
  const H9 = await engR.createCampaign(holler({ title: 'Deadline', deadline: new Date(clock + 3_600_000).toISOString(), action: { kind: 'holler', roomHandle: 'gatestage', require: 'approved' } }), as(creator));
  await fundAs(engR, H9, W(0x7b)); engR.open(H9.id, as(creator));
  await engR.check(H9.slug, as(dave)); await engR.check(H9.slug, as(erin));
  const r9 = engR.reserve({ slug: H9.slug, accountId: dave.id, kind: 'holler', roomId: 'room-holler' });
  engR.bind(r9.claimId, { letterId: 'L-h9' });
  const r9b = engR.reserve({ slug: H9.slug, accountId: erin.id, kind: 'holler', roomId: 'room-holler' });
  clock += 2 * 3_600_000;                      // past the deadline, before any sweep closed it
  engR.onLetterEvent('L-h9', 'approved');
  ok('C10.B PAST THE DEADLINE (not yet swept): a Holler SUBMITTED before it still counts, in the grace window', ['owed', 'releasing'].includes(engR.store.getClaim(r9.claimId).status), engR.store.getClaim(r9.claimId).status);
  ok('C10.8 ...but a slot reserved and never submitted cannot advance past the deadline', engR.advance(engR.store.getClaim(r9b.claimId), 'approved').status === 'recorded');
  clock -= 2 * 3_600_000;

  // ── finding 8: the creator's own token vouches only from the list
  accounts.attachLink(creator.id, { provider: 'x', platformId: '4100', username: 'gatecreatorx', attributes: recs(BASE) });
  HOLDERS.set('4100', creator.id); FOLLOWS.add('4100>3011');
  const ivy = mkX('ivy', '3011');
  const solo = await engR.buildSet({ name: 'Not the creator', source: 'manual', sourceRef: '4001' }, as(creator));
  const withC = await engR.buildSet({ name: 'With the creator', source: 'manual', sourceRef: '4001\n4100' }, as(creator));
  const vouch = (title, setId) => holler({ title, reward: { type: 'usdc', amount: '1' }, budget: { amount: '10' }, rules: { followedByFromSet: { enabled: true, min: 1, perClaimCostCapUsd: 0.05, referenceSetId: setId } } });
  const CV1 = await engR.createCampaign(vouch('Creator not listed', solo.id), as(creator));
  await fundAs(engR, CV1, W(0x7c)); engR.open(CV1.id, as(creator));
  const CV2 = await engR.createCampaign(vouch('Creator listed', withC.id), as(creator));
  await fundAs(engR, CV2, W(0x7d)); engR.open(CV2.id, as(creator));
  const iv1 = await engR.check(CV1.slug, as(ivy));
  const iv2 = await engR.check(CV2.slug, as(ivy));
  ok('C10.8 THE CREATOR\'S TOKEN VOUCHES ONLY FROM THE LIST: not on it → the creator\'s follow does not count; on it → it does', !iv1.result.eligible && iv2.result.eligible);
  accounts.detachLink(creator.id, 'x'); HOLDERS.delete('4100');

  // ── finding 8: no X spend after the refund; a close mid-check waits for the hold
  const X4 = await engR.createCampaign(holler({ title: 'Close mid check', reward: { type: 'usdc', amount: '1' }, budget: { amount: '10' }, rules: { followedByFromSet: { enabled: true, min: 2, perClaimCostCapUsd: 0.05, referenceSetId: fbSet.id } } }), as(creator));
  await fundAs(engR, X4, W(0x7e)); engR.open(X4.id, as(creator));
  const origLookup = mockX.lookupConnection;
  mockX.lookupConnection = async function (a) { await sleep(30); return origLookup.call(this, a); };
  const pc4 = engR.check(X4.slug, as(grace));
  await sleep(20);
  engR.close(X4.id, as(creator));
  const early = doorR.status(`campaign:refund:${X4.id}`);
  await pc4;
  mockX.lookupConnection = origLookup;
  const c4 = engR.store.getCampaign(X4.id);
  const rf4 = doorR.status(`campaign:refund:${X4.id}`);
  ok('C10.8 a CLOSE while a vouched check is mid-flight: the refund WAITS for the X hold, then = funded − X cost (X cost charged, not lost)',
    !early && !!rf4 && BigInt(c4.xCostAtomic) > 0n && BigInt(rf4.amountAtomic) + BigInt(c4.xCostAtomic) === BigInt(c4.funding.atomic), `refund ${rf4?.amountAtomic} + x ${c4.xCostAtomic} vs ${c4.funding.atomic}`);
  mockX.bearer = true;
  const late = [
    await attempt(() => engR.check(X4.slug, as(frank))),
    await attempt(() => engR.buildSet({ name: 'late', source: 'x-list', sourceRef: '77', confirm: true, confirmCostUsd: 2, campaignId: X4.id }, as(creator))),
    await attempt(() => engR.estimateForCampaign({ source: 'x-list', sourceRef: '77', campaignId: X4.id }, as(creator))),
  ];
  mockX.bearer = false;
  ok('C10.8 AFTER THE REFUND no X spend is possible on the campaign: check, build and estimate refused, X cost unchanged',
    late.every((x) => x.error) && engR.store.getCampaign(X4.id).xCostAtomic === c4.xCostAtomic, late.map(code).join(','));

  // ── finding 9: a FAILED payout
  {
    const dirF = mkdtempSync(path.join(tmpdir(), 'mc-campaigns-failed-'));
    const chainF = mockChain();
    let payAttempts = 0;
    const realT = chainF.transfer;
    chainF.transfer = async (a) => { if (a.to === W(0xfa11)) { payAttempts++; throw new Error('execution reverted'); } return realT(a); };
    const doorF = createSettlement({ dataDir: dirF, chain: chainF, platformAddress: PLATFORM, log: quiet });
    const engF = makeEngine(dirF, doorF);
    allowance = 10n ** 30n;
    const F = await engF.createCampaign(holler({ title: 'Failed payout', action: { kind: 'holler', roomHandle: 'gatestage', require: 'approved' } }), as(creator));
    await fundAs(engF, F, W(0x7f)); engF.open(F.id, as(creator));
    const fay = mkX('fay', '3012');
    accounts.setAccountPayoutWallet(fay.id, W(0xfa11));
    await engF.check(F.slug, as(fay));
    const rF = engF.reserve({ slug: F.slug, accountId: fay.id, kind: 'holler', roomId: 'room-holler' });
    engF.bind(rF.claimId, { letterId: 'L-fay' }); engF.onLetterEvent('L-fay', 'approved');
    await doorF.flush(); engF.sync(); await doorF.flush(); engF.sync(); engF.tryPay(rF.claimId);
    const kf = engF.store.getClaim(rF.claimId);
    ok('C10.9 A FAILED PAYOUT: the door records FAILED once, the claim reads failed, and nothing re-sends it', kf.status === 'failed' && payAttempts === 1 && doorF.status(`campaign:pay:${rF.claimId}`).status === 'FAILED' && engF.claimView(kf).payout.door === 'FAILED', `${kf.status}, ${payAttempts} attempt(s)`);
    engF.close(F.id, as(creator)); await doorF.flush();
    const rfF = doorF.status(`campaign:refund:${F.id}`);
    ok('C10.9 ...it stays counted against the budget: the refund is funded − the failed payout (7, not 12), and is paid', rfF?.amountAtomic === '7000000' && rfF.status === 'DONE' && payAttempts === 1, `${rfF?.amountAtomic} ${rfF?.status}`);
    invariants('C10.9', engF, doorF);
    engF.stop();
  }

  // ── E: validation
  {
    const v = async (over) => code(await attempt(() => engR.createCampaign(holler({ title: `Validate ${Math.random()}`, ...over }), as(creator))));
    const noDl = await v({ deadline: null });
    const pastDl = await v({ deadline: new Date(clock - 60_000).toISOString() });
    const farDl = await v({ deadline: new Date(clock + 91 * 86_400_000).toISOString() });
    const okDl = await v({ deadline: new Date(clock + 89 * 86_400_000).toISOString() });
    const thin = await v({ reward: { type: 'usdc', amount: '5' }, budget: { amount: '4.99' } });
    ok('C10.E a deadline is REQUIRED, not in the past, at most 90 days out; a budget below one reward is refused',
      noDl === 'invalid' && pastDl === 'invalid' && farDl === 'invalid' && okDl === 'ok' && thin === 'invalid', `${noDl} ${pastDl} ${farDl} ${okDl} ${thin}`);
    const fat = await engR.createCampaign(holler({ title: 'Fat budget', reward: { type: 'usdc', amount: '1' }, budget: { amount: '50' }, maxClaims: 5 }), as(creator));
    ok('C10.E a budget above reward × maxClaims is ALLOWED, with a warning on the creator view', fat.status === 'draft' && engR.manageView(fat).warnings.length === 1 && engR.manageView(engR.store.getCampaign(T2.id)).warnings.length === 0);
  }
  invariants('C10', engR, doorR);
  engR.stop();
}

// ── finding 8: X token refresh, one per holder
{
  const http = await import('http');
  let hits = 0;
  const srvT = http.createServer((req, res) => { hits++; setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ access_token: `fresh-${hits}`, refresh_token: 'rotated', expires_in: 7200 })); }, 80); });
  await new Promise((res) => srvT.listen(0, '127.0.0.1', res));
  const names = ['X_TOKEN_KEY', 'X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_TOKEN_BASE'];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { X_TOKEN_KEY: 'gate-only', X_CLIENT_ID: 'gate-only', X_CLIENT_SECRET: 'gate-only', X_TOKEN_BASE: `http://127.0.0.1:${srvT.address().port}` });
  const xt = await import('./x-token-store.js');
  xt._resetXTokensForTests();
  xt.saveXToken('acct_refresh', '4999', { access_token: 'old', refresh_token: 'r1', expires_in: -100 });
  const got = await Promise.all([1, 2, 3].map(() => xt.getXAccessToken('acct_refresh', { log: quiet })));
  ok('C10.8 X TOKEN REFRESH IS SERIALIZED per holder: three concurrent callers → ONE refresh (X rotates the refresh token), one token', hits === 1 && got.every((t) => t === 'fresh-1'), `${hits} refresh call(s): ${got.join(',')}`);
  srvT.close();
  for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  xt._resetXTokensForTests();
}

// ── C10.F–K round 2 (break-2.mjs, reproduced against the real door) ──────
console.log('\n── C10.F–K round 2: signature, terms clock, spender, stuck, hidden, X ceiling, deadline, webhook ─');
{
  const clock0 = clock;
  const allowance0 = allowance;
  allowance = 10n ** 30n;
  let receiptS = { status: 'success' };
  const dirS = mkdtempSync(path.join(tmpdir(), 'mc-campaigns-sig-'));
  const chainS = mockChain();
  const doorS = createSettlement({ dataDir: dirS, chain: chainS, platformAddress: PLATFORM, log: quiet });
  const engS = makeEngine(dirS, doorS, { confirmTx: async (h) => receiptFor(doorS, h, receiptS ? receiptS.status : null) });
  const creatorWallet = W(0xc1), strangerWallet = W(0x57);
  const fresh = (title, over = {}) => engS.createCampaign(holler({ title, ...over }), as(creator));

  // ── N10: the funding wallet signs a message naming the campaign
  const S1 = await fresh('Sig valid');
  const s1 = await attempt(() => fundAs(engS, S1, creatorWallet));
  ok('C10.F A SIGNATURE BY THE FUNDING WALLET over this campaign funds it; the signed message hash is on record',
    code(s1) === 'ok' && s1.value.status === 'funded' && /^0x[0-9a-f]{64}$/.test(s1.value.funding?.fundSigHash || ''), code(s1));
  const S2 = await fresh('Sig stranger');
  const pullsBefore = chainS.pulls.length;
  const theirs = approvalFor(S2, strangerWallet);
  const s2 = await attempt(async () => engS.fund(S2.id, { wallet: strangerWallet, approveTx: theirs, ...(await fundProof(S2, strangerWallet, { signer: KEYS.get(creatorWallet) })) }, as(creator)));
  ok('C10.F N10 A STRANGER’S APPROVE (= the budget, after creation) + the creator’s own signature over the stranger’s address is refused; nothing pulled',
    code(s2) === 'signature_invalid' && /not signed by the funding wallet/.test(s2.error?.message || '') && chainS.pulls.length === pullsBefore && engS.store.getCampaign(S2.id).status === 'draft', code(s2));
  const s2b = await attempt(() => engS.fund(S2.id, { wallet: strangerWallet, approveTx: approvalFor(S2, strangerWallet) }, as(creator)));
  ok('C10.F ...a valid approve with NO signature is asked to sign (signature_required); nothing pulled', code(s2b) === 'signature_required' && chainS.pulls.length === pullsBefore, code(s2b));
  const S3 = await fresh('Sig other campaign');
  const s3 = await attempt(async () => engS.fund(S3.id, { wallet: creatorWallet, approveTx: approvalFor(S3, creatorWallet), ...(await fundProof(S3, creatorWallet, { over: { campaignId: S2.id } })) }, as(creator)));
  const s3b = await attempt(async () => engS.fund(S3.id, { wallet: creatorWallet, approveTx: approvalFor(S3, creatorWallet), ...(await fundProof(S3, creatorWallet, { over: { amountAtomic: '1000000' } })) }, as(creator)));
  ok('C10.F a signature over ANOTHER campaign id, or another amount, is refused; nothing pulled',
    code(s3) === 'signature_invalid' && code(s3b) === 'signature_invalid' && engS.store.getCampaign(S3.id).status === 'draft' && chainS.pulls.length === pullsBefore, `${code(s3)} ${code(s3b)}`);
  const s4 = await attempt(async () => engS.fund(S3.id, { wallet: creatorWallet, approveTx: approvalFor(S3, creatorWallet), ...(await fundProof(S3, creatorWallet, { deadline: Math.floor(clock / 1000) - 1 })) }, as(creator)));
  const s4b = await attempt(async () => engS.fund(S3.id, { wallet: creatorWallet, approveTx: approvalFor(S3, creatorWallet), ...(await fundProof(S3, creatorWallet, { deadline: Math.floor(clock / 1000) + 3600 })) }, as(creator)));
  ok('C10.F an EXPIRED signature is refused, and so is one whose deadline is over 10 minutes away', code(s4) === 'signature_expired' && code(s4b) === 'signature_invalid' && chainS.pulls.length === pullsBefore, `${code(s4)} ${code(s4b)}`);
  const S5 = await fresh('Sig replay');
  const ap5 = approvalFor(S5, creatorWallet);
  const pr5 = await fundProof(S5, creatorWallet);
  receiptS = { status: 'reverted' };
  const s5a = await attempt(() => engS.fund(S5.id, { wallet: creatorWallet, approveTx: ap5, ...pr5 }, as(creator)));
  receiptS = { status: 'success' };
  const s5b = await attempt(() => engS.fund(S5.id, { wallet: creatorWallet, approveTx: ap5, ...pr5 }, as(creator)));
  const s5c = await attempt(async () => engS.fund(S5.id, { wallet: creatorWallet, approveTx: ap5, ...(await fundProof(S5, creatorWallet)) }, as(creator)));
  ok('C10.F REPLAY: the same signed message, after its pull reverted, is refused (signature_reused); a fresh signature funds',
    code(s5a) === 'pull_reverted' && code(s5b) === 'signature_reused' && code(s5c) === 'ok' && s5c.value.status === 'funded', `${code(s5a)} → ${code(s5b)} → ${code(s5c)}`);

  // ── #3: the terms clock, and seconds vs milliseconds
  const S6 = await fresh('Terms clock');
  clock += 60_000;
  const old6 = approvalFor(S6, creatorWallet, { timestampMs: clock, approvals: [{ token: USDC.address, owner: creatorWallet, spender: CSPEND, value: '37000000' }] });
  clock += 5_000;
  await engS.updateCampaign(S6.id, { budget: { amount: '37' } }, as(creator));
  const s6 = await attempt(async () => engS.fund(S6.id, { wallet: creatorWallet, approveTx: old6, ...(await fundProof(engS.store.getCampaign(S6.id), creatorWallet)) }, as(creator)));
  ok('C10.G #3 TERMS CLOCK: an approve mined BEFORE the draft’s budget was edited to match it is refused, even with a valid signature',
    code(s6) === 'approve_invalid' && /current budget/.test(s6.error?.message || '') && engS.store.getCampaign(S6.id).status === 'draft', code(s6));
  clock = Math.floor(clock / 1000) * 1000 + 700;
  const S7 = await fresh('Same second');
  const s7 = await attempt(async () => engS.fund(S7.id, { wallet: creatorWallet, approveTx: approvalFor(S7, creatorWallet, { timestampMs: Math.floor(clock / 1000) * 1000 }), ...(await fundProof(S7, creatorWallet)) }, as(creator)));
  ok('C10.G #3 SECONDS: an honest approve mined in the same second the campaign was created funds it (block time is whole seconds)', code(s7) === 'ok' && s7.value.status === 'funded', code(s7));

  // ── #4: a dedicated campaign spender
  {
    const dirP = mkdtempSync(path.join(tmpdir(), 'mc-campaigns-seatkey-'));
    const chainP = mockChain({ signers: ['pull', 'platform'] });
    const engP = makeEngine(dirP, createSettlement({ dataDir: dirP, chain: chainP, platformAddress: PLATFORM, log: quiet }));
    const P4 = await engP.createCampaign(holler({ title: 'Seat key only' }), as(creator));
    const s8 = await attempt(() => fundAs(engP, P4, creatorWallet));
    ok('C10.H #4 DEDICATED SPENDER: a server holding only the SEAT pull key cannot fund a campaign (no_pull_signer) and pulls nothing',
      code(s8) === 'no_pull_signer' && chainP.pulls.length === 0 && engP.fundTerms(P4.id, as(creator)).pullSigner === false, code(s8));
    const t = engS.fundTerms(S3.id, as(creator));
    ok('C10.H ...the fund terms name the spender to approve (the campaign spender) and the holder (the platform wallet), and the message to sign',
      t.spender === CSPEND && t.holder === PLATFORM && t.sign.message.campaignId === S3.id && t.sign.message.amountAtomic === S3.budget.atomic && t.sign.domain.name === 'Holler Campaigns' && t.sign.primaryType === 'Fund');
    ok('C10.H ...every campaign pull went through the campaignPull slot, recorded on its PULL row',
      chainS.pulls.length >= 3 && chainS.pulls.every((x) => x.signer === 'campaignPull') && doorS.all().filter((x) => x.kind === 'pull').every((x) => x.rows[0].signer === 'campaignPull'));
    const noPay = makeEngine(dirP, createSettlement({ dataDir: mkdtempSync(path.join(tmpdir(), 'mc-campaigns-nopay-')), chain: mockChain({ signers: ['campaignPull'] }), platformAddress: PLATFORM, log: quiet }));
    ok('C10.H ...the creator view says whether this server can SEND payouts (payoutsEnabled) and whether it has the X app token',
      noPay.manageView(P4).payoutsEnabled === false && engS.manageView(S1).payoutsEnabled === true && typeof engS.manageView(S1).xAppToken === 'boolean');
  }

  // ── #5: a stuck funding_pending
  const S9 = await fresh('Stuck pull');
  const stick = (c, atMs) => engS.store.putCampaign({ ...c, status: 'funding_pending', fundingAttempts: 1, funding: { state: 'pulling', wallet: creatorWallet, ref: `campaign:fund:${c.id}:1`, token: USDC, atomic: c.budget.atomic, txHash: null, receipt: null, at: new Date(atMs).toISOString() } });
  stick(S9, clock);
  engS.sync(); await sleep(60);
  const early = engS.store.getCampaign(S9.id);
  const tooSoon = await attempt(() => engS.resolveStuckFunding(S9.id, { isAdmin: true }));
  const notAdmin = await attempt(() => engS.resolveStuckFunding(S9.id, { isAdmin: false }));
  clock += 31 * 60_000;
  // Round 3: the chain's Transfer logs decide, never the allowance (which
  // stays the whole budget throughout, as if the creator had re-approved).
  const landed9 = { token: USDC.address, from: creatorWallet, to: PLATFORM, atomic: S9.budget.atomic, atMs: clock - 30 * 60_000, txHash: `0x${'e9'.repeat(32)}` };
  TRANSFERS.push(landed9);              // the budget DID move from the wallet to the platform
  engS.sync(); await sleep(60);
  const short = engS.store.getCampaign(S9.id);
  TRANSFERS.splice(TRANSFERS.indexOf(landed9), 1);   // no such transfer on chain: it never landed
  engS.sync(); await sleep(60);
  const resolved = engS.store.getCampaign(S9.id);
  ok('C10.I #5 STUCK FUNDING: a mid-pull stop waits for a person for 30 min (the admin route says too soon; non-admins refused)',
    early.status === 'funding_pending' && !!early.funding.needsPerson && code(tooSoon) === 'too_soon' && code(notAdmin) === 'forbidden', `${early.status} ${code(tooSoon)} ${code(notAdmin)}`);
  ok('C10.I ...after 30 min with a Transfer of the budget on chain (the pull may have landed) it still waits for a person, never guessed',
    short.status === 'funding_pending' && /may have landed/.test(short.funding.needsPerson || ''), short.funding?.needsPerson);
  ok('C10.I ...after 30 min with NO Transfer of the budget on chain, the SWEEP puts it back to draft, the failure on record',
    resolved.status === 'draft' && !resolved.funding && /never landed/.test(resolved.fundingFailures?.at(-1)?.why || ''), resolved.status);
  const S10 = await fresh('Stuck pull, admin');
  stick(S10, clock - 31 * 60_000);
  const adm = await attempt(() => engS.resolveStuckFunding(S10.id, { isAdmin: true }));
  ok('C10.I ...and the ADMIN resolve does the same on demand', code(adm) === 'ok' && adm.value.status === 'draft', code(adm));

  // ── #6: hiding stops payouts
  const H = await fresh('Hidden pays', { action: { kind: 'holler', roomHandle: 'gatestage', require: 'approved' } });
  await fundAs(engS, H, creatorWallet); engS.open(H.id, as(creator));
  const hk = mkX('hidey', '3020');
  await engS.check(H.slug, as(hk));
  const rh = engS.reserve({ slug: H.slug, accountId: hk.id, kind: 'holler', roomId: 'room-holler' });
  engS.bind(rh.claimId, { letterId: 'L-hidey' }); engS.onLetterEvent('L-hidey', 'approved');
  engS.setHidden(H.id, true);
  accounts.setAccountPayoutWallet(hk.id, W(0x4d));
  engS.sync(); engS.tryPay(rh.claimId);
  const paysOf = (cid) => doorS.intentsFor('campaign:pay:').filter((x) => (x.rows?.[0]?.meta || {}).campaignId === cid).length;
  const hiddenPays = paysOf(H.id);
  engS.setHidden(H.id, false); engS.sync();
  ok('C10.J #6 HIDDEN STOPS PAYOUTS: an owed claim on a hidden campaign gets no payout intent (sweep or tryPay); unhidden, the sweep pays it once',
    hiddenPays === 0 && paysOf(H.id) === 1, `hidden ${hiddenPays}, unhidden ${paysOf(H.id)}`);

  // ── #7: the X-check ceiling
  mockX.bearer = true;
  const pageUsers0 = mockX.pageUsers;
  mockX.pageUsers = async ({ maxResults }) => ({ ok: true, users: Array.from({ length: maxResults }, (_, i) => ({ id: String(990000 + i) })), nextToken: null, costUsd: maxResults * 0.01 });
  const set7 = await engS.buildSet({ name: 'Ceiling list', source: 'manual', sourceRef: '5001\n5002' }, as(creator));
  const X7 = await fresh('X ceiling', { budget: { amount: '20' }, maxClaims: 4, rules: { followedByFromSet: { enabled: true, min: 1, perClaimCostCapUsd: 0.5, referenceSetId: set7.id } } });
  await fundAs(engS, X7, creatorWallet); engS.open(X7.id, as(creator));
  let last7 = null;
  for (let i = 0; i < 12; i++) last7 = await engS.check(X7.slug, as(mkX(`burn${i}`, String(3100 + i))));
  const spent7 = BigInt(engS.store.getCampaign(X7.id).xCheckAtomic || 0);
  ok('C10.K #7 X-CHECK CEILING: 12 applicants who do not qualify spend at most 20% of a $20 budget ($4) on checks, then checks stop with a plain reason',
    spent7 > 0n && spent7 <= 4_000_000n && /checking allowance/.test(last7.result.checks.find((x) => x.rule === 'followedByFromSet')?.detail || ''), `$${Number(spent7) / 1e6} spent`);
  const X8 = await fresh('X ceiling set', { budget: { amount: '20' }, maxClaims: 4, rules: { followedByFromSet: { enabled: true, min: 1, perClaimCostCapUsd: 0.5, maxTotalUsd: 1, referenceSetId: set7.id } } });
  ok('C10.K ...a creator-set ceiling (maxTotalUsd) is stored and shown on the creator view', X8.rules.followedByFromSet.maxTotalUsd === 1 && engS.manageView(X8).xCheck.ceiling === '1');
  mockX.pageUsers = pageUsers0; mockX.bearer = false;

  // ── #8: bound after the deadline
  const DL = await fresh('Bind after deadline', { deadline: new Date(clock + 3_600_000).toISOString(), action: { kind: 'holler', roomHandle: 'gatestage', require: 'approved' } });
  await fundAs(engS, DL, creatorWallet); engS.open(DL.id, as(creator));
  const late = mkX('latey', '3030');
  await engS.check(DL.slug, as(late));
  clock = Date.parse(DL.deadline) - 1000;
  const rl = engS.reserve({ slug: DL.slug, accountId: late.id, kind: 'holler', roomId: 'room-holler' });
  clock = Date.parse(DL.deadline) + 5000;             // past it; the sweep has not closed it yet
  const boundLate = engS.bind(rl.claimId, { letterId: 'L-late' });
  engS.sync(); engS.onLetterEvent('L-late', 'approved');
  const kl = engS.store.getClaim(rl.claimId);
  ok('C10.L #8 a slot reserved 1 s before the deadline but bound 5 s after it is not bound, not honoured, never owed',
    boundLate === null && !['owed', 'releasing', 'paid'].includes(kl.status) && !kl.honourUntil, `${boundLate ? 'bound' : 'not bound'}, ${kl.status}`);
  engS.stop();
  clock = clock0; allowance = allowance0;
}
{
  // ── #1: a LiveKit subscriber token is not a webhook signature
  const saved = { u: process.env.LIVEKIT_URL, k: process.env.LIVEKIT_API_KEY, s: process.env.LIVEKIT_API_SECRET };
  process.env.LIVEKIT_URL = 'ws://127.0.0.1:9'; process.env.LIVEKIT_API_KEY = 'gatelk-unit'; process.env.LIVEKIT_API_SECRET = randomBytes(24).toString('hex');
  const { createLivekitService } = await import('./livekit.js');
  const { verifyWebhookJwt } = await import('./livekit-webhooks.js');
  const lk = createLivekitService({ log: quiet });
  const keys = { apiKey: process.env.LIVEKIT_API_KEY, apiSecret: process.env.LIVEKIT_API_SECRET };
  const forged = JSON.stringify({ id: 'forged-1', event: 'track_published', room: { name: 'mc-room-call' }, participant: { identity: 'seat:S-x' }, track: { type: 'VIDEO', source: 'CAMERA' } });
  const verdict = (tok, body = forged) => { try { verifyWebhookJwt(`Bearer ${tok}`, body, keys); return 'accepted'; } catch (e) { return e.message; } };
  const subTok = await lk.subscriberToken('room-call', 'viewer:anyone');
  const v1 = verdict(subTok);
  ok('C10.M #1 A SUBSCRIBER TOKEN (what any visitor gets from /api/livekit/token) is refused as a webhook signature', /no body digest/.test(v1), v1);
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const nowS = Math.floor(Date.now() / 1000);
  const hookTok = (claims) => { const h = b64({ alg: 'HS256', typ: 'JWT' }); const pl = b64(claims); return `${h}.${pl}.${createHmac('sha256', keys.apiSecret).update(`${h}.${pl}`).digest('base64url')}`; };
  const digest = createHash('sha256').update(forged).digest('base64');
  const vNbf = verdict(hookTok({ iss: keys.apiKey, sha256: digest, nbf: nowS, exp: nowS + 300 }));
  const vNone = verdict(hookTok({ iss: keys.apiKey, sha256: digest, exp: nowS + 300 }));
  const vOld = verdict(hookTok({ iss: keys.apiKey, sha256: digest, iat: nowS - 3600, exp: nowS + 300 }));
  ok('C10.M ...a webhook-shaped token (sha256 + nbf, LiveKit’s own builder) verifies; one with no issue time, or an hour old, is refused',
    vNbf === 'accepted' && /no issue time/.test(vNone) && /freshness/.test(vOld), `${vNbf} | ${vNone} | ${vOld}`);
  for (const [k, v] of [['LIVEKIT_URL', saved.u], ['LIVEKIT_API_KEY', saved.k], ['LIVEKIT_API_SECRET', saved.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

// ── C10.N–T round 3 (break-3.mjs, reproduced against the real door) ──────
console.log('\n── C10.N–T round 3: a pull lost after broadcast, stuck funding from chain facts, X refresh, replay ledger, deadline, spender, seat approve ─');
{
  const clock0 = clock, allowance0 = allowance;
  allowance = 10n ** 30n;
  const R3 = mkdtempSync(path.join(tmpdir(), 'mc-campaigns-r3-'));
  let n3 = 0;
  const dir3 = () => path.join(R3, String(++n3));
  const wallet3 = W(0xd3);
  const fresh3 = (e, title, over = {}) => e.createCampaign(holler({ title, ...over }), as(creator));
  const doorAt = (d, ch) => createSettlement({ dataDir: d, chain: ch, platformAddress: PLATFORM, log: quiet });

  // ── #1: a pull that throws AFTER it was broadcast
  {
    const d = dir3();
    const ch = mockChain();
    let onChain = 0;
    // The legacy adapter path: transferFrom lands on chain, then the RPC call times out.
    ch.transferFrom = async (a) => { ch.pulls.push(a); onChain += 1; throw new Error('HTTP request failed: timeout (sendRawTransaction)'); };
    const e3 = makeEngine(d, doorAt(d, ch));
    const N1 = await fresh3(e3, 'Lost after broadcast');
    const r1 = await attempt(() => fundAs(e3, N1, wallet3));
    const after1 = e3.store.getCampaign(N1.id);
    ch.transferFrom = async (a) => { ch.pulls.push(a); onChain += 1; return `0x${'ab'.repeat(32)}`; };
    const r2 = await attempt(() => fundAs(e3, N1, wallet3));
    ok('C10.N #1 A PULL THAT THROWS AFTER BROADCAST (RPC timeout) stays funding_pending for a person, never draft; a second fund is refused; ONE transfer on chain',
      code(r1) === 'pull_unconfirmed' && after1.status === 'funding_pending' && !!after1.funding?.needsPerson && code(r2) === 'funding_in_progress' && onChain === 1,
      `${code(r1)} → ${after1.status}; retry ${code(r2)}; ${onChain} on chain`);
    // A PROVABLY pre-send failure (viem: the gas estimate reverted) still goes back to draft.
    const N2 = await fresh3(e3, 'Refused before send');
    ch.transferFrom = async () => {
      const inner = Object.assign(new Error('execution reverted: ERC20: insufficient allowance'), { name: 'EstimateGasExecutionError' });
      throw Object.assign(new Error('The contract function "transferFrom" reverted.'), { name: 'ContractFunctionExecutionError', cause: inner });
    };
    const p1 = await attempt(() => fundAs(e3, N2, wallet3));
    const afterP = e3.store.getCampaign(N2.id);
    ch.transferFrom = async (a) => { ch.pulls.push(a); return `0x${'cd'.repeat(32)}`; };
    const p2 = await attempt(() => fundAs(e3, N2, wallet3));
    ok('C10.N ...a PROVABLY pre-send failure (the gas estimate reverted) goes back to draft, and the next attempt funds',
      code(p1) === 'pull_failed' && afterP.status === 'draft' && !afterP.funding && code(p2) === 'ok' && p2.value.status === 'funded', `${code(p1)} → ${afterP.status} → ${code(p2)}`);
    e3.stop();
  }
  {
    // The sign-ahead door: the hash is on the ledger before the send; the receipt decides.
    const d = dir3();
    const ch = mockChain();
    let seq = 0, sends = 0, rowAtSend = null, door3 = null, rc = null;
    ch.prepareTransferFrom = async (a) => {
      const txHash = `0x${(++seq).toString(16).padStart(64, '5')}`;
      return { txHash, send: async () => { sends += 1; ch.pulls.push(a); rowAtSend = door3.all().find((x) => x.kind === 'pull' && x.txHash === txHash)?.status || null; throw new Error('already known'); } };
    };
    door3 = doorAt(d, ch);
    const e3 = makeEngine(d, door3, { confirmTx: async (h) => receiptFor(door3, h, rc ? rc.status : null) });
    const N3 = await fresh3(e3, 'Signed ahead');
    const s1 = await attempt(() => fundAs(e3, N3, wallet3));
    const mid = e3.store.getCampaign(N3.id);
    const H = mid.funding ? door3.status(mid.funding.ref)?.txHash : null;
    const s2 = await attempt(() => fundAs(e3, N3, wallet3));
    e3.sync(); await sleep(60);
    const still = e3.store.getCampaign(N3.id);
    rc = { status: 'success' };
    e3.sync(); await sleep(60);
    const done = e3.store.getCampaign(N3.id);
    ok('C10.N SIGN AHEAD: the door writes PULL_SENT {ref, txHash} BEFORE the raw send; the send throws ("already known") and the hash is still on record',
      rowAtSend === 'PULL_SENT' && !!H && mid.funding.txHash === H && code(s1) === 'pull_unconfirmed', `row at send: ${rowAtSend}; ${code(s1)}`);
    ok('C10.N ...nothing is re-sent (a retry is refused, sync waits on the receipt), and that hash\'s SUCCESS receipt funds it, once',
      code(s2) === 'funding_in_progress' && still.status === 'funding_pending' && done.status === 'funded' && done.funding.txHash === H && !done.funding.needsPerson && sends === 1,
      `${still.status} → ${done.status}, ${sends} send(s)`);
    rc = null;
    const N4 = await fresh3(e3, 'Signed ahead, no receipt');
    await attempt(() => fundAs(e3, N4, wallet3));
    clock += 31 * 60_000;
    e3.sync(); await sleep(60);
    const n4 = e3.store.getCampaign(N4.id);
    clock -= 31 * 60_000;
    ok('C10.N ...a hash on record with no receipt after 30 min stays funding_pending for a person (never re-sent, never reverted to draft)',
      n4.status === 'funding_pending' && /no receipt/.test(n4.funding?.needsPerson || '') && sends === 2, n4.funding?.needsPerson);
    e3.stop();
  }
  {
    // The REAL viemChainAdapter on viem's Tempo chain with a local key, against
    // a node stand-in (custom transport): no network, no funds.
    const { createWalletClient, custom, keccak256 } = await import('viem');
    const { tempo } = await import('viem/chains');
    const { viemChainAdapter } = await import('./settlement.js');
    const d = dir3();
    let door3 = null, raw = null, rowAtSend = null;
    const node = custom({ async request({ method, params }) {
      switch (method) {
        case 'eth_chainId': return `0x${tempo.id.toString(16)}`;
        case 'eth_getTransactionCount': return '0x7';
        case 'eth_estimateGas': return '0x30000';
        case 'eth_maxPriorityFeePerGas': return '0x0';
        case 'eth_gasPrice': return '0x3b9aca00';
        case 'eth_getBlockByNumber': return { number: '0x10', baseFeePerGas: '0x3b9aca00', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, hash: `0x${'11'.repeat(32)}`, transactions: [] };
        case 'eth_sendRawTransaction': raw = params[0]; rowAtSend = door3.all().find((x) => x.kind === 'pull')?.status || null; throw new Error('HTTP request failed: timeout');
        default: throw new Error(`stand-in does not answer ${method}`);
      }
    } });
    const wc = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: tempo, transport: node });
    door3 = doorAt(d, viemChainAdapter({ campaignPull: wc }));
    const ref = 'campaign:fund:cmp_adapter:1';
    const r = await attempt(() => door3.pull({ from: wallet3, to: PLATFORM, token: USDC, amountAtomic: '12000000', ref, signer: 'campaignPull' }));
    const rec = door3.status(ref);
    ok('C10.N THE REAL viemChainAdapter (Tempo chain, local key, node stand-in): PULL_SENT is on the ledger when the raw transaction reaches the node, its hash = keccak256 of the raw tx the node got, and a send that times out leaves it on record',
      rowAtSend === 'PULL_SENT' && !!raw && rec?.status === 'PULL_SENT' && rec.txHash === keccak256(raw) && !!r.error && !r.error.preSend,
      `${rowAtSend}; ${rec?.txHash?.slice(0, 12)} vs ${raw ? keccak256(raw).slice(0, 12) : 'no raw tx'}`);
    const seatAhead = await viemChainAdapter({ pull: wc }).prepareTransferFrom({ signer: 'pull', token: USDC, from: wallet3, to: PLATFORM, amountAtomic: 1n });
    ok('C10.N ...only the campaign spender signs ahead (SIGN_AHEAD_SLOTS); the live seat-tick pull keeps writeContract', seatAhead === null);
  }

  // ── #2: stuck funding decided from chain facts, never the allowance
  {
    const d = dir3();
    const ch = mockChain();
    const e3 = makeEngine(d, doorAt(d, ch));
    const O1 = await fresh3(e3, 'Landed then re-approved');
    const at = clock;
    // The process stopped after broadcasting: the transfer is on chain, no PULL row.
    e3.store.putCampaign({ ...O1, status: 'funding_pending', fundingAttempts: 1, funding: { state: 'pulling', wallet: wallet3, ref: `campaign:fund:${O1.id}:1`, token: USDC, atomic: O1.budget.atomic, txHash: null, receipt: null, at: new Date(at).toISOString() } });
    TRANSFERS.push({ token: USDC.address, from: wallet3, to: PLATFORM, atomic: O1.budget.atomic, atMs: at + 2000, txHash: `0x${'0a'.repeat(32)}` });
    allowance = BigInt(O1.budget.atomic);   // and the creator approved the whole budget AGAIN
    clock += 31 * 60_000;
    e3.sync(); await sleep(60);
    const o1 = e3.store.getCampaign(O1.id);
    const again = await attempt(() => fundAs(e3, O1, wallet3));
    ok('C10.O #2 STUCK FUNDING FROM CHAIN FACTS: the pull LANDED and the creator re-approved the whole budget — the sweep keeps it for a person, never "never landed"; a second fund is refused',
      o1.status === 'funding_pending' && /may have landed/.test(o1.funding?.needsPerson || '') && code(again) === 'funding_in_progress' && ch.pulls.length === 0, `${o1.status}: ${o1.funding?.needsPerson}`);
    const eBlind = makeEngine(d, doorAt(d, ch), { findFundingTransfer: null });
    const O2 = await fresh3(eBlind, 'Stuck, no log reader');
    eBlind.store.putCampaign({ ...O2, status: 'funding_pending', fundingAttempts: 1, funding: { state: 'pulling', wallet: wallet3, ref: `campaign:fund:${O2.id}:1`, token: USDC, atomic: O2.budget.atomic, txHash: null, receipt: null, at: new Date(clock - 31 * 60_000).toISOString() } });
    eBlind.sync(); await sleep(60);
    const o2 = eBlind.store.getCampaign(O2.id);
    ok('C10.O ...a server that cannot search the token\'s transfers never reverts a stuck funding to draft, whatever the allowance says',
      o2.status === 'funding_pending' && /cannot search/.test(o2.funding?.needsPerson || ''), o2.funding?.needsPerson);
    TRANSFERS.length = 0;
    clock -= 31 * 60_000;
    allowance = 10n ** 30n;
    e3.stop(); eBlind.stop();
  }

  // ── #3: a field X leaves out is known-missing, not a reason to pay again
  {
    const d = dir3();
    const e3 = makeEngine(d, doorAt(d, mockChain()));
    const P1 = await fresh3(e3, 'X refresh bound', { rules: { minFollowers: 10 } });
    await fundAs(e3, P1, wallet3); e3.open(P1.id, as(creator));
    mockX.bearer = true;
    const byId0 = mockX.fetchUserById;
    const { parody: _parody, ...noParody } = BASE;
    mockX.fetchUserById = async ({ userId }) => { xcalls.byId++; return { ok: true, records: recs(noParody), costUsd: 0.01, user: { id: String(userId), username: `u${userId}` } }; };
    const omitted = mkX('noparody', '3401', noParody);   // linked when X left `parody` out
    const b0 = xcalls.byId;
    let last = null;
    for (let i = 0; i < 20; i++) last = await e3.check(P1.slug, as(omitted));
    const reads1 = xcalls.byId - b0;
    ok('C10.P #3 X LEAVES A FIELD OUT: 20 checks by one account whose fresh X read lacks `parody` make NO paid refresh, and fail closed with a reason',
      reads1 === 0 && !last.result.eligible && /could not read/.test(last.result.checks.find((x) => x.rule === 'notParodyOrProtected')?.detail || ''), `${reads1} paid read(s)`);
    const never = accounts.upsertAccountForLink({ provider: 'x', platformId: '3402', username: 'neverread', attributes: [] });
    const b1 = xcalls.byId;
    let lastNever = null;
    for (let i = 0; i < 20; i++) lastNever = await e3.check(P1.slug, as(never));
    const reads2 = xcalls.byId - b1;
    const storedParody = (accounts.getAccount(never.id).links.find((l) => l.provider === 'x').attributes || []).find((x) => x.attribute === 'parody');
    ok('C10.P ...a link never read by the platform: ONE paid read, which stores the field X left out as null (known missing, still failing CLOSED); 20 checks, no second read',
      reads2 === 1 && !!storedParody && storedParody.value === null && storedParody.source === 'x-api'
      && !lastNever.result.eligible && /could not read/.test(lastNever.result.checks.find((x) => x.rule === 'notParodyOrProtected')?.detail || ''),
      `${reads2} read(s); parody stored as ${JSON.stringify(storedParody?.value)}; eligible ${lastNever.result.eligible}`);
    mockX.fetchUserById = byId0; mockX.bearer = false;
    const { checkAllowed, CHECK_PER_MIN, CHECK_PER_MIN_ALL } = await import('./campaign-routes.js');
    const t0 = Date.now(), key = `gate-check-${randomBytes(4).toString('hex')}`;
    const hits = Array.from({ length: 7 }, (_, i) => checkAllowed(key, 'one-offer', t0 + i));
    const otherOffer = checkAllowed(key, 'another-offer', t0 + 8);
    const key2 = `${key}-b`;
    const spread = Array.from({ length: CHECK_PER_MIN_ALL + 1 }, (_, i) => checkAllowed(key2, `offer-${i}`, t0 + i));
    ok(`C10.P ...and /check is rate-limited per account: ${CHECK_PER_MIN} a minute on one campaign (another campaign still answers), ${CHECK_PER_MIN_ALL} across all; allowed again a minute on (D2b checks the route)`,
      CHECK_PER_MIN === 6 && hits.slice(0, 6).every(Boolean) && !hits[6] && otherOffer && spread.slice(0, CHECK_PER_MIN_ALL).every(Boolean) && !spread[CHECK_PER_MIN_ALL] && checkAllowed(key, 'one-offer', t0 + 61_000));
    e3.stop();
  }

  // ── #4: reuse is checked against the unbounded ledger, not the last 10 failures
  {
    const d = dir3();
    let rq = { status: 'reverted' };
    const doorQ = doorAt(d, mockChain());
    const e3 = makeEngine(d, doorQ, { confirmTx: async (h) => receiptFor(doorQ, h, rq ? rq.status : null) });
    const Q1 = await fresh3(e3, 'Replay after ten');
    const apQ = approvalFor(Q1, wallet3);
    const first = await fundProof(Q1, wallet3);
    const codes = [code(await attempt(() => e3.fund(Q1.id, { wallet: wallet3, approveTx: apQ, ...first }, as(creator))))];
    for (let i = 0; i < 10; i++) codes.push(code(await attempt(async () => e3.fund(Q1.id, { wallet: wallet3, approveTx: apQ, ...(await fundProof(Q1, wallet3)) }, as(creator)))));
    const fails = e3.store.getCampaign(Q1.id).fundingFailures || [];
    const rolled = fails.length === 10 && fails[0].ref.endsWith(':2');
    rq = { status: 'success' };
    const Q2 = await fresh3(e3, 'Approve from ten ago');
    const reuse = await attempt(async () => e3.fund(Q2.id, { wallet: wallet3, approveTx: apQ, ...(await fundProof(Q2, wallet3)) }, as(creator)));
    const replay = await attempt(() => e3.fund(Q1.id, { wallet: wallet3, approveTx: apQ, ...first }, as(creator)));
    ok('C10.Q #4 REPLAY AFTER TEN FAILURES: the first signed Fund message, rolled off fundingFailures by 10 later reverted pulls, is still refused (signature_reused)',
      codes.length === 11 && codes.every((x) => x === 'pull_reverted') && rolled && code(replay) === 'signature_reused', `${codes.filter((x) => x === 'pull_reverted').length} reverted, rolled off: ${rolled}, replay ${code(replay)}`);
    const retry = await attempt(async () => e3.fund(Q1.id, { wallet: wallet3, approveTx: apQ, ...(await fundProof(Q1, wallet3)) }, as(creator)));
    ok('C10.Q ...and the approve those attempts cited cannot fund ANOTHER campaign (approve_reused), while a fresh signature on the same campaign funds',
      code(reuse) === 'approve_reused' && code(retry) === 'ok' && retry.value.status === 'funded', `${code(reuse)} / ${code(retry)}`);
    e3.stop();
  }

  // ── #5: a live campaign's deadline is bounded
  {
    const d = dir3();
    const e3 = makeEngine(d, doorAt(d, mockChain()));
    const D0 = clock + 2 * 86_400_000;
    const R1 = await fresh3(e3, 'Deadline bounds', { deadline: new Date(D0).toISOString() });
    await fundAs(e3, R1, wallet3); e3.open(R1.id, as(creator));
    const far = await attempt(() => e3.updateCampaign(R1.id, { deadline: '2099-01-01T00:00:00Z' }, as(creator)));
    const over = await attempt(() => e3.updateCampaign(R1.id, { deadline: new Date(clock + 91 * 86_400_000).toISOString() }, as(creator)));
    const fineAt = new Date(clock + 60 * 86_400_000).toISOString();
    const fine = await attempt(() => e3.updateCampaign(R1.id, { deadline: fineAt }, as(creator)));
    ok('C10.R #5 A LIVE campaign\'s deadline cannot move to 2099, or past 90 days from now; a later deadline inside the bounds is accepted',
      code(far) === 'invalid' && code(over) === 'invalid' && code(fine) === 'ok' && e3.store.getCampaign(R1.id).deadline === fineAt, `${code(far)} ${code(over)} ${code(fine)}`);
    clock += 50 * 86_400_000;      // 50 days on: still live, its deadline 10 days away
    const past = await attempt(() => e3.updateCampaign(R1.id, { deadline: new Date(D0 + 91 * 86_400_000).toISOString() }, as(creator)));
    const within = await attempt(() => e3.updateCampaign(R1.id, { deadline: new Date(D0 + 89 * 86_400_000).toISOString() }, as(creator)));
    clock -= 50 * 86_400_000;
    ok('C10.R ...nor past 90 days beyond the deadline it OPENED with, even when that is inside 90 days from now',
      code(past) === 'invalid' && /opened with/.test(past.error?.message || '') && code(within) === 'ok', `${code(past)} ${code(within)}`);
    e3.stop();
  }

  // ── #6: the campaign spender is no other signer (the boot wiring is D8)
  {
    const { spenderCollisions } = await import('./campaign-engine.js');
    const sp = W(0x5a);
    const names = ['SELLER_WALLET_ADDRESS', 'SELLER_PRIVATE_KEY', 'PLATFORM_SETTLEMENT_KEY', 'REWARD_POOL_PRIVATE_KEY', 'ESCROW_OPERATOR_KEY', 'ESCROW_ATTEST_KEY'];
    const distinct = Object.fromEntries(names.map((n, i) => [n, W(0x60 + i)]));
    const each = names.map((n) => spenderCollisions(sp, { ...distinct, [n]: `0x${sp.slice(2).toUpperCase()}` }));
    ok('C10.S #6 the campaign spender collides with ANY other configured signer (seller, payout, reward pool, escrow operator, attester), by address, named not shown',
      each.every((c, i) => c.length === 1 && c[0] === names[i]) && spenderCollisions(sp, distinct).length === 0 && spenderCollisions(sp, { ESCROW_ATTEST_KEY: null }).length === 0,
      each.map((c) => c.join('+') || '-').join(' '));
  }

  // ── #7: a seat's CITED approve must be readable, mined and the payer's (N16)
  {
    const { citedApproveProblem } = await import('./token-utils.js');
    const payer = W(0x7a), other = W(0x7b);
    const good = `0x${'7a'.repeat(32)}`, unmined = `0x${'00'.repeat(31)}01`, reverted = `0x${'7c'.repeat(32)}`, theirs = `0x${'7d'.repeat(32)}`;
    const mined = { [good]: { status: 'success', from: payer }, [reverted]: { status: 'reverted', from: payer }, [theirs]: { status: 'success', from: other } };
    const readReceipt = async (h) => { if (!mined[h]) throw new Error('Timed out while waiting for transaction'); return mined[h]; };
    const v = (txHash) => citedApproveProblem({ txHash, payer, readReceipt });
    const got = [await v('not-a-hash'), await v(unmined), await v(reverted), await v(theirs), await v(good), await v(null), await v('')];
    ok('C10.T #7 N16 SEAT APPROVE: a cited junk hash, an unmined one, a reverted one or another wallet\'s is REFUSED (no "allowance is authoritative" fallback); the payer\'s mined approve passes; none cited is left to the allowance',
      JSON.stringify(got) === JSON.stringify(['approve_tx_invalid', 'approve_tx_unreadable', 'tx_not_success', 'approve_not_from_payer', null, null, null]), JSON.stringify(got));
  }
  clock = clock0; allowance = allowance0;
}

// ── C10.U round 4 (the cold review's break-4.mjs, reproduced against the real door) ──
// A NONCE-AWARE chain, ported from break-4.mjs: balances and allowances per
// wallet, ONE nonce stream for the campaign spender, a mempool, blocks that
// include one transaction per nonce, Transfer logs in every receipt, and
// viem 2.54's waitForTransactionReceipt replacement semantics (a hash whose
// nonce another transaction from the same sender used resolves with THAT
// transaction's receipt unless checkReplacement is false). `split`: the
// prepares reach nodes that have not seen each other's pending transaction
// (a load-balanced RPC), so the pending count does not include our own.
console.log('\n── C10.U round 4: nonces, replacement receipts, Transfer logs, off-air Call in, door x-cost ─');
function nonceChain({ split = false, rejectSameNonce = false, producerPicks = 'last', fotBps = 0, fot = null, honourFloor = true } = {}) {
  let s = 0;
  const lc = (a) => String(a).toLowerCase();
  const hex = () => `0x${randomBytes(32).toString('hex')}`;
  const c = {
    bal: new Map(), allow: new Map(), pulls: [], transfers: [], signed: [],
    nonce: 0, seen: new Map(), pool: [], mined: new Map(), byNonce: new Map(), receipts: new Map(),
    has: (x) => ['pull', 'platform', 'campaignPull'].includes(x),
    async prepareTransferFrom({ token, from, to, amountAtomic, minNonce = null }) {
      const a = c.allow.get(lc(from)) || 0n; const b = c.bal.get(lc(from)) || 0n;
      if (a < BigInt(amountAtomic) || b < BigInt(amountAtomic)) { const e = new Error('execution reverted'); e.name = 'EstimateGasExecutionError'; throw e; }
      const pending = split ? c.nonce : c.nonce + c.pool.length;     // eth_getTransactionCount 'pending' on the node this call hit
      await sleep(20);                                                // RPC latency: a concurrent prepare runs here
      // viemChainAdapter: max(pending, the door's floor) when the door passes one
      const nonce = honourFloor && minNonce != null ? Math.max(pending, Number(minNonce)) : pending;
      const txHash = hex();
      const tx = { hash: txHash, nonce, token, payer: from, to, amountAtomic: BigInt(amountAtomic) };
      c.signed.push(tx);
      return { txHash, nonce, send: async () => {
        if (rejectSameNonce && c.pool.some((p) => p.nonce === nonce)) throw new Error('replacement transaction underpriced');
        c.seen.set(txHash, tx); c.pool.push(tx); return txHash;
      } };
    },
    mine() {
      const nonces = [...new Set(c.pool.map((p) => p.nonce))].sort((x, y) => x - y);
      for (const n of nonces) {
        if (n < c.nonce) continue;                                   // nonce already used on chain: dropped, never mined
        if (n > c.nonce) break;                                      // a gap: waits
        const cands = c.pool.filter((p) => p.nonce === n);
        const tx = producerPicks === 'last' ? cands[cands.length - 1] : cands[0];
        const a = c.allow.get(lc(tx.payer)) || 0n; const b = c.bal.get(lc(tx.payer)) || 0n;
        let status = 'reverted'; const logs = [];
        if (a >= tx.amountAtomic && b >= tx.amountAtomic) {
          status = 'success';
          const keep = fot && lc(tx.token.address) === lc(fot) ? BigInt(fotBps) : 0n;
          const got = tx.amountAtomic * (10_000n - keep) / 10_000n;
          c.allow.set(lc(tx.payer), a - tx.amountAtomic);
          c.bal.set(lc(tx.payer), b - tx.amountAtomic);
          c.bal.set(lc(tx.to), (c.bal.get(lc(tx.to)) || 0n) + got);
          logs.push(transferLog({ token: tx.token.address, from: tx.payer, to: tx.to, value: got }));
          if (got < tx.amountAtomic) logs.push(transferLog({ token: tx.token.address, from: tx.payer, to: '0x000000000000000000000000000000000000fee0', value: tx.amountAtomic - got }));
          c.pulls.push({ from: tx.payer, to: tx.to, amountAtomic: String(tx.amountAtomic), received: String(got), hash: tx.hash, nonce: n });
        }
        c.mined.set(tx.hash, { status, nonce: n }); c.byNonce.set(n, tx.hash);
        c.receipts.set(tx.hash, { status, transactionHash: tx.hash, logs });
        c.nonce = n + 1;
      }
      c.pool = c.pool.filter((p) => p.nonce >= c.nonce);
    },
    /** viem 2.54 waitForTransactionReceipt over this chain: throws on timeout like viem does. */
    client: {
      calls: [],
      async waitForTransactionReceipt({ hash, checkReplacement = true }) {
        c.client.calls.push({ hash, checkReplacement });
        await sleep(60);                                               // the next block: every send made in this interval is in it
        c.mine();
        if (c.receipts.has(hash)) return c.receipts.get(hash);
        const seenTx = c.seen.get(hash);
        if (checkReplacement && seenTx && c.byNonce.has(seenTx.nonce)) return { ...c.receipts.get(c.byNonce.get(seenTx.nonce)), replaced: hash };
        const e = new Error('Timed out while waiting for transaction'); e.name = 'WaitForTransactionReceiptTimeoutError'; throw e;
      },
    },
    minedNonce: async () => c.nonce,
    knows: async (h) => c.seen.has(h) && (c.pool.some((p) => p.hash === h) || c.mined.has(h)),
    async transferFrom() { throw new Error('not used: campaignPull signs ahead'); },
    async transfer({ token, to, amountAtomic }) {
      c.transfers.push({ token: token.symbol, to, amountAtomic: String(amountAtomic) });
      return `0x${(++s).toString(16).padStart(64, 'b')}`;
    },
    async receipt() { return { status: 'success' }; },
  };
  return c;
}
{
  const { receiptConfirmer } = await import('./campaign-engine.js');
  const clock0 = clock;
  const RU = mkdtempSync(path.join(tmpdir(), 'mc-campaigns-r4-'));
  let nU = 0;
  const dirU = () => path.join(RU, String(++nU));
  // An engine over a nonce chain, wired the way server.js wires the real one:
  // confirmTx = receiptConfirmer(publicClient), readSpenderNonce, txKnown,
  // and the token's Transfer logs for findFundingTransfer.
  const chainEngine = (ch, over = {}) => {
    const d = dirU();
    const doorU = createSettlement({ dataDir: d, chain: ch, platformAddress: PLATFORM, log: quiet });
    const e = makeEngine(d, doorU, {
      readAllowance: async (t, o) => ch.allow.get(String(o).toLowerCase()) || 0n,
      confirmTx: receiptConfirmer(ch.client),
      readSpenderNonce: ch.minedNonce, txKnown: ch.knows,
      findFundingTransfer: async ({ from, to, atomic }) => ({ found: ch.pulls.some((p) => sameA(p.from, from) && sameA(p.to, to) && p.received === String(atomic)) }),
      ...over,
    });
    return { e, door: doorU, d };
  };
  const fundOn = async (u, c, wallet) => {
    u.ch.allow.set(wallet.toLowerCase(), BigInt(c.budget.atomic));
    return fundAs(u.e, c, wallet);
  };
  const pullSentRows = (doorU) => doorU._ledger.all().filter((r) => r.type === 'PULL_SENT');

  // ── B1: two concurrent funds on ONE campaign spender, through a split RPC
  {
    const ch = nonceChain({ split: true, producerPicks: 'last' });
    const u = { ch, ...chainEngine(ch) };
    const wA = W(0xa401), wB = W(0xa402);
    ch.bal.set(wA, 10_000_000_000n); ch.bal.set(wB, 5_000_000n);
    const A1 = await u.e.createCampaign(holler({ title: 'Nonce A', budget: { amount: '10000' } }), as(creator));
    const B1 = await u.e.createCampaign(holler({ title: 'Nonce B', budget: { amount: '5' } }), as(creator));
    const [ra, rb] = await Promise.all([attempt(() => fundOn(u, A1, wA)), attempt(() => fundOn(u, B1, wB))]);
    const sA = u.e.store.getCampaign(A1.id), sB = u.e.store.getCampaign(B1.id);
    const nonces = pullSentRows(u.door).map((r) => r.nonce);
    const fromA = ch.pulls.filter((p) => sameA(p.from, wA)), fromB = ch.pulls.filter((p) => sameA(p.from, wB));
    ok('C10.U B1 TWO CONCURRENT FUNDS ON ONE SPENDER (split RPC): both pulls land with DISTINCT nonces, two transfers on chain, both campaigns funded with what each pulled',
      code(ra) === 'ok' && code(rb) === 'ok' && sA.status === 'funded' && sB.status === 'funded' && nonces.length === 2 && new Set(nonces).size === 2
        && fromA.length === 1 && fromA[0].received === '10000000000' && fromB.length === 1 && fromB[0].received === '5000000' && ch.bal.get(PLATFORM) === 10_005_000_000n,
      `A ${code(ra)}/${sA.status}, B ${code(rb)}/${sB.status}; nonces ${JSON.stringify(nonces)}; pulls A ${fromA.length} B ${fromB.length}; platform ${ch.bal.get(PLATFORM)}`);
    ok('C10.U ...the receipt was asked for with viem\'s replacement check OFF, every time',
      ch.client.calls.length >= 2 && ch.client.calls.every((x) => x.checkReplacement === false), JSON.stringify(ch.client.calls.map((x) => x.checkReplacement)));
  }

  // ── B1 (receipt layer): a REPLACEMENT receipt is refused
  {
    // receiptConfirmer itself, against a client that answers like viem with
    // the replacement check on: the receipt is another hash's.
    const asked = [];
    const other = `0x${'0e'.repeat(32)}`, mine = `0x${'0f'.repeat(32)}`;
    const foreignClient = { async waitForTransactionReceipt(a) { asked.push(a); return { status: 'success', transactionHash: other, logs: [] }; } };
    const r1 = await receiptConfirmer(foreignClient)(mine);
    ok('C10.U B1 receiptConfirmer asks with checkReplacement:false and refuses a receipt whose transactionHash is not the hash asked about (null: no receipt)',
      r1 === null && asked.length === 1 && asked[0].checkReplacement === false && asked[0].hash === mine, JSON.stringify({ r1, cr: asked[0]?.checkReplacement }));
    // The engine, handed a replacement receipt anyway (an adapter that did not
    // check): the funding Transfer in it is real, but it is another tx's.
    const d = dirU();
    const doorF = createSettlement({ dataDir: d, chain: mockChain(), platformAddress: PLATFORM, log: quiet });
    const replacing = `0x${'1e'.repeat(32)}`;
    const eF = makeEngine(d, doorF, { confirmTx: async (h) => { const real = receiptFor(doorF, h); return { ...real, transactionHash: replacing }; } });
    const F1 = await eF.createCampaign(holler({ title: 'Replacement receipt' }), as(creator));
    allowance = 12_000_000n;
    const rf = await attempt(() => fundAs(eF, F1, W(0xa403)));
    const f1 = eF.store.getCampaign(F1.id);
    ok('C10.U B1 a receipt for ANOTHER hash (viem\'s replacement answer) never funds a campaign: it stays funding_pending, the foreign receipt on its ledger',
      code(rf) === 'ok' && f1.status === 'funding_pending' && eF.totals(F1.id).funded === 0n && eF.store.ledger().some((x) => x.kind === 'funding-receipt-foreign' && x.campaignId === F1.id && x.receiptHash === replacing),
      `${code(rf)} → ${f1.status}`);
    eF.stop();
  }

  // ── (1c) a success receipt with no matching Transfer log is refused
  {
    const d = dirU();
    const doorL = createSettlement({ dataDir: d, chain: mockChain(), platformAddress: PLATFORM, log: quiet });
    let shape = 'none';
    const eL = makeEngine(d, doorL, { confirmTx: async (h) => {
      const real = receiptFor(doorL, h);
      const row = doorL.status(doorL.all().find((x) => x.txHash === h)?.ref)?.rows.find((x) => x.type === 'PULL');
      if (shape === 'none') return { ...real, logs: [] };
      if (shape === 'other-wallet') return { ...real, logs: [transferLog({ token: USDC.address, from: W(0xa499), to: PLATFORM, value: row.amountAtomic })] };
      if (shape === 'other-token') return { ...real, logs: [transferLog({ token: GT, from: row.from, to: PLATFORM, value: row.amountAtomic })] };
      if (shape === 'other-payee') return { ...real, logs: [transferLog({ token: USDC.address, from: row.from, to: W(0xa498), value: row.amountAtomic })] };
      return real;
    } });
    allowance = 12_000_000n;
    const out = {};
    for (const s of ['none', 'other-wallet', 'other-token', 'other-payee']) {
      shape = s;
      const L = await eL.createCampaign(holler({ title: `No transfer ${s}` }), as(creator));
      const rl = await attempt(() => fundAs(eL, L, W(0xa404)));
      const st = eL.store.getCampaign(L.id);
      out[s] = `${code(rl)}/${st.status}/${st.funding?.state}`;
      out[`${s}-ok`] = code(rl) === 'funding_unproven' && st.status === 'funding_pending' && eL.totals(L.id).funded === 0n && /no USDC Transfer/.test(st.funding?.needsPerson || '');
    }
    ok('C10.U (1c) A SUCCESS RECEIPT IS NOT ENOUGH: no Transfer log, one from another wallet, in another token, or to another payee → not funded, funding_pending for a person (funding_unproven)',
      ['none', 'other-wallet', 'other-token', 'other-payee'].every((s) => out[`${s}-ok`]), JSON.stringify(Object.fromEntries(Object.entries(out).filter(([k2]) => !k2.endsWith('-ok')))));
    eL.stop();
  }

  // ── B4: a fee-on-transfer token delivers less than the budget
  {
    const FOT = '0x00000000000000000000000000000000000f0f0f';
    const feeTokens0 = process.env.CAMPAIGN_FEE_TOKENS;
    process.env.CAMPAIGN_FEE_TOKENS = FOT;
    const ch = nonceChain({ fot: FOT, fotBps: 1000 });     // the token keeps 10%
    const u = { ch, ...chainEngine(ch, { readTokenMeta: async (a) => (sameA(a, FOT) ? { decimals: 6, symbol: 'FOT' } : { decimals: 6, symbol: 'USDC' }) }) };
    const wF = W(0xa405);
    ch.bal.set(wF, 1_000_000_000n);
    const F = await u.e.createCampaign(holler({ title: 'Fee on transfer', reward: { type: 'token', address: FOT, amount: '5' }, budget: { amount: '1000' } }), as(creator));
    const rf = await attempt(() => fundOn(u, F, wF));
    const st = u.e.store.getCampaign(F.id);
    const cl = await attempt(() => u.e.close(F.id, as(creator)));
    ok('C10.U B4 FEE-ON-TRANSFER: a pull that delivers 900 of a 1,000 budget is NOT funded: funding_pending for a person, received and shortfall on record, no refund intent',
      code(rf) === 'funding_short' && st.status === 'funding_pending' && st.funding.receivedAtomic === '900000000' && st.funding.shortfallAtomic === '100000000'
        && /short by 100/.test(st.funding.needsPerson || '') && u.e.totals(F.id).funded === 0n && !u.door.status(`campaign:refund:${F.id}`) && code(cl) === 'funding_in_progress'
        && u.e.store.ledger().some((x) => x.kind === 'funding-short' && x.campaignId === F.id && x.shortfallAtomic === '100000000'),
      `${code(rf)} → ${st.status}; received ${st.funding?.receivedAtomic}, short ${st.funding?.shortfallAtomic}; close ${code(cl)}`);
    if (feeTokens0 === undefined) delete process.env.CAMPAIGN_FEE_TOKENS; else process.env.CAMPAIGN_FEE_TOKENS = feeTokens0;
  }

  // ── B5: the node answers sendRawTransaction with ANOTHER (successful) hash
  {
    const ch = nonceChain();
    const u = { ch, ...chainEngine(ch) };
    const wN = W(0xa406);
    ch.bal.set(wN, 100_000_000n);
    const otherTx = `0x${'5a'.repeat(32)}`;
    ch.receipts.set(otherTx, { status: 'success', transactionHash: otherTx, logs: [transferLog({ token: USDC.address, from: wN, to: PLATFORM, value: 50_000_000n })] });
    const prep = ch.prepareTransferFrom;
    let signedHash = null;
    ch.prepareTransferFrom = async (a) => { const r = await prep(a); signedHash = r.txHash; return { ...r, send: async () => otherTx }; };   // "accepted", answers with a different hash, drops ours
    const N = await u.e.createCampaign(holler({ title: 'Foreign send hash', budget: { amount: '50' } }), as(creator));
    const rn = await attempt(() => fundOn(u, N, wN));
    const rec = u.door.status(N.funding?.ref || `campaign:fund:${N.id}:1`);
    const st = u.e.store.getCampaign(N.id);
    ok('C10.U B5 THE NODE\'S HASH IS NEVER THE RECORD: the PULL row keeps the hash we SIGNED (the node\'s answer beside it as nodeHash); the other tx\'s receipt funds nothing',
      rec?.txHash === signedHash && rec?.nodeHash === otherTx && st.funding?.txHash === signedHash && st.status === 'funding_pending' && u.e.totals(N.id).funded === 0n && ch.pulls.length === 0,
      `record ${rec?.txHash === signedHash ? 'signed hash' : rec?.txHash === otherTx ? 'THE NODE\'S HASH' : rec?.txHash}; ${code(rn)} → ${st.status}`);
  }

  // ── B1b: the same race across two processes (two doors, one spender): the
  //         node refuses the second send; the sweep resolves it from chain facts
  {
    const ch = nonceChain({ split: true, rejectSameNonce: true });
    const u1 = { ch, ...chainEngine(ch) }, u2 = { ch, ...chainEngine(ch) };
    const w1 = W(0xa407), w2 = W(0xa408);
    ch.bal.set(w1, 50_000_000n); ch.bal.set(w2, 50_000_000n);
    const C1 = await u1.e.createCampaign(holler({ title: 'Two doors one' }), as(creator));
    const C2 = await u2.e.createCampaign(holler({ title: 'Two doors two' }), as(creator));
    const [r1, r2] = await Promise.all([attempt(() => fundOn(u1, C1, w1)), attempt(() => fundOn(u2, C2, w2))]);
    const s1 = u1.e.store.getCampaign(C1.id), s2 = u2.e.store.getCampaign(C2.id);
    const loser = [[u1, s1, r1, w1], [u2, s2, r2, w2]].find(([, s]) => s.status === 'funding_pending');
    ok('C10.U B1b (two processes, one spender) the node refuses the second same-nonce send: one campaign funded, the other funding_pending with its signed nonce on record',
      !!loser && [s1.status, s2.status].includes('funded') && code(loser[2]) === 'pull_unconfirmed' && typeof pullSentRows(loser[0].door)[0]?.nonce === 'number',
      `${s1.status}/${code(r1)} ${s2.status}/${code(r2)}`);
    if (loser) {
      const [lu, ls, , lw] = loser;
      clock += 31 * 60_000;
      lu.e.sync(); await sleep(250);
      const after = lu.e.store.getCampaign(ls.id);
      clock -= 31 * 60_000;
      ok('C10.U B1b ...after 30 min the SWEEP returns it to draft: its nonce was used by another tx, no node knows its hash, no Transfer of its budget — and it can be funded again',
        after.status === 'draft' && !after.funding && /can no longer land/.test(after.fundingFailures?.at(-1)?.why || '') && !ch.pulls.some((p) => sameA(p.from, lw)),
        `${after.status}: ${after.fundingFailures?.at(-1)?.why || after.funding?.needsPerson}`);
      const again = await attempt(() => fundOn(lu, after, lw));
      ok('C10.U B1b ...and the re-fund pulls it once, funded', code(again) === 'ok' && again.value.status === 'funded' && ch.pulls.filter((p) => sameA(p.from, lw)).length === 1, code(again));
    }
  }
  {
    // The drop rule's every leg, on a pull whose send threw after PULL_SENT (nonce 5).
    const legs = { draft: {}, 'nonce not used': { mined: 5 }, 'a node knows it': { known: true }, 'a Transfer arrived': { found: true }, 'nonce unreadable': { mined: 'throw' }, 'no nonce on record': { nonce: null } };
    const got = {};
    for (const [name, leg] of Object.entries(legs)) {
      const d = dirU();
      const ch = mockChain();
      ch.prepareTransferFrom = async () => ({ txHash: `0x${randomBytes(32).toString('hex')}`, nonce: leg.nonce === null ? undefined : 5, send: async () => { throw new Error('replacement transaction underpriced'); } });
      const doorD = createSettlement({ dataDir: d, chain: ch, platformAddress: PLATFORM, log: quiet });
      const eD = makeEngine(d, doorD, {
        confirmTx: async () => null,
        readSpenderNonce: async () => { if (leg.mined === 'throw') throw new Error('rpc down'); return leg.mined ?? 6; },
        txKnown: async () => leg.known ?? false,
        findFundingTransfer: async () => ({ found: leg.found ?? false }),
      });
      allowance = 12_000_000n;
      const Dd = await eD.createCampaign(holler({ title: `Drop leg ${name}` }), as(creator));
      await attempt(() => fundAs(eD, Dd, W(0xa409)));
      clock += 31 * 60_000;
      const res = await attempt(() => eD.resolveStuckFunding(Dd.id, { isAdmin: true }));
      clock -= 31 * 60_000;
      got[name] = res.value?.status || code(res);
      eD.stop();
    }
    ok('C10.U B1b ...the ADMIN resolve uses the same rule, and every leg is required: only "nonce used + no node knows it + no Transfer" goes to draft',
      got.draft === 'draft' && Object.entries(got).filter(([k2]) => k2 !== 'draft').every(([, v]) => v === 'funding_pending'), JSON.stringify(got));
  }

  // ── B2: a Call in counts only while the room is ON AIR
  {
    const d = dirU();
    const doorC = createSettlement({ dataDir: d, chain: mockChain(), platformAddress: PLATFORM, log: quiet });
    const eC = makeEngine(d, doorC);
    const paysC = (cid) => doorC.intentsFor('campaign:pay:').filter((r) => (r.rows?.[0]?.meta || {}).campaignId === cid);
    allowance = 100_000_000n;
    rooms.gateair = { id: 'room-air', ownerKey: creator.id, transport: 'livekit' };
    const CA = await eC.createCampaign(holler({ title: 'Call in on air', action: { kind: 'callin', roomHandle: 'gateair', require: 'aired', minSeconds: 60 } }), as(creator));
    await fundAs(eC, CA, W(0xa40a)); eC.open(CA.id, as(creator));
    const CJ = await eC.createCampaign(holler({ title: 'Call in joined on air', action: { kind: 'callin', roomHandle: 'gateair', require: 'joined' } }), as(creator));
    await fundAs(eC, CJ, W(0xa40b)); eC.open(CJ.id, as(creator));
    OFF_AIR.add('room-air');
    const cam = mkX('camwall', '3501'); accounts.setAccountPayoutWallet(cam.id, W(0xa40c));
    await eC.check(CA.slug, as(cam)); await eC.check(CJ.slug, as(cam));
    const ka = eC.reserve({ slug: CA.slug, accountId: cam.id, kind: 'callin', roomId: 'room-air' });
    eC.bind(ka.claimId, { seatId: 'S-wall' });
    eC.onSeatEvent('S-wall', 'camera_on');
    clock += 61_000; eC.onSeatEvent('S-wall', 'camera_off');
    const kj = eC.reserve({ slug: CJ.slug, accountId: cam.id, kind: 'callin', roomId: 'room-air' });
    eC.bind(kj.claimId, { seatId: 'S-wall-j' }); eC.onSeatEvent('S-wall-j', 'camera_on');
    const a1 = eC.store.getClaim(ka.claimId), j1 = eC.store.getClaim(kj.claimId);
    ok('C10.U B2 OFF AIR: a camera on for 61 s with the room off air is never joined, aired or owed (require aired AND require joined), and the claim says why (offAir)',
      a1.status === 'recorded' && j1.status === 'recorded' && !paysC(CA.id).length && !paysC(CJ.id).length && eC.claimView(a1).offAir === true && eC.claimView(j1).offAir === true,
      `aired-claim ${a1.status}, joined-claim ${j1.status}, offAir ${eC.claimView(a1).offAir}/${eC.claimView(j1).offAir}`);
    // The camera stays up; the stream starts: the sweep starts the clock.
    eC.onSeatEvent('S-wall', 'camera_on');
    OFF_AIR.delete('room-air'); eC.sync();
    const a2 = eC.store.getClaim(ka.claimId), j2 = eC.store.getClaim(kj.claimId);
    clock += 30_000;
    OFF_AIR.add('room-air'); eC.sync();                 // 30 s on air, then the stream drops
    const a3 = eC.store.getClaim(ka.claimId);
    clock += 40_000;
    OFF_AIR.delete('room-air'); eC.sync();              // back on air: the clock starts from zero
    clock += 45_000; eC.onSeatEvent('S-wall', 'camera_off');
    const a4 = eC.store.getClaim(ka.claimId);
    ok('C10.U B2 ...the room going on air with the camera up starts the clock (joined → owed for require joined); 30 s on air + an off-air gap + 45 s on air is NOT 60 s',
      a2.status === 'joined' && ['owed', 'releasing'].includes(j2.status) && !a3.cameraOnAt && a4.status === 'joined' && !a4.cameraOnAt,
      `start ${a2.status}/${j2.status}; after the drop clock ${a3.cameraOnAt ? 'running' : 'stopped'}; after 45 s ${a4.status}`);
    const kb = eC.store.getClaim(ka.claimId);
    eC.onSeatEvent('S-wall', 'camera_on');
    clock += 61_000; eC.onSeatEvent('S-wall', 'camera_off');
    ok('C10.U B2 ...61 s continuously ON AIR → aired → owed → payout intent', ['owed', 'releasing'].includes(eC.store.getClaim(ka.claimId).status) && paysC(CA.id).length === 1, `${kb.status} → ${eC.store.getClaim(ka.claimId).status}`);
    OFF_AIR.delete('room-air');
    eC.stop();
  }

  // ── B3: the never-past-funded ceiling reads the DOOR's x-cost, not the record's
  {
    const d = dirU();
    const doorX = createSettlement({ dataDir: d, chain: mockChain(), platformAddress: PLATFORM, log: quiet });
    const eX = makeEngine(d, doorX);
    allowance = 10_000_000n;
    const X3 = await eX.createCampaign(holler({ title: 'Door x-cost', action: { kind: 'holler', roomHandle: 'gatestage', require: 'approved' }, budget: { amount: '10' }, maxClaims: 2 }), as(creator));
    await fundAs(eX, X3, W(0xa40d)); eX.open(X3.id, as(creator));
    // What settleX leaves if the process stops after its door write and before its campaign write.
    doorX.release({ signer: 'platform', to: PLATFORM, token: USDC, amountAtomic: '2000000', bucket: 'campaign-x-cost', ref: `campaign:xcost:set:${X3.id}:${randomBytes(8).toString('hex')}`, meta: { campaignId: X3.id, usd: 2 } });
    const ids = [];
    for (const n of [1, 2]) {
      const a = mkX(`xc${n}`, String(3600 + n)); accounts.setAccountPayoutWallet(a.id, W(0xa410 + n));
      await eX.check(X3.slug, as(a));
      const r3 = eX.reserve({ slug: X3.slug, accountId: a.id, kind: 'holler', roomId: 'room-holler' });
      eX.bind(r3.claimId, { letterId: `L-xc${n}` }); eX.onLetterEvent(`L-xc${n}`, 'approved'); ids.push(r3.claimId);
    }
    const rel = doorX.intentsFor('campaign:').filter((x) => x.rows[0].meta?.campaignId === X3.id && x.rows[0].kind === 'release').reduce((s, x) => s + BigInt(x.rows[0].amountAtomic), 0n);
    ok('C10.U B3 an x-cost on the DOOR that the campaign record missed still counts: door releases for the campaign never pass what was funded (2 x-cost + one 5 payout; the second waits)',
      rel === 7_000_000n && doorX.intentsFor('campaign:pay:').filter((r) => r.rows[0].meta?.campaignId === X3.id).length === 1 && eX.store.getClaim(ids[1]).status === 'owed', `door releases ${rel}; claims ${ids.map((i) => eX.store.getClaim(i).status).join('/')}`);
    eX.stop();
  }

  // ── (6) the overlay key is never derived from the public dev secret in production
  {
    const probe = "import('./overlay-key.js').then((m) => console.log(JSON.stringify({ k: m.overlayKeyFor('abc123'), match: m.overlayKeyMatches('abc123', 'x'.repeat(32)) })))";
    const envNo = { ...process.env }; delete envNo.AUTH_SECRET; delete envNo.MPP_SECRET_KEY;
    const prod = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: HERE, encoding: 'utf8', env: { ...envNo, NODE_ENV: 'production' } });
    const dev = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: HERE, encoding: 'utf8', env: { ...envNo, NODE_ENV: 'development' } });
    let p = null, dv = null;
    try { p = JSON.parse(prod.stdout.trim()); dv = JSON.parse(dev.stdout.trim()); } catch { /* */ }
    ok('C10.U (6) overlay-key.js in PRODUCTION with no AUTH_SECRET / MPP_SECRET_KEY derives NO key (null, nothing matches) and logs the variable NAME; in development the dev key still works',
      p?.k === null && p.match === false && /AUTH_SECRET/.test(prod.stderr || '') && /^[A-Za-z0-9_-]{32}$/.test(dv?.k || ''),
      `prod key ${p?.k === null ? 'null' : 'DERIVED'}, dev key ${dv?.k ? 'derived' : 'none'}`);
    const { unlockAllowed, UNLOCK_PER_MIN } = await import('./dashboard-routes.js');
    const t0 = Date.now(), room = `gate${randomBytes(4).toString('hex')}`;
    const perRoom = Array.from({ length: UNLOCK_PER_MIN + 1 }, (_, i) => unlockAllowed(`10.9.${i}.1`, room, t0 + i));
    const ip = `10.8.${randomBytes(1)[0]}.2`;
    const perIp = Array.from({ length: UNLOCK_PER_MIN + 1 }, (_, i) => unlockAllowed(ip, `${room}-${i}`, t0 + i));
    ok(`C10.U (6) /api/dashboard/unlock is rate-limited: ${UNLOCK_PER_MIN} a minute per room (across IPs) and per IP (across rooms), allowed again a minute on (D9 checks the route)`,
      UNLOCK_PER_MIN === 10 && perRoom.slice(0, 10).every(Boolean) && !perRoom[10] && perIp.slice(0, 10).every(Boolean) && !perIp[10] && unlockAllowed(`10.7.0.1`, room, t0 + 61_000));
  }
  clock = clock0;
}

eng.stop();
if (ENGINE_ONLY) {
  console.log(`
RESULT (engine only, A–C): ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

// ═══ D. HTTP ══════════════════════════════════════════════════════════════
console.log('\n── D. HTTP, through the real server ─────────────────────────');
const SD = mkdtempSync(path.join(tmpdir(), 'mc-campaigns-http-'));
process.env.DATA_DIR = SD;
accounts._resetAccountsForTests();
const { startGateServer, mintBountyAuth, assertFreshBuild } = await import('./_gate-helpers.mjs');
const { CAMPAIGN_ROUTES } = await import('./campaign-routes.js');
const auth = mintBountyAuth({ handles: ['twitch:siteboss', 'twitch:campowner', 'x:xalice', 'x:xbob'], dataDir: SD });
{
  const f = path.join(SD, 'accounts.json');
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const now = new Date().toISOString();
  for (const a of Object.values(j.accounts)) {
    if (a.handle === 'xalice') { a.links[0].attributes = recs(BASE, now); a.links[0].attributesFetchedAt = now; }
    if (a.handle === 'xbob') { a.links[0].attributes = recs({ ...BASE, followersCount: 300 }, now); a.links[0].attributesFetchedAt = now; }
  }
  writeFileSync(f, JSON.stringify(j, null, 2));
}
accounts._resetAccountsForTests();
const OWNER = auth.accountIdFor('twitch:campowner');
// Rooms and live campaigns are seeded by a CHILD process: rooms-store fixes
// its data dir when it is first imported, and section C already imported it
// for another directory. Campaigns are funded through the real door against a
// mock chain, exactly as the server's own door would record a pull.
const seedRun = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--seed-http', SD, OWNER], {
  cwd: HERE, encoding: 'utf8', env: { ...process.env, DATA_DIR: SD, CAMPAIGN_FUNDING: '1' },
});
let seeded = null;
try { seeded = JSON.parse((seedRun.stdout || '').trim().split(String.fromCharCode(10)).pop()); } catch { seeded = null; }
ok('D0. the HTTP data dir is seeded: three rooms (two on air) and eight funded, live campaigns', !!seeded?.P && !!seeded?.R && !!seeded?.R2 && !!seeded?.Q4 && !!seeded?.call, (seedRun.stderr || '').slice(-300));
const { stage, prod, call: callRoom, P, Q, R, R2, O, Q2, Q3, Q4 } = seeded || {};

const sellerKey = generatePrivateKey();   // fresh and empty: nothing it could sign has funds behind it
const campaignSpenderKey = generatePrivateKey();   // the dedicated campaign spender: fresh and empty too
// LiveKit for the server under test: an unreachable URL and a key pair minted
// here, so the only thing it can do is VERIFY webhooks this gate signs. A
// campaign Call in counts only from such a webhook (finding 4).
const LK = { key: 'gatelk', secret: randomBytes(24).toString('hex') };
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function lkWebhookRequest(event, { sign = true } = {}) {
  const body = JSON.stringify(event);
  const nowS = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const pl = b64u(JSON.stringify({ iss: LK.key, sha256: createHash('sha256').update(body).digest('base64'), iat: nowS, exp: nowS + 300 }));
  const sig = b64u(createHmac('sha256', LK.secret).update(`${h}.${pl}`).digest());
  return { body, headers: { 'Content-Type': 'application/webhook+json', ...(sign ? { Authorization: `Bearer ${h}.${pl}.${sig}` } : {}) } };
}
// GATE_CAMPAIGNS_PORT moves both boots (D and D8 = PORT + 1), so two runs of
// this gate (e.g. a mutation run on a copy of the tree) can overlap.
const PORT = Number(process.env.GATE_CAMPAIGNS_PORT) || 3351;
const APP = `http://localhost:${PORT}`;
let srv = null, ws = null, browser = null;
try {
  srv = await startGateServer({
    port: PORT, dataDir: SD, label: 'campaigns',
    env: {
      ...auth.env, SITE_ADMIN_TWITCH: 'siteboss', CAMPAIGN_FUNDING: '1', KEEP_ORPHAN_ROOMS: 'true',
      SELLER_PRIVATE_KEY: sellerKey, SELLER_WALLET_ADDRESS: privateKeyToAccount(sellerKey).address,
      CAMPAIGN_SPENDER_KEY: campaignSpenderKey,
      PLATFORM_SETTLEMENT_KEY: '', REWARD_POOL_PRIVATE_KEY: '', ESCROW_OPERATOR_KEY: '', ESCROW_ATTEST_KEY: '',
      X_BEARER_TOKEN: '', X_TOKEN_KEY: '', X_CLIENT_ID: '', X_CLIENT_SECRET: '', MODERATION_API_KEY: '',
      LETTER_HOLD_TTL_MS: '3600000',
      LIVEKIT_URL: 'ws://127.0.0.1:9', LIVEKIT_API_KEY: LK.key, LIVEKIT_API_SECRET: LK.secret,
    },
  });
  const call = async (method, p, { body, as, headers = {} } = {}) => {
    const r = await fetch(`${APP}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(as ? { Cookie: auth.cookieFor(as) } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  // D1 — the table, anonymously
  const fill = (p) => p.replace(':id', P.id).replace(':slug', P.slug).replace(':key', P.id).replace(':address', USDC.address);
  const nonPublic = CAMPAIGN_ROUTES.filter(([, , tier]) => tier !== 'PUBLIC');
  const anon = [];
  for (const [m, p] of nonPublic) { const x = await call(m, fill(p), { body: m === 'GET' ? undefined : {} }); if (x.status !== 401) anon.push(`${m} ${p} → ${x.status}`); }
  ok(`D1. every one of the ${nonPublic.length} non-public routes refuses an anonymous caller with 401`, anon.length === 0, anon.join(' | '));
  const byId = await call('GET', `/api/campaigns/${P.id}`);
  ok('D1. GET /api/campaigns/<id> (the creator view) refuses an anonymous caller', byId.status === 401);
  const admins = CAMPAIGN_ROUTES.filter(([, , tier]) => tier === 'ADMIN');
  const notAdmin = [];
  for (const [m, p] of admins) { const x = await call(m, fill(p).replace(':id', P.id), { as: 'twitch:campowner', body: m === 'GET' ? undefined : {} }); if (x.status !== 403) notAdmin.push(`${m} ${p} → ${x.status}`); }
  ok(`D1. the ${admins.length} admin routes refuse a signed-in non-admin with 403`, notAdmin.length === 0, notAdmin.join(' | '));
  const viaKey = await call('GET', '/api/campaigns/admin/all', { headers: { 'x-bounty-admin-key': auth.adminKey } });
  const viaOwner = await call('GET', '/api/campaigns/admin/all', { as: 'twitch:siteboss' });
  ok('D1. ...and admit the bounty admin key and the site owner\'s account', viaKey.status === 200 && viaOwner.status === 200 && viaKey.body.campaigns.length === 8);
  const other = await call('GET', `/api/campaigns/${P.id}/claims`, { as: 'x:xalice' });
  ok('D1. a signed-in account cannot read someone else\'s campaign claims', other.status === 403);

  // D2 — public offer + checks
  const pub = await call('GET', `/api/campaigns/${P.slug}`);
  ok('D2. the public offer: reward, room, budget left, rules in plain words', pub.status === 200 && pub.body.campaign.reward.amount === '5' && pub.body.campaign.action.roomHandle === 'gatestage' && pub.body.campaign.budget.left === '12' && pub.body.campaign.rules.length >= 2);
  const elig2 = await import('./campaign-eligibility.js');
  ok('D2. ...and none of its copy asks for an action on X', !elig2.copyViolation(JSON.stringify(pub.body.campaign)));
  ok('D2. checking needs a sign-in', (await call('POST', `/api/campaigns/${P.slug}/check`)).status === 401);
  const bobCheck = await call('POST', `/api/campaigns/${P.slug}/check`, { as: 'x:xbob' });
  ok('D2. xbob (300 followers) is told he does not qualify, and why', bobCheck.status === 200 && bobCheck.body.eligible === false && /300/.test(JSON.stringify(bobCheck.body.checks)));
  const aliceCheck = await call('POST', `/api/campaigns/${P.slug}/check`, { as: 'x:xalice' });
  ok('D2. xalice qualifies', aliceCheck.status === 200 && aliceCheck.body.eligible === true && aliceCheck.body.claim.status === 'eligible');
  {
    // Round 3 #3: the check route is rate-limited per account (a check can
    // cost the platform an X read). xbob already checked once above.
    const burst = [];
    for (let i = 0; i < 7; i++) burst.push(await call('POST', `/api/campaigns/${P.slug}/check`, { as: 'x:xbob' }));
    ok('D2b. /check is rate-limited per account over HTTP: 7 more in a row → at most 6 a minute answered, then 429 rate_limited',
      burst.filter((x) => x.status === 200).length <= 6 && burst.at(-1).status === 429 && burst.at(-1).body.reason === 'rate_limited', burst.map((x) => x.status).join(','));
  }

  // D3 — a Holler with ?campaign=
  const submit = (room, as, campaign) => call('POST', '/api/letter/submit', { as, body: { room, username: as ? as.split(':')[1] : 'anon', durationS: 2, mime: 'video/webm', campaign } });
  const anonSend = await submit(stage.id, null, P.slug);
  ok('D3. a campaign Holler from nobody signed in is refused', anonSend.status === 401, JSON.stringify(anonSend));
  const bobSend = await submit(stage.id, 'x:xbob', P.slug);
  ok('D3. INELIGIBLE CANNOT RECORD: xbob\'s campaign Holler is refused before anything is created', bobSend.status === 403 && bobSend.body.reason === 'ineligible');
  const wrong = await submit(prod.id, 'x:xalice', P.slug);
  ok('D3. a campaign Holler in another room is refused', wrong.status === 409 && wrong.body.reason === 'wrong_room');
  const sent = await submit(stage.id, 'x:xalice', P.slug);
  const up = sent.body.letterId ? await fetch(`${APP}/api/letter/upload/${sent.body.letterId}`, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: Buffer.alloc(4096, 7) }) : null;
  ok('D3. xalice\'s campaign Holler is accepted and uploaded', sent.status === 200 && up?.ok);
  let mine = await call('GET', `/api/campaigns/${P.slug}/my-claim`, { as: 'x:xalice' });
  ok('D3. auto-moderated room, require approved: it cleared moderation → owed, and the page asks for a wallet', mine.body.claim?.status === 'owed' && mine.body.claim.needsWallet === true, mine.body.claim?.status);
  const doorRows = () => { try { return readFileSync(path.join(SD, 'settlement.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  ok('D3. no payout intent exists before there is a wallet', !doorRows().some((x) => String(x.ref).startsWith('campaign:pay:')));
  await call('POST', '/api/account/payout-wallet', { as: 'x:xalice', body: { address: W(0xa11ce) } });
  await call('POST', '/api/account/payout-wallet', { as: 'x:xalice', body: { address: W(0xa11ce) } });
  const pays = doorRows().filter((x) => x.type === 'INTENT' && String(x.ref).startsWith('campaign:pay:'));
  ok('D3. the wallet arrives → ONE payout intent at the door, for the reward, signer platform, bucket campaign',
    pays.length === 1 && pays[0].amountAtomic === '5000000' && pays[0].signer === 'platform' && pays[0].meta?.bucket === 'campaign' && pays[0].to === W(0xa11ce));
  mine = await call('GET', `/api/campaigns/${P.slug}/my-claim`, { as: 'x:xalice' });
  ok('D3. with no payout key on this server it stays PENDING (recorded, not sent) and the claim reads releasing', mine.body.claim?.status === 'releasing' && mine.body.claim.payout?.door === 'PENDING');
  ok('D3. a second campaign Holler from the same account is refused', (await submit(stage.id, 'x:xalice', P.slug)).status === 403);

  // D4c — N14: the overlay key. The producer room is ON AIR, so only the key
  // stands between a self-declared overlay socket and an owed claim. These
  // run before D4 opens the keyed overlay, so no keyed socket is in the room.
  const roomView = await call('GET', `/api/dashboard/rooms/${prod.id}`, { as: 'twitch:campowner' });
  let overlayKey = null;
  try { overlayKey = new URL(roomView.body.overlayUrl).searchParams.get('k'); } catch { /* */ }
  const anonView = await call('GET', `/api/dashboard/rooms/${prod.id}`);
  ok('D4c. the owner\'s dashboard hands out the overlay URL with the room\'s key (&k=); an anonymous caller gets no URL',
    roomView.status === 200 && /^[A-Za-z0-9_-]{32}$/.test(overlayKey || '') && roomView.body.overlayUrl.includes(`/overlay?room=${prod.id}&k=`)
      && anonView.status >= 400 && !anonView.body.overlayUrl, `owner http ${roomView.status}, anon http ${anonView.status}`);
  const hop = await fetch(`${APP}/gateprod/overlay?k=${overlayKey}`, { redirect: 'manual' });
  ok('D4c. the pretty link /<handle>/overlay?k= keeps the key through its redirect', hop.status === 302 && hop.headers.get('location') === `/overlay?room=${prod.id}&k=${overlayKey}`, String(hop.headers.get('location')).replace(overlayKey, '<key>'));
  const overlaySocket = async (k) => {
    const s = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const plays = new Map();
    await new Promise((res, rej) => { s.on('open', res); s.on('error', rej); });
    s.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'letter_play') plays.set(m.letter.id, Date.now()); } catch { /* */ } });
    s.send(JSON.stringify({ type: 'subscribe_room', room: prod.id, role: 'overlay', ...(k !== undefined ? { k } : {}) }));
    await sleep(400);
    return { s, plays };
  };
  // One campaign Holler in the on-air producer room, approved and aired by the
  // owner while `sock` is the only overlay; `during` runs right after the play
  // starts. Returns every claim status seen until well past the clip's end.
  const airWith = async (camp, sock, during = async () => {}) => {
    await call('POST', `/api/campaigns/${camp.slug}/check`, { as: 'x:xalice' });
    const l = await submit(prod.id, 'x:xalice', camp.slug);
    await fetch(`${APP}/api/letter/upload/${l.body.letterId}`, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: Buffer.alloc(4096, 7) });
    await call('POST', `/api/dashboard/rooms/${prod.id}/letters/${l.body.letterId}/approve`, { as: 'twitch:campowner' });
    const aired = await call('POST', `/api/dashboard/rooms/${prod.id}/letters/${l.body.letterId}/play`, { as: 'twitch:campowner' });
    await during();
    const claimOf = async () => (await call('GET', `/api/campaigns/${camp.slug}/my-claim`, { as: 'x:xalice' })).body.claim?.status;
    const seen = [];
    for (let i = 0; i < 40; i++) {
      seen.push(await claimOf());
      const at = sock.plays.get(l.body.letterId);
      if (at && Date.now() - at > 7000) break;
      await sleep(500);
    }
    return { played: aired.status === 200 && sock.plays.has(l.body.letterId), seen, last: seen[seen.length - 1] };
  };
  const paidish = (seen) => seen.some((x) => ['owed', 'releasing', 'paid'].includes(x));
  {
    const before = (await call('GET', `/api/campaigns/${Q2.id}`, { as: 'twitch:campowner' })).body.campaign;
    ok('D4c. N14 overlay state NONE: no overlay connected to the room (OBS closed) → the creator view says overlay:"none" (not the old-link warning), overlayKeyed:false',
      before?.overlay === 'none' && before.overlayKeyed === false, `overlay=${before?.overlay} overlayKeyed=${before?.overlayKeyed}`);
    const fake = await overlaySocket(undefined);
    const r = await airWith(Q2, fake);
    const creatorView = (await call('GET', `/api/campaigns/${Q2.id}`, { as: 'twitch:campowner' })).body.campaign;
    try { fake.s.close(); } catch { /* */ }
    ok('D4c. N14 NO KEY: ON AIR, a clip played to the end on an overlay socket that sent no key never counts as aired (never owed)',
      r.played && !paidish(r.seen) && r.last === 'approved', `played=${r.played} status=${r.last}`);
    const k2 = (await call('GET', `/api/campaigns/${Q2.slug}/my-claim`, { as: 'x:xalice' })).body.claim;
    ok('D4c. N14 ...and it is not silent: the claim stays approved with playedUnauthed + the time, and the creator view says overlay:"unkeyed" (overlayKeyed:false) with the old link connected',
      k2?.status === 'approved' && k2.playedUnauthed === true && !!Date.parse(k2.playedUnauthedAt)
        && creatorView?.overlay === 'unkeyed' && creatorView.overlayKeyed === false && creatorView.overlayLink?.unkeyedConnected === true && creatorView.overlayLink.keyedConnected === false,
      `claim ${k2?.status} playedUnauthed=${k2?.playedUnauthed}; overlay=${creatorView?.overlay} overlayKeyed=${creatorView?.overlayKeyed} link=${JSON.stringify(creatorView?.overlayLink)}`);
  }
  {
    const wrong = await overlaySocket(`${(overlayKey || '').padEnd(32, 'x').slice(0, 31)}${(overlayKey || '').endsWith('A') ? 'B' : 'A'}`);
    const r = await airWith(Q3, wrong);
    try { wrong.s.close(); } catch { /* */ }
    ok('D4c. N14 WRONG KEY: ON AIR, a socket presenting a wrong key (one character off) never makes the claim owed',
      r.played && !paidish(r.seen) && r.last === 'approved', `played=${r.played} status=${r.last}`);
  }
  {
    // The keyed overlay connects only AFTER the clip went out: it never
    // received letter_play, so nothing rendered it on stream.
    const fake = await overlaySocket(undefined);
    let late = null;
    const r = await airWith(Q4, fake, async () => { late = await overlaySocket(overlayKey); });
    try { fake.s.close(); late?.s.close(); } catch { /* */ }
    ok('D4c. N14 TOO LATE: the keyed overlay connecting mid-play (after letter_play went out) does not make it count',
      r.played && !!late && !paidish(r.seen) && r.last === 'approved', `played=${r.played} status=${r.last}`);
  }
  await sleep(300);

  // D4 — approve mode, require aired, through a real overlay (the KEYED one)
  await call('POST', `/api/campaigns/${Q.slug}/check`, { as: 'x:xalice' });
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const played = [];
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'letter_play') played.push(m.letter.id); } catch { /* */ } });
  ws.send(JSON.stringify({ type: 'subscribe_room', room: prod.id, role: 'overlay', k: overlayKey }));
  await sleep(400);
  const q = await submit(prod.id, 'x:xalice', Q.slug);
  await fetch(`${APP}/api/letter/upload/${q.body.letterId}`, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: Buffer.alloc(4096, 7) });
  const qClaim = async () => (await call('GET', `/api/campaigns/${Q.slug}/my-claim`, { as: 'x:xalice' })).body.claim;
  ok('D4. approve-mode room: waiting for a person, the claim is recorded', (await qClaim())?.status === 'recorded');
  await call('POST', `/api/dashboard/rooms/${prod.id}/letters/${q.body.letterId}/approve`, { as: 'twitch:campowner' });
  ok('D4. approved, but this campaign requires aired: approved, no intent for it', (await qClaim())?.status === 'approved'
    && doorRows().filter((x) => x.type === 'INTENT' && String(x.ref).startsWith('campaign:pay:')).length === 1);
  await call('POST', `/api/dashboard/rooms/${prod.id}/letters/${q.body.letterId}/play`, { as: 'twitch:campowner' });
  let qs = null;
  for (let i = 0; i < 20; i++) { qs = (await qClaim())?.status; if (qs === 'releasing') break; await sleep(500); }
  ok('D4. played to the end on the KEYED overlay → owed → payout intent (wallet already set)', played.includes(q.body.letterId) && qs === 'releasing', `status=${qs}`);
  {
    const v = (await call('GET', `/api/campaigns/${Q.id}`, { as: 'twitch:campowner' })).body.campaign;
    const kq = await qClaim();
    ok('D4. ...with the keyed overlay connected the creator view says overlay:"keyed" (overlayKeyed:true), and the claim carries no playedUnauthed',
      v?.overlay === 'keyed' && v.overlayKeyed === true && v.overlayLink?.keyedConnected === true && kq?.playedUnauthed === false, `overlay=${v?.overlay} overlayKeyed=${v?.overlayKeyed} playedUnauthed=${kq?.playedUnauthed}`);
  }

  // D5 — a Call in with ?campaign= through the real join route
  await call('POST', `/api/campaigns/${R.slug}/check`, { as: 'x:xalice' });
  const anonJoin = await call('POST', '/api/join/mpp', { body: { room: 'gatecall', username: 'nobody', campaign: R.slug } });
  ok('D5. a campaign Call in from nobody signed in is refused', anonJoin.status === 401);
  const join = await call('POST', '/api/join/mpp', { as: 'x:xalice', body: { room: 'gatecall', username: 'xalice', campaign: R.slug } });
  ok('D5. xalice\'s campaign Call in gets a seat', join.status === 200 && !!join.body.seatId, `http ${join.status} ${join.body.error || ''}`);
  const rClaim = async () => (await call('GET', `/api/campaigns/${R.slug}/my-claim`, { as: 'x:xalice' })).body.claim;
  ok('D5. the seat is bound to her claim (recorded, not yet counted)', (await rClaim())?.status === 'recorded' && (await rClaim())?.seatId === join.body.seatId);
  ws.send(JSON.stringify({ type: 'camera_ready', seatId: join.body.seatId }));
  await sleep(1200);
  ok('D5. CLIENT SIGNAL IGNORED: the client’s camera_ready alone does not count (claim still recorded)', (await rClaim())?.status === 'recorded', (await rClaim())?.status);
  const hook = async (event, opts) => { const q = lkWebhookRequest(event, opts); const x = await fetch(`${APP}/api/livekit/webhook`, { method: 'POST', headers: q.headers, body: q.body }); await sleep(300); return x.status; };
  const ev = (id, over = {}) => ({ id, event: 'track_published', room: { name: `mc-${callRoom.id}` }, participant: { identity: `seat:${join.body.seatId}` }, track: { type: 'VIDEO', source: 'CAMERA' }, createdAt: Math.floor(Date.now() / 1000), ...over });
  const unsigned = await hook(ev('EV_unsigned'), { sign: false });
  ok('D5. an UNSIGNED webhook claiming the camera is live is rejected (401) and moves nothing', unsigned === 401 && (await rClaim())?.status === 'recorded', `http ${unsigned}`);
  {
    // Round 2 #1: anyone can get a subscriber token, signed with the same
    // secret. Posted as the webhook's signature, it must not pass.
    const sub = await call('POST', '/api/livekit/token', { body: { room: stage.id, role: 'subscriber' } });
    const q = lkWebhookRequest(ev('EV_forged_sub'), { sign: false });
    const forged = await fetch(`${APP}/api/livekit/webhook`, { method: 'POST', headers: { ...q.headers, Authorization: `Bearer ${sub.body.token}` }, body: q.body });
    await sleep(300);
    ok('D5. a SUBSCRIBER token from /api/livekit/token posted as the webhook signature is rejected (401) and credits nothing',
      sub.status === 200 && !!sub.body.token && forged.status === 401 && (await rClaim())?.status === 'recorded', `token http ${sub.status}, webhook http ${forged.status}`);
  }
  await hook(ev('EV_audio', { track: { type: 'AUDIO', source: 'MICROPHONE' } }));
  await hook(ev('EV_other_room', { room: { name: 'mc-someone-else' } }));
  await hook(ev('EV_other_seat', { participant: { identity: 'seat:not-her-seat' } }));
  ok('D5. a signed AUDIO track, a camera in ANOTHER room, or another seat’s camera does not count', (await rClaim())?.status === 'recorded', (await rClaim())?.status);
  await hook(ev('EV_camera'));
  let rs = null;
  for (let i = 0; i < 10; i++) { rs = (await rClaim())?.status; if (rs === 'releasing') break; await sleep(300); }
  ok('D5. a SIGNED LiveKit track_published (camera, her seat’s identity, this ON-AIR room) → joined → owed → payout intent', rs === 'releasing', `status=${rs}`);
  await call('POST', `/api/leave/${join.body.seatId}`);

  // D5b — cold review B2: the same Call in offer in a room that is OFF AIR
  // (the stage room has no open airing). A signed camera webhook counts nothing.
  {
    await call('POST', `/api/campaigns/${R2.slug}/check`, { as: 'x:xalice' });
    const j2 = await call('POST', '/api/join/mpp', { as: 'x:xalice', body: { room: 'gatestage', username: 'xalice', campaign: R2.slug } });
    const r2Claim = async () => (await call('GET', `/api/campaigns/${R2.slug}/my-claim`, { as: 'x:xalice' })).body.claim;
    await hook({ id: 'EV_camera_offair', event: 'track_published', room: { name: `mc-${stage.id}` }, participant: { identity: `seat:${j2.body.seatId}` }, track: { type: 'VIDEO', source: 'CAMERA' }, createdAt: Math.floor(Date.now() / 1000) });
    let st2 = null;
    for (let i = 0; i < 6; i++) { st2 = await r2Claim(); await sleep(300); }
    ok('D5b. OFF AIR: a SIGNED camera webhook for a campaign Call in in a room that is not broadcasting is never joined or owed, and the claim says offAir',
      j2.status === 200 && !!j2.body.seatId && st2?.status === 'recorded' && st2.offAir === true && !doorRows().some((x) => x.type === 'INTENT' && (x.meta || {}).campaignId === R2.id),
      `join http ${j2.status}; claim ${st2?.status} offAir=${st2?.offAir}`);
    await call('POST', `/api/leave/${j2.body.seatId}`);
  }

  // D4b — round 2 #2: a fake overlay socket (role:'overlay' is self-declared)
  // in a room that is NOT on air. The clip plays to it, and does not count.
  {
    await call('POST', `/api/campaigns/${O.slug}/check`, { as: 'x:xalice' });
    const fake = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const playedOff = [];
    let oPlayedAt = 0;
    await new Promise((res, rej) => { fake.on('open', res); fake.on('error', rej); });
    fake.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'letter_play') { playedOff.push(m.letter.id); oPlayedAt = Date.now(); } } catch { /* */ } });
    fake.send(JSON.stringify({ type: 'subscribe_room', room: stage.id, role: 'overlay' }));
    await sleep(400);
    const o = await submit(stage.id, 'x:xalice', O.slug);
    await fetch(`${APP}/api/letter/upload/${o.body.letterId}`, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: Buffer.alloc(4096, 7) });
    const oClaim = async () => (await call('GET', `/api/campaigns/${O.slug}/my-claim`, { as: 'x:xalice' })).body.claim;
    let os = null, seen = [];
    for (let i = 0; i < 40; i++) { os = (await oClaim())?.status; seen.push(os); if (playedOff.includes(o.body.letterId) && Date.now() - oPlayedAt > 7000) break; await sleep(500); }
    try { fake.close(); } catch { /* */ }
    ok('D4b. OFF AIR: a clip played to a fake overlay socket in a room that is not broadcasting never counts as aired (never owed)',
      o.status === 200 && playedOff.includes(o.body.letterId) && !seen.some((x) => ['owed', 'releasing', 'paid'].includes(x)), `played=${playedOff.includes(o.body.letterId)} status=${os}`);
  }

  // D6 — create and fund over HTTP: refused honestly
  const draft = await call('POST', '/api/campaigns', { as: 'twitch:campowner', body: holler({ title: 'Over HTTP' }) });
  ok('D6. any signed-in account creates a draft; the response is the campaign with budget and claims summaries',
    draft.status === 200 && draft.body.status === 'draft' && draft.body.slug === 'over-http' && draft.body.budget?.funded === '0' && draft.body.claims?.total === 0, JSON.stringify(draft).slice(0, 200));
  const policy = await call('POST', '/api/campaigns', { as: 'twitch:campowner', body: holler({ title: 'Retweet to win' }) });
  ok('D6. copy asking for an action on X is refused over HTTP too', policy.status === 400 && policy.body.reason === 'x_policy');
  const pullsBefore = doorRows().filter((x) => x.type === 'PULL').length;
  const noWallet = await call('POST', `/api/campaigns/${draft.body.id}/fund`, { as: 'twitch:campowner', body: {} });
  ok('D6. fund with no wallet answers needsApproval (token, spender, amount)', noWallet.status === 200 && noWallet.body.needsApproval?.amountAtomic === '12000000' && noWallet.body.needsApproval.token.symbol === 'USDC');
  {
    const na = noWallet.body.needsApproval || {};
    ok('D6. ...the spender to approve is the dedicated CAMPAIGN spender (not the seat seller key), the holder is the platform wallet, and it carries the Fund message to sign',
      String(na.spender).toLowerCase() === privateKeyToAccount(campaignSpenderKey).address.toLowerCase() && String(na.holder).toLowerCase() === privateKeyToAccount(sellerKey).address.toLowerCase()
      && na.sign?.message?.campaignId === draft.body.id && na.sign.message.amountAtomic === '12000000' && na.sign.primaryType === 'Fund' && Number.isInteger(na.sign.domain?.chainId) && na.sign.maxSeconds === 600,
      `spender ${na.spender}, holder ${na.holder}`);
  }
  const withWallet = await call('POST', `/api/campaigns/${draft.body.id}/fund`, { as: 'twitch:campowner', body: { wallet: privateKeyToAccount(generatePrivateKey()).address } });
  ok('D6. a wallet with no approve transaction is asked to approve (approveRequired), whatever its allowance, and nothing is pulled',
    withWallet.body.needsApproval?.approveRequired === true && doorRows().filter((x) => x.type === 'PULL').length === pullsBefore, JSON.stringify(withWallet.body).slice(0, 120));
  const bogus = await call('POST', `/api/campaigns/${draft.body.id}/fund`, { as: 'twitch:campowner', body: { wallet: W(0xbad), approveTx: `0x${'cd'.repeat(32)}` } });
  ok('D6. someone else’s wallet with an approve tx the chain has never seen is refused, and nothing is pulled',
    bogus.status >= 400 && ['approve_invalid', 'approve_unreadable'].includes(bogus.body.reason) && doorRows().filter((x) => x.type === 'PULL').length === pullsBefore, `http ${bogus.status} ${bogus.body.reason}`);
  const mineList = await call('GET', '/api/campaigns/mine', { as: 'twitch:campowner' });
  ok('D6. GET /api/campaigns/mine lists the creator\'s own campaigns only', mineList.status === 200 && mineList.body.campaigns.length === 9 && (await call('GET', '/api/campaigns/mine', { as: 'x:xbob' })).body.campaigns.length === 0);

  // D9 — cold review item 6: /api/dashboard/unlock is rate-limited per IP and
  // per room, and a room password alone never gets the overlay key. The
  // server trusts one proxy hop (Railway), so X-Forwarded-For is the client IP.
  {
    const xff = (ip) => ({ 'X-Forwarded-For': ip });
    const unlock = (roomId, password, ip) => call('POST', '/api/dashboard/unlock', { body: { roomId, password }, headers: xff(ip) });
    const created = await call('POST', '/api/dashboard/create', { body: { name: 'Gate password room', password: 'gate-pass-9' }, headers: xff('10.20.0.1') });
    const pwRoom = created.body.room?.id;
    const good = await unlock(pwRoom, 'gate-pass-9', '10.20.0.1');
    const viaPw = await call('GET', `/api/dashboard/rooms/${pwRoom}`, { headers: { 'x-room-password': 'gate-pass-9', ...xff('10.20.0.1') } });
    const noKey = (u) => typeof u === 'string' && u.endsWith(`/overlay?room=${pwRoom}`) && !/[?&]k=/.test(u);
    ok('D9. a room PASSWORD alone gets the PLAIN overlay URL (no &k=) from create, unlock and the room read; only the signed-in owner gets the keyed one (D4c)',
      created.status === 201 && noKey(created.body.overlayUrl) && good.status === 200 && noKey(good.body.overlayUrl) && viaPw.status === 200 && noKey(viaPw.body.overlayUrl),
      `create ${created.status} ${noKey(created.body.overlayUrl) ? 'plain' : 'KEYED'}; unlock ${good.status} ${noKey(good.body.overlayUrl) ? 'plain' : 'KEYED'}; read ${viaPw.status} ${noKey(viaPw.body.overlayUrl) ? 'plain' : 'KEYED'}`);
    const wrong = [];
    for (let i = 2; i <= 10; i++) wrong.push((await unlock(pwRoom, 'not-the-password', `10.20.0.${i}`)).status);
    const capped = await unlock(pwRoom, 'gate-pass-9', '10.20.0.99');
    ok('D9. UNLOCK RATE LIMIT, per room: after 10 attempts in a minute (from 10 different IPs) even the RIGHT password from a fresh IP is refused 429',
      wrong.length === 9 && wrong.every((x) => x === 401) && capped.status === 429 && capped.body.reason === 'rate_limited', `${wrong.join(',')} → ${capped.status}`);
    const created2 = await call('POST', '/api/dashboard/create', { body: { name: 'Gate password room 2', password: 'gate-pass-8' }, headers: xff('10.30.0.9') });
    const spread = [];
    for (let i = 0; i < 10; i++) spread.push((await unlock(`gate-nope-${i}-${randomBytes(3).toString('hex')}`, 'x', '10.30.0.1')).status);
    const ipCapped = await unlock(created2.body.room?.id, 'gate-pass-8', '10.30.0.1');
    const otherIp = await unlock(created2.body.room?.id, 'gate-pass-8', '10.30.0.2');
    ok('D9. ...and per IP: 10 attempts on 10 other rooms from one IP, then its valid unlock of a fresh room is refused 429; another IP unlocks that room',
      spread.every((x) => x === 404) && ipCapped.status === 429 && otherIp.status === 200, `${spread.join(',')} → ${ipCapped.status}; other IP ${otherIp.status}`);
  }

  // D7 — the page
  const html = await (await fetch(`${APP}/c/${P.slug}`)).text();
  ok('D7. /c/<slug> carries share metadata for X (og:title, twitter:card)', /property="og:title" content="(\$5|5 USDC) for a Holler on @gatestage/.test(html) && /name="twitter:card" content="summary_large_image"/.test(html));
  const fresh = assertFreshBuild();
  ok('D7. the build under test is newer than the web source (assertFreshBuild)', fresh.ok, fresh.detail);
  if (fresh.ok) {
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const cookie = auth.cookieFor('x:xalice'); const eq = cookie.indexOf('=');
    await page.setCookie({ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: APP });
    for (const theme of ['dark', 'light']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      await page.goto(`${APP}/c/${P.slug}`, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(600);
      const text = await page.evaluate(() => document.body.innerText);
      const want = { reward: /\$5\b|5 USDC/, room: /@gatestage/, rules: /At least 10,000 followers on X/, status: /on its way|Reward recorded/ };
      const missing = Object.keys(want).filter((k) => !want[k].test(text));
      ok(`D7. (${theme}) the offer renders: reward, room, rules, the claim status`, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');
      ok(`D7. (${theme}) the rendered page asks nothing of anyone on X`, !elig2.copyViolation(text));
    }
    await page.deleteCookie({ name: 'mc_identity', url: APP });
    await page.goto(`${APP}/c/${Q.slug}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(600);
    ok('D7. signed out, the page offers "Check if I qualify"', /Check if I qualify/.test(await page.evaluate(() => document.body.innerText)));
  }
} catch (e) {
  ok('D. the HTTP section ran to the end', false, e.message);
  if (srv) console.log(srv.stderr().slice(-1500));
} finally {
  try { ws?.close(); } catch { /* */ }
  try { await browser?.close(); } catch { /* */ }
  srv?.kill();
  await sleep(1500);
}

// D8 — round 3 #6: a CAMPAIGN_SPENDER_KEY that is another signer's key is
// refused at boot. A second, short boot on the same data dir: the spender and
// the reward pool share one fresh, empty key.
{
  const PORT8 = PORT + 1;
  let srv8 = null;
  try {
    const shared = generatePrivateKey();
    srv8 = await startGateServer({
      port: PORT8, dataDir: SD, label: 'campaigns-spender-clash',
      env: {
        ...auth.env, SITE_ADMIN_TWITCH: 'siteboss', CAMPAIGN_FUNDING: '1', KEEP_ORPHAN_ROOMS: 'true',
        SELLER_PRIVATE_KEY: sellerKey, SELLER_WALLET_ADDRESS: privateKeyToAccount(sellerKey).address,
        CAMPAIGN_SPENDER_KEY: shared, REWARD_POOL_PRIVATE_KEY: shared,
        PLATFORM_SETTLEMENT_KEY: '', ESCROW_OPERATOR_KEY: '', ESCROW_ATTEST_KEY: '',
        X_BEARER_TOKEN: '', X_TOKEN_KEY: '', X_CLIENT_ID: '', X_CLIENT_SECRET: '', MODERATION_API_KEY: '',
        LIVEKIT_URL: '', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '',
      },
    });
    const call8 = async (method, p, body) => {
      const r = await fetch(`http://localhost:${PORT8}${p}`, { method, headers: { 'Content-Type': 'application/json', Cookie: auth.cookieFor('twitch:campowner') }, body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const dr = await call8('POST', '/api/campaigns', holler({ title: 'Spender clash' }));
    const fd = await call8('POST', `/api/campaigns/${dr.body.id}/fund`, {});
    const out = srv8.stderr();
    ok('D8. #6 a CAMPAIGN_SPENDER_KEY equal to REWARD_POOL_PRIVATE_KEY is refused at boot: funding answers no_pull_signer, the log names both env vars and never the key',
      dr.status === 200 && fd.status === 503 && fd.body.reason === 'no_pull_signer'
      && /CAMPAIGN_SPENDER_KEY resolves to the same address as REWARD_POOL_PRIVATE_KEY/.test(out) && !out.includes(shared.slice(2)),
      `fund http ${fd.status} ${fd.body.reason}`);
  } catch (e) {
    ok('D8. the spender-clash boot ran to the end', false, e.message);
    if (srv8) console.log(srv8.stderr().slice(-1500));
  } finally {
    srv8?.kill();
    await sleep(1500);
  }
}

// ═══ E. Gate H ════════════════════════════════════════════════════════════
console.log('\n── E. Gate H, unchanged ─────────────────────────────────────');
{
  const g = spawnSync(process.execPath, ['_gate-money.mjs'], { cwd: HERE, encoding: 'utf8', timeout: 240_000 });
  const m = /RESULT: (\d+) pass, (\d+) fail/.exec(g.stdout || '');
  ok('E. Gate H (node _gate-money.mjs) is 38/0 with campaigns in the tree', !!m && m[1] === '38' && m[2] === '0', m ? `${m[1]}/${m[2]}` : (g.stdout || g.stderr || '').slice(-300));
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
