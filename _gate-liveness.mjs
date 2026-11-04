/**
 * GATE — liveness tiers (liveness.js; OPEN-ISSUES O, built 2026-11-04).
 *
 * NO REAL CHAIN, NO REAL MONEY, NO REAL BROADCAST. Section A is the pure
 * classifier and the sampler. Section B drives bounty-escrow.js in-process
 * (ledger-only mode, scratch DATA_DIR) with airings written by
 * airings-store.js and the overlay sampled by hand: the yellow-tier release
 * pays only yellow-allowed money, only after the minimum, once per airing
 * and handle; the green release draws on everything. Section C boots the
 * real server and reads the public liveness route, the account preference
 * routes, the pledge's inherited tier and the pool view's tier split.
 *
 *   A1  classify: the full table — off / red / yellow / green
 *   A2  accumulate: credits a gap only when BOTH samples saw the overlay,
 *       never more than the max gap; the first sample credits nothing
 *   B1  a yellow release below the minimum is skipped (too_short)
 *   B2  above it: a slice of the YELLOW-allowed money only, green money untouched,
 *       the platform match in its own row, the handle moves to PARTIALLY_RELEASED
 *   B3  idempotent per airing and handle; a second airing releases again;
 *       the green (badge) release still draws on both tiers
 *   B4  releaseYellowForAiring: only pools the room's OWNER claimed, only
 *       claimed states; an overlay that was never connected releases nothing
 *       (DISCRIMINATES: the same airing with connectedMs forced high releases)
 *   B5  the pool view's tier split and yellowReleased
 *   B6  account preferences: default green, yellow accepted, junk refused
 *   C   HTTP: /api/rooms/:id/liveness is public and 'off' for a dark room;
 *       prefs routes (401 anonymous, 400 junk, round-trip); a pledge inherits
 *       the account tier, the body may override; /api/bounty/my carries it;
 *       pool-view has tiers; /api/rooms/public cards carry liveness
 */
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e }; } };

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-liveness-'));
const DATA = path.join(SCRATCH, 'data');
mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
process.env.BOUNTY_CLAIM = '1';
process.env.BOUNTY_FUNDING = '';
process.env.BOUNTY_IDENTITY_STUB = '1';
process.env.BOUNTY_YELLOW_MIN_MS = '600000';          // 10 min
process.env.BOUNTY_YELLOW_RELEASE_FRACTION = '0.1';

const { classify, accumulate, meetsTier, TIERS } = await import('./liveness.js');
const store = await import('./bounty-store.js');
const escrow = await import('./bounty-escrow.js');
const airings = await import('./airings-store.js');
const accounts = await import('./accounts.js');
const { settlement } = await import('./bounty-settlement.js');
const { bountyConfig } = await import('./bounty-claim.config.js');
store.verifyLedgerIntegrity();
store.verifyEvidenceIntegrity();

console.log('\n── Gate: liveness tiers ────────────────────────────────────');
console.log(`   scratch ${SCRATCH}`);

// ── A1: the classifier ───────────────────────────────────────────────────
{
  const t = (o) => classify(o);
  ok('A1. nothing live → off', t({}) === 'off' && t({ overlayConnected: true, verifying: true }) === 'off');
  ok('A1. channel live, no airing, no overlay → red', t({ channelLive: true }) === 'red');
  ok('A1. on air, no overlay → red', t({ onAir: true }) === 'red');
  ok('A1. channel live with an overlay but NO airing → red (the overlay is not on a broadcast the server knows)', t({ channelLive: true, overlayConnected: true }) === 'red');
  ok('A1. on air with the keyed overlay → yellow', t({ onAir: true, overlayConnected: true }) === 'yellow');
  ok('A1. on air, overlay seen in the last ten minutes → yellow (a reconnect is not a bury)', t({ onAir: true, overlayRecent: true }) === 'yellow');
  ok('A1. on air, overlay up, badge verification running → green', t({ onAir: true, overlayConnected: true, verifying: true }) === 'green');
  ok('A1. verifying WITHOUT the overlay is not green (a session alone proves nothing on screen)', t({ onAir: true, verifying: true }) === 'red' && t({ onAir: true, overlayRecent: true, verifying: true }) === 'yellow');
  ok('A1. the tiers rank off < red < yellow < green', meetsTier('green', 'yellow') && meetsTier('yellow', 'yellow') && !meetsTier('red', 'yellow') && !meetsTier('yellow', 'green') && TIERS.join() === 'off,red,yellow,green');
}

// ── A2: the sampler ──────────────────────────────────────────────────────
{
  let o = accumulate(null, { connected: true, at: 1000, maxGapMs: 60_000 });
  ok('A2. the first sample credits nothing', o.connectedMs === 0 && o.sampledMs === 0 && o.samples === 1 && o.lastConnected === true);
  o = accumulate(o, { connected: true, at: 31_000, maxGapMs: 60_000 });
  ok('A2. a gap with the overlay at BOTH ends is credited', o.connectedMs === 30_000 && o.sampledMs === 30_000);
  o = accumulate(o, { connected: false, at: 61_000, maxGapMs: 60_000 });
  ok('A2. a gap ending disconnected is sampled but not credited', o.connectedMs === 30_000 && o.sampledMs === 60_000);
  o = accumulate(o, { connected: true, at: 91_000, maxGapMs: 60_000 });
  ok('A2. ...nor one starting disconnected (reconnect credits from the next sample)', o.connectedMs === 30_000 && o.sampledMs === 90_000);
  o = accumulate(o, { connected: true, at: 1_000_000, maxGapMs: 60_000 });
  ok('A2. a gap past the max (a missed tick, a restart) is capped at the max', o.connectedMs === 90_000 && o.sampledMs === 150_000);
  o = accumulate(o, { connected: true, at: 999_000, maxGapMs: 60_000 });
  ok('A2. a sample from the past credits nothing (clock went backwards)', o.connectedMs === 90_000);
}

// ── B: the yellow release against the escrow ─────────────────────────────
try {
  const OWNER = 'acct_lv_streamer';
  const pledgeFor = (handle, amount, minTier, contributor = 'acct_lv_fan') =>
    escrow.pledge({ targets: [{ platform: 'twitch', handle }], contributor, amount, expiresInMs: 24 * 3600_000, minTier });
  const g = pledgeFor('lv-h1', '40', 'green');
  const y = pledgeFor('lv-h1', '60', 'yellow');
  const key = g.pledge.targets[0];
  ok('B0. pledges carry the backer tier on the pledge and the contribution', g.pledge.minTier === 'green' && y.contribution.minTier === 'yellow' && store.tierOf(y.contribution) === 'yellow');
  const bad = await attempt(() => pledgeFor('lv-h1', '1', 'purple'));
  ok('B0. a tier outside green/yellow is refused', !bad.ok && /minTier/.test(bad.error.message));
  const view0 = escrow.poolView(key);
  ok('B5. the pool view splits the money by tier (40 green-only, 60 yellow-ok, 0 yellow released)', view0.tiers?.greenOnly === 40 && view0.tiers.yellowOk === 60 && view0.tiers.yellowReleased === 0, JSON.stringify(view0.tiers));
  store.updateReservedHandle(key, { claimedBy: 'lvstreamer', claimedByAccount: OWNER });
  escrow.transition({ handleKey: key, to: 'RESERVED', actor: 'gate' });
  escrow.transition({ handleKey: key, to: 'CLAIM_PENDING', actor: 'gate' });
  escrow.transition({ handleKey: key, to: 'CLAIM_VERIFIED', actor: 'gate' });
  escrow.transition({ handleKey: key, to: 'AWAITING_AIRTIME', actor: 'gate' });

  // B1: below the minimum
  const short = escrow.release({ handleKey: key, tier: 'yellow', airingId: 'air-short', overlayConnectedMs: 5 * 60_000, idempotencyKey: 'release:yellow:air-short:' + key, settlement });
  ok('B1. a broadcast with the overlay up 5 min (min 10) releases nothing: too_short', short.skipped === 'too_short' && short.rows.length === 0 && store.getPool(key).remaining === 100);

  // B2: above it
  const rel = escrow.release({ handleKey: key, tier: 'yellow', airingId: 'air-1', overlayConnectedMs: 12 * 60_000, broadcastMs: 60 * 60_000, idempotencyKey: 'release:yellow:air-1:' + key, settlement });
  const alloc = rel.rows?.[0]?.meta?.allocations || [];
  ok('B2. 12 min up → 10% of the YELLOW-allowed 60 = 6 released, match 1.5, drawn only from the yellow contribution',
    rel.released === 6 && rel.match === 1.5 && alloc.length === 1 && alloc[0].contributionId === y.contribution.id && alloc[0].amount === 6, JSON.stringify({ r: rel.released, m: rel.match, alloc, skipped: rel.skipped }));
  ok('B2. ...the ledger row says which tier and which airing', rel.rows[0].meta.tier === 'yellow' && rel.rows[0].meta.airingId === 'air-1' && rel.rows[0].meta.overlayConnectedMs === 12 * 60_000 && rel.rows[1].bucket === 'platform_match');
  const view1 = escrow.poolView(key);
  ok('B2. ...the pool view: green-only money untouched (40), yellow-ok 54 left, 6 yellow released', view1.tiers.greenOnly === 40 && view1.tiers.yellowOk === 54 && view1.tiers.yellowReleased === 6 && view1.remaining === 94, JSON.stringify(view1.tiers));
  ok('B2. ...the handle moved to PARTIALLY_RELEASED', store.getReservedHandleByKey(key).claimStatus === 'PARTIALLY_RELEASED');
  ok('B2. ...the stub recorded two intents for the verified owner', settlement.pending().filter((i) => i.ref === rel.rows[0].id || i.ref === rel.rows[1].id).length === 2);

  // B3: idempotency, a second airing, the green release
  const again = escrow.release({ handleKey: key, tier: 'yellow', airingId: 'air-1', overlayConnectedMs: 50 * 60_000, idempotencyKey: 'release:yellow:air-1:' + key, settlement });
  ok('B3. the same airing again is deduped: no second slice', again.deduped === true && store.getPool(key).remaining === 94);
  const rel2 = escrow.release({ handleKey: key, tier: 'yellow', airingId: 'air-2', overlayConnectedMs: 30 * 60_000, idempotencyKey: 'release:yellow:air-2:' + key, settlement });
  ok('B3. a second broadcast releases another slice (10% of the original yellow 60 = 6)', rel2.released === 6 && store.getPool(key).remaining === 88);
  const green = escrow.release({ handleKey: key, claimId: null, airSessionId: null, verifiedClips: 1, verifiedClipSeconds: 10, confidence: 0.9, idempotencyKey: 'release:green:lv', settlement });
  const gAlloc = green.rows?.[0]?.meta?.allocations || [];
  ok('B3. the badge (green) release still draws on BOTH tiers pro rata', green.released > 0 && gAlloc.length === 2 && green.rows[0].meta.tier === 'green', JSON.stringify({ r: green.released, n: gAlloc.length }));

  // B4: the airing hook
  const roomId = 'lvroom1';
  const a = airings.openAiring({ roomId, channel: 'lvstreamer' });
  ok('B4. an airing opens with no overlay record', !!a && a.overlay == null);
  // sampled by hand: 25 samples 30s apart, the overlay up on each
  let at = a.startedAt;
  for (let i = 0; i < 25; i++) { airings.recordOverlaySample(roomId, { connected: true, at, maxGapMs: 60_000, fold: accumulate }); at += 30_000; }
  const openRec = airings.openAiringFor(roomId);
  ok('B4. 25 samples 30 s apart with the overlay up → 12 min credited on the airing', openRec.overlay.connectedMs === 24 * 30_000 && openRec.overlay.samples === 25, `${openRec.overlay.connectedMs} ms`);
  const closed = airings.closeAiring(roomId, at);
  const before = store.getPool(key).remaining;
  const out = escrow.releaseYellowForAiring({ airing: closed, ownerKey: OWNER, settlement });
  ok('B4. the closed airing releases for the pool its owner claimed, once, from the yellow money', out.length === 1 && out[0].handleKey === key && out[0].released === 6 && store.getPool(key).remaining === +(before - 6).toFixed(6), JSON.stringify(out.map((o) => ({ h: o.handleKey, r: o.released, s: o.skipped }))));
  const none = escrow.releaseYellowForAiring({ airing: closed, ownerKey: 'acct_someone_else', settlement });
  ok('B4. a room owned by someone who claimed nothing releases nothing', none.length === 0);
  const unclaimed = pledgeFor('lv-h2', '10', 'yellow');
  const none2 = escrow.releaseYellowForAiring({ airing: closed, ownerKey: OWNER, settlement });
  ok('B4. an unclaimed pool is never released by an airing (and the claimed one is deduped)', none2.length === 1 && none2[0].deduped === true && store.getPool(unclaimed.pledge.targets[0]).remaining === 10);
  // DISCRIMINATES: an airing with the overlay never connected
  const roomB = 'lvroom2';
  const b = airings.openAiring({ roomId: roomB, channel: 'lvstreamer' });
  let atB = b.startedAt;
  for (let i = 0; i < 25; i++) { airings.recordOverlaySample(roomB, { connected: false, at: atB, maxGapMs: 60_000, fold: accumulate }); atB += 30_000; }
  const closedB = airings.closeAiring(roomB, atB);
  const outB = escrow.releaseYellowForAiring({ airing: closedB, ownerKey: OWNER, settlement });
  ok('B4. DISCRIMINATES: a broadcast where the overlay was NEVER on screen releases nothing (too_short, 0 ms)', outB.length === 1 && outB[0].skipped === 'too_short' && outB[0].detail?.overlayConnectedMs === 0);
  const forced = escrow.releaseYellowForAiring({ airing: { ...closedB, id: 'air-forced', overlay: { connectedMs: 15 * 60_000 } }, ownerKey: OWNER, settlement });
  ok('B4. ...and the same airing with the overlay credited 15 min releases', forced.length === 1 && forced[0].released === 6);

  // B6: account preferences
  const acctId = 'acct_lvprefs0000';
  ok('B6. an unknown account reads the default: green', accounts.getAccountPrefs(acctId).bountyMinTier === 'green');
} catch (e) {
  ok(`B. the section ran to the end (it crashed: ${e.stack || e.message})`, false);
}

// ── C: HTTP — the real server ─────────────────────────────────────────────
{
  const { startGateServer } = await import('./_gate-helpers.mjs');
  const PORT = 3263;
  const base = `http://localhost:${PORT}`;
  let srv = null;
  try {
    srv = await startGateServer({
      port: PORT, dataDir: mkdtempSync(path.join(tmpdir(), 'mc-lv-http-')), label: 'liveness',
      bountyAuth: { handles: ['lvfan', 'lvfan2'] },
      env: { BOUNTY_CLAIM: '1', BOUNTY_IDENTITY_STUB: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '', TWITCH_CLIENT_ID: '', KICK_CLIENT_ID: '' },
    });
    const call = (method, p, body, as = 'lvfan') => fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(as ? srv.headers(as) : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const room = await call('POST', '/api/dashboard/create', { name: 'Liveness room', password: 'lv-room-pw', passkeyTickPrice: '0.001', transport: 'vdo' }, null);
    const roomId = room.body.room?.id || room.body.roomId;
    const lv = await call('GET', `/api/rooms/${roomId}/liveness`, undefined, null);
    ok('C. GET /api/rooms/:id/liveness is public and reads off for a room nobody is broadcasting', lv.status === 200 && lv.body.tier === 'off' && lv.body.roomId === roomId && lv.body.onAir === false, JSON.stringify(lv.body));
    const lvMissing = await call('GET', '/api/rooms/nope-nope/liveness', undefined, null);
    ok('C. ...an unknown room is 400/404, not a crash', lvMissing.status === 400 || lvMissing.status === 404);
    const pub = await call('GET', '/api/rooms/public', undefined, null);
    const card = pub.body.rooms?.find((r) => r.id === roomId);
    ok('C. /api/rooms/public cards carry a liveness reading', !!card && card.liveness?.tier === 'off', JSON.stringify(card?.liveness));
    const anon = await call('GET', '/api/account/prefs', undefined, null);
    const def = await call('GET', '/api/account/prefs');
    ok('C. prefs: anonymous 401; a signed-in account reads the default green', anon.status === 401 && def.status === 200 && def.body.prefs?.bountyMinTier === 'green');
    const junk = await call('PUT', '/api/account/prefs', { prefs: { bountyMinTier: 'purple' } });
    const junk2 = await call('PUT', '/api/account/prefs', { prefs: { somethingElse: 1 } });
    ok('C. prefs: a bad tier and an unknown key are refused (400), nothing written', junk.status === 400 && junk2.status === 400 && (await call('GET', '/api/account/prefs')).body.prefs.bountyMinTier === 'green');
    const set = await call('PUT', '/api/account/prefs', { prefs: { bountyMinTier: 'yellow' } });
    ok('C. prefs: yellow round-trips', set.status === 200 && set.body.prefs.bountyMinTier === 'yellow' && (await call('GET', '/api/account/prefs')).body.prefs.bountyMinTier === 'yellow');
    const p1 = await call('POST', '/api/bounty/pledge', { targets: [{ platform: 'twitch', handle: 'lvtarget' }], contributor: 'Gate', amount: '5', expiresInMs: 86_400_000 });
    ok('C. a pledge inherits the account tier (yellow)', p1.status === 200 && p1.body.pledge?.minTier === 'yellow' && p1.body.contribution?.minTier === 'yellow', JSON.stringify({ s: p1.status, t: p1.body.pledge?.minTier }));
    const p2 = await call('POST', '/api/bounty/pledge', { targets: [{ platform: 'twitch', handle: 'lvtarget' }], contributor: 'Gate', amount: '3', expiresInMs: 86_400_000, minTier: 'green' });
    ok('C. ...the body may override it for one pledge (green)', p2.status === 200 && p2.body.pledge?.minTier === 'green');
    const p3 = await call('POST', '/api/bounty/pledge', { targets: [{ platform: 'twitch', handle: 'lvtarget' }], contributor: 'Gate', amount: '2', expiresInMs: 86_400_000, minTier: 'purple' });
    ok('C. ...a junk override falls back to the account tier', p3.status === 200 && p3.body.pledge?.minTier === 'yellow');
    const other = await call('POST', '/api/bounty/pledge', { targets: [{ platform: 'twitch', handle: 'lvtarget' }], contributor: 'Gate2', amount: '4', expiresInMs: 86_400_000 }, 'lvfan2');
    ok('C. another account with no preference pledges green', other.status === 200 && other.body.pledge?.minTier === 'green');
    const mine = await call('GET', '/api/bounty/my');
    ok('C. /api/bounty/my carries each pledge\'s tier', mine.body.contributions?.length === 3 && mine.body.contributions.every((c) => ['green', 'yellow'].includes(c.minTier)));
    const pv = await call('GET', '/api/bounty/pool-view?platform=twitch&handle=lvtarget', undefined, null);
    ok('C. pool-view: the tier split (green-only 7 = 3 + 4, yellow-ok 7 = 5 + 2), no liveness before a claim', pv.body.view?.tiers?.greenOnly === 7 && pv.body.view.tiers.yellowOk === 7 && pv.body.liveness === null, JSON.stringify(pv.body.view?.tiers));
  } catch (e) {
    ok(`C. the section ran to the end (it crashed: ${e.stack || e.message})`, false);
  } finally {
    srv?.kill();
  }
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
