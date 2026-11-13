/**
 * GATE — prize campaigns ("$50 to the best Holler") and the mutuals list.
 *
 * NO REAL X CALLS AND NO REAL MONEY: the engine runs against the REAL
 * settlement door (settlement.js) over a temp ledger, with a mock chain
 * adapter, exactly as _gate-campaigns.mjs section C does.
 *
 *   P1  a prize is its own budget; entries hold a place, never money
 *   P2  an entry is counted at the required state and pays nothing then
 *   P3  award: refused while live, by anyone but the creator, for a non-entry
 *   P4  award after the close: the winner is owed the whole pot (funded − X
 *       cost), every other entry is not chosen, ONE payout intent; a second
 *       award is refused and the window passing splits nothing
 *   P5  the refund waits for the prize, then returns funded − releases
 *   P6  not awarded in time: an even split, the remainder refunded, and no
 *       refund before the split
 *   P7  an award after the window is refused
 *   P8  nobody entered: the whole prize comes back
 *   P9  an entry that counts after the prize was decided is not chosen and
 *       is paid nothing
 *   P10 a per-claim ("each") campaign is unchanged
 *   M1  x-mutuals: the estimate reads both lists; the frozen set holds only
 *       accounts on both
 *
 * `--engine <path>` imports another copy of campaign-engine.js (a mutation
 * run: see DECISIONS.md, prize campaigns).
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { pathToFileURL } from 'url';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeEventTopics, encodeAbiParameters, erc20Abi } from 'viem';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); } else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); } };
const quiet = { log() {}, warn() {}, error() {} };
const attempt = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: e }; } };
const code = (r) => r.error?.code || (r.value ? 'ok' : 'none');

for (const k of ['CAMPAIGN_FUNDING', 'X_BEARER_TOKEN', 'X_TOKEN_KEY', 'CAMPAIGN_AWARD_HOURS', 'CAMPAIGN_CLOSE_GRACE_HOURS']) delete process.env[k];
const DIR = mkdtempSync(path.join(tmpdir(), 'mc-prize-'));
process.env.DATA_DIR = DIR;
process.env.CAMPAIGN_FUNDING = '1';

const enginePath = process.argv.includes('--engine') ? path.resolve(process.argv[process.argv.indexOf('--engine') + 1]) : path.resolve('campaign-engine.js');
const { createCampaignEngine, fundTypedData } = await import(pathToFileURL(enginePath).href);
const { createSettlement } = await import('./settlement.js');
const accounts = await import('./accounts.js');

const PLATFORM = '0x00000000000000000000000000000000000000aa';
const CSPEND = '0x00000000000000000000000000000000000000cc';
const USDC = { address: '0x20c000000000000000000000b9537d11c60e8b50', decimals: 6, symbol: 'USDC' };
const H = 3_600_000;

function transferLog({ token, from, to, value }) {
  return { address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(value)]) };
}
function receiptFor(door, hash) {
  const rec = door.all().find((r) => r.kind === 'pull' && String(r.txHash || '').toLowerCase() === String(hash || '').toLowerCase());
  const row = rec?.rows?.find((x) => x.type === 'PULL' || x.type === 'PULL_SENT');
  return { status: 'success', transactionHash: hash, logs: row ? [transferLog({ token: row.token.address, from: row.from, to: row.to, value: row.amountAtomic })] : [] };
}
let seq = 0;
const chain = {
  pulls: [], transfers: [],
  has: () => true,
  async transferFrom(a) { chain.pulls.push(a); return `0x${(++seq).toString(16).padStart(64, 'a')}`; },
  async transfer(a) { chain.transfers.push(a); return `0x${(++seq).toString(16).padStart(64, 'b')}`; },
  async receipt() { return { status: 'success', blockNumber: '1' }; },
};
const door = createSettlement({ dataDir: DIR, chain, platformAddress: PLATFORM, log: quiet });

// X, mocked: the creator (id 9000) follows 1..6; 4..9 follow the creator.
const FOLLOWING = ['1', '2', '3', '4', '5', '6'];
const FOLLOWERS = ['4', '5', '6', '7', '8', '9'];
const xcalls = { pages: [] };
const mockX = {
  X_COST_PER_USER_USD: 0.01,
  appBearerConfigured: () => true,
  async fetchUserById({ userId }) { return { ok: true, records: recs(BASE), costUsd: 0.01, user: { id: String(userId), username: `u${userId}`, followingCount: FOLLOWING.length, followersCount: FOLLOWERS.length } }; },
  async fetchUserByUsername({ username }) { return { ok: true, costUsd: 0.01, user: { id: '9000', username, followingCount: FOLLOWING.length, followersCount: FOLLOWERS.length } }; },
  async fetchList() { return { ok: false, error: 'unused' }; },
  async pageUsers({ kind, id, maxResults, paginationToken }) {
    xcalls.pages.push(kind);
    const all = kind === 'following' ? FOLLOWING : kind === 'followers' ? FOLLOWERS : [];
    const from = Number(paginationToken || 0);
    const users = all.slice(from, from + maxResults).map((u) => ({ id: u, username: `h${u}` }));
    return { ok: true, users, nextToken: from + maxResults < all.length ? String(from + maxResults) : null, costUsd: users.length * 0.01 };
  },
  async lookupConnection() { return { ok: false, error: 'unused' }; },
};

let clock = Date.parse('2026-11-13T20:00:00Z');
const BASE = { followersCount: 12000, verifiedFollowersCount: 40, verified: true, verifiedType: 'blue', identityVerified: false, accountCreatedAt: '2020-01-01T00:00:00Z', postCount: 900, listedCount: 12, parody: false, protected: false, hasProfileImage: true, hasDescription: true };
const recs = (attrs) => Object.entries(attrs).map(([attribute, value]) => ({ attribute, value, source: 'x-api', trust: 100, fetchedAt: new Date(clock).toISOString() }));

const APPROVALS = new Map();
const KEYS = new Map();
const W = (n) => { const a = privateKeyToAccount(`0x${BigInt(n).toString(16).padStart(64, '0')}`); const addr = a.address.toLowerCase(); KEYS.set(addr, a); return addr; };
const rooms = { prizeroom: { id: 'room-prize', ownerKey: null } };

const eng = createCampaignEngine({
  dataDir: DIR, settlement: door, platformAddress: PLATFORM, spender: CSPEND, usdc: USDC,
  readAllowance: async () => 10n ** 12n,
  confirmTx: async (h) => receiptFor(door, h),
  readApproval: async (h) => APPROVALS.get(h) || null,
  resolveRoom: (h) => rooms[h] || null,
  seatSignalAvailable: () => true, roomOnAir: () => true,
  xApi: mockX, xTokens: { holdersByXUserId: () => new Map(), async getXAccessToken() { return null; } },
  now: () => clock, log: quiet,
});

const creator = accounts.upsertAccountForLink({ provider: 'x', platformId: '9000', username: 'prizecreator', attributes: recs(BASE) });
rooms.prizeroom.ownerKey = creator.id;
const as = (a) => ({ accountId: a.id, isAdmin: false });
let xid = 4000;
const fan = (name) => { const a = accounts.upsertAccountForLink({ provider: 'x', platformId: String(++xid), username: name, attributes: recs(BASE) }); accounts.setAccountPayoutWallet(a.id, W(xid)); return a; };

async function funded(input) {
  const c = await eng.createCampaign(input, as(creator));
  const wallet = W(1);
  const hash = `0x${randomBytes(32).toString('hex')}`;
  APPROVALS.set(hash, { from: wallet, to: c.token.address, status: 'success', timestampMs: Date.parse(c.termsAt) + 1000, approvals: [{ token: c.token.address, owner: wallet, spender: CSPEND, value: c.budget.atomic }] });
  const td = fundTypedData({ chainId: 4217, campaignId: c.id, wallet, token: c.token.address, amountAtomic: c.budget.atomic, deadline: Math.floor(clock / 1000) + 300 });
  const signature = await KEYS.get(wallet).signTypedData(td);
  await eng.fund(c.id, { wallet, approveTx: hash, signature, typedData: { ...td, message: { ...td.message, amountAtomic: String(td.message.amountAtomic), deadline: String(td.message.deadline) } } }, as(creator));
  eng.open(c.id, as(creator));
  return eng.store.getCampaign(c.id);
}
const prizeInput = (over = {}) => ({
  title: `Best Holler wins ${Math.random().toString(36).slice(2, 6)}`, blurb: 'Send your best Holler; I pick the winner after the show.',
  payout: 'prize', action: { kind: 'holler', roomHandle: 'prizeroom', require: 'aired' },
  reward: { type: 'usdc', amount: '50' }, budget: { amount: '999' },
  deadline: new Date(clock + 3 * H).toISOString(), rules: { minFollowers: 10 }, ...over,
});
let L = 0;
/** Check, reserve, bind and (unless `air` is false) air one Holler for `who`. */
async function enter(c, who, { air = true } = {}) {
  const ck = await eng.check(c.slug, as(who)); if (!ck.result?.eligible) console.log("    (check)", JSON.stringify(ck.result?.checks?.filter((x) => !x.pass)));
  const r = eng.reserve({ slug: c.slug, accountId: who.id, kind: 'holler', roomId: 'room-prize' });
  const letterId = `L-${++L}`;
  eng.bind(r.claimId, { letterId });
  if (air) eng.onLetterEvent(letterId, 'aired');
  return { claimId: r.claimId, letterId };
}
const intents = (cid) => door.intentsFor('campaign:pay:').filter((r) => (r.rows?.[0]?.meta || {}).campaignId === cid);
const amt = (rec) => BigInt(rec.rows?.[0]?.amountAtomic || 0);
const claim = (id) => eng.store.getClaim(id);

// ── P1 / P2 ──
console.log('\n── P1-P2 entries ─────────────────────────────────────────────');
const A = await funded(prizeInput({ maxClaims: 3 }));
ok('P1. a prize is its own budget: $50 pulled, whatever budget was sent', A.payout === 'prize' && A.budget.atomic === '50000000' && chain.pulls.at(-1).amountAtomic === 50_000_000n, `budget ${A.budget.atomic}`);
ok('P1. places follow the entry cap, not budget ÷ reward', A.maxClaims === 3, `maxClaims ${A.maxClaims}`);
const fa = fan('ann'), fb = fan('ben'), fc = fan('cat'), fd = fan('dan');
const ea = await enter(A, fa), eb = await enter(A, fb), ec = await enter(A, fc);
ok('P2. an entry reserves no money', ['0', null].includes(claim(ea.claimId).reservedAtomic), String(claim(ea.claimId).reservedAtomic));
ok('P2. aired → entered, and nothing is owed or intended yet', [ea, eb, ec].every((e) => claim(e.claimId).status === 'entered') && intents(A.id).length === 0);
await eng.check(A.slug, as(fd));
const r4 = await attempt(() => eng.reserve({ slug: A.slug, accountId: fd.id, kind: 'holler', roomId: 'room-prize' }));
ok('P2. the entry cap holds: a 4th is refused as full', code(r4) === 'full', code(r4));

// ── P3 ──
console.log('\n── P3 award refusals ──────────────────────────────────────────');
let r = await attempt(() => eng.award(A.id, { claimId: eb.claimId }, as(creator)));
ok('P3. award while live is refused', code(r) === 'not_closed', code(r));
eng.close(A.id, as(creator));
r = await attempt(() => eng.award(A.id, { claimId: eb.claimId }, as(fa)));
ok('P3. someone else cannot award', code(r) === 'forbidden', code(r));
const dClaim = eng.store.claimFor({ campaignId: A.id, accountId: fd.id }).byAccount;
r = await attempt(() => eng.award(A.id, { claimId: dClaim.id }, as(creator)));
ok('P3. a claim that never entered cannot win', code(r) === 'not_an_entry', code(r));

// ── P4 / P5 ──
console.log('\n── P4-P5 award and refund ─────────────────────────────────────');
ok('P5. no refund while the prize is undecided', !eng.store.getCampaign(A.id).refund);
await eng.award(A.id, { claimId: eb.claimId }, as(creator));
ok('P4. the winner is owed the whole pot; one intent of $50 to their wallet',
  intents(A.id).length === 1 && amt(intents(A.id)[0]) === 50_000_000n && ['releasing', 'paid'].includes(claim(eb.claimId).status), `${intents(A.id).length} intents`);
ok('P4. every other entry is not chosen', claim(ea.claimId).status === 'not_chosen' && claim(ec.claimId).status === 'not_chosen');
r = await attempt(() => eng.award(A.id, { claimId: ea.claimId }, as(creator)));
ok('P4. a second award is refused', code(r) === 'already_decided', code(r));
clock += 100 * H; eng.sync(); eng.sync();
ok('P4. the window passing afterwards splits nothing', intents(A.id).length === 1);
await door.flush(); eng.sync();
const Arefund = eng.store.getCampaign(A.id).refund;
ok('P5. the refund is funded − releases = 0 once the prize is paid', Arefund && Arefund.atomic === '0', JSON.stringify(Arefund));
ok('P4. the door sent exactly $50, once, to the winner', chain.transfers.filter((t) => t.amountAtomic === 50_000_000n).length === 1 && chain.transfers.some((t) => t.to === accounts.getAccount(fb.id).payoutWallet));

// ── P6 / P7 ──
console.log('\n── P6-P7 the split ────────────────────────────────────────────');
const B = await funded(prizeInput({ reward: { type: 'usdc', amount: '10' } }));
const b1 = await enter(B, fan('eve')), b2 = await enter(B, fan('fay')), b3 = await enter(B, fan('gus'));
eng.close(B.id, as(creator));
clock += 47 * H; eng.sync();
ok('P6. inside the award window: no split, no refund', intents(B.id).length === 0 && !eng.store.getCampaign(B.id).refund);
clock += 2 * H;
r = await attempt(() => eng.award(B.id, { claimId: b1.claimId }, as(creator)));
ok('P7. an award after the window is refused', code(r) === 'award_window_passed', code(r));
eng.sync();
const shares = intents(B.id).map(amt);
ok('P6. past the window: one even share per entry ($10 ÷ 3 = 3.333333)', shares.length === 3 && shares.every((x) => x === 3_333_333n), shares.join(','));
ok('P6. the decision is recorded as a split', eng.store.getCampaign(B.id).prize?.mode === 'split' && [b1, b2, b3].every((e) => ['releasing', 'paid'].includes(claim(e.claimId).status)));
eng.sync();
ok('P6. the remainder (1 atomic unit) is refunded', eng.store.getCampaign(B.id).refund?.atomic === '1', JSON.stringify(eng.store.getCampaign(B.id).refund));

// ── P8 ──
console.log('\n── P8 nobody entered ──────────────────────────────────────────');
const C = await funded(prizeInput({ reward: { type: 'usdc', amount: '20' } }));
eng.close(C.id, as(creator));
clock += 49 * H; eng.sync();
ok('P8. no entries: decided as none, no payout, the whole $20 refunded', eng.store.getCampaign(C.id).prize?.mode === 'none' && intents(C.id).length === 0 && eng.store.getCampaign(C.id).refund?.atomic === '20000000', JSON.stringify(eng.store.getCampaign(C.id).refund));

// ── P9 ──
console.log('\n── P9 an entry after the decision ─────────────────────────────');
const D = await funded(prizeInput({ reward: { type: 'usdc', amount: '30' } }));
const d1 = await enter(D, fan('hal'));
const d2 = await enter(D, fan('ivy'), { air: false });     // submitted, not aired yet
eng.close(D.id, as(creator));
await eng.award(D.id, { claimId: d1.claimId }, as(creator));
eng.sync();
ok('P9. the refund waits while an honoured entry is still in flight', !eng.store.getCampaign(D.id).refund && claim(d2.claimId).status === 'recorded');
clock += 1 * H; eng.onLetterEvent(d2.letterId, 'aired');
ok('P9. it airs after the award: not chosen, no intent', claim(d2.claimId).status === 'not_chosen' && intents(D.id).length === 1, claim(d2.claimId).status);
await door.flush(); eng.sync();
ok('P9. the refund then goes out: $0 (the whole pot went to the winner)', eng.store.getCampaign(D.id).refund?.atomic === '0');

// ── P10 ──
console.log('\n── P10 per-claim campaigns are unchanged ──────────────────────');
const E = await funded({ ...prizeInput(), payout: undefined, reward: { type: 'usdc', amount: '5' }, budget: { amount: '12' }, maxClaims: null });
ok('P10. an "each" campaign keeps its budget and floor(budget ÷ reward) places', E.payout === 'each' && E.budget.atomic === '12000000' && E.maxClaims === 2, `${E.payout} ${E.budget.atomic} ${E.maxClaims}`);
const e1 = await enter(E, fan('jo'));
ok('P10. ...and pays the reward the moment it airs', ['releasing', 'paid'].includes(claim(e1.claimId).status) && intents(E.id).length === 1 && amt(intents(E.id)[0]) === 5_000_000n);
r = await attempt(() => eng.award(E.id, { claimId: e1.claimId }, as(creator)));
ok('P10. award is refused on an "each" campaign', code(r) === 'not_prize', code(r));
r = await attempt(() => eng.updateCampaign(E.id, { payout: 'prize' }, as(creator)));
ok('P10. a live campaign cannot switch to a prize', r.error != null, code(r));

// ── M1 ──
console.log('\n── M1 the mutuals list ────────────────────────────────────────');
const est = await eng.estimateSet({ source: 'x-mutuals', sourceRef: '', accountId: creator.id });
ok('M1. the estimate reads both lists (6 + 6 accounts, $0.12) and offers at most min(6, 6)', est.reads === 12 && est.costUsd === 0.12 && est.count === 6, JSON.stringify({ reads: est.reads, cost: est.costUsd, count: est.count }));
const set = await eng.buildSet({ name: 'Mutuals', source: 'x-mutuals', sourceRef: '', confirm: true, confirmCostUsd: est.costUsd }, { accountId: creator.id, isAdmin: true });
const ids = eng.store.getSet(set.id).ids;
ok('M1. the frozen set holds exactly the accounts on both lists (4, 5, 6)', ids.length === 3 && ['4', '5', '6'].every((i) => ids.includes(i)), ids.join(','));
ok('M1. ...after reading following AND followers', xcalls.pages.includes('following') && xcalls.pages.includes('followers'));

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
