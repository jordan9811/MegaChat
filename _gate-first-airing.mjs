/**
 * GATE — E37: an approved pledged clip can actually air.
 *
 * THE DEFECT THIS HOLDS CLOSED. `markPlayed` had no caller anywhere in the
 * repo's history. Nothing turned an APPROVED clip into a playback, production
 * air sessions carried `roomId: null` because the claim page never sent one,
 * and the claim page handed out `?bounty=<airSessionId>` — the form the
 * overlay's own source comments describe as rotting on the next stream. The
 * fan-facing status meanwhile promised "Approved — waits for the streamer to
 * play it on air", with nothing behind it.
 *
 * WHY EVERY EXISTING GATE MISSED IT: `makeClipHooks` finds a session by
 * `s.roomId === roomId`, and every harness creates its session WITH a room id
 * because a test has to set the scene up. The product path is the only caller
 * that passed none, so the one join the product depends on was the one join
 * nothing exercised. This gate therefore opens its session the way the product
 * does — over HTTP, with no room id — and lets the server bind it.
 *
 * Section C is the case nothing covered: a REAL browser overlay, subscribed to
 * the room by the URL the claim page now hands out, rendering a clip that was
 * only ever approved. No admin playback route, no hand-opened window.
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import puppeteer from 'puppeteer-core';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-e37-gate-'));
process.env.DATA_DIR = SCRATCH;
process.env.BOUNTY_CLAIM = '1';

const PORT = 3319;
const APP = `http://localhost:${PORT}`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n── E37: an approved pledged clip can air ───────────────────');

const store = await import('./bounty-store.js');
const escrow = await import('./bounty-escrow.js');
const clips = await import('./bounty-clips.js');
const bank = await import('./bounty-bank.js');
const vis = await import('./overlay-visibility.js');
const rooms = await import('./rooms-store.js');
const { roomOwnerKey } = await import('./auth.js');
const { startGateServer, mintBountyAuth } = await import('./_gate-helpers.mjs');
const { StubSettlement } = await import('./bounty-settlement.js');
store.verifyEvidenceIntegrity();
const quiet = new StubSettlement({ log: { log() {} } });

// 0 = the streamer, 1 = a second streamer (for the ownership refusal),
// 2 = the fan whose money this is. mintBountyAuth numbers them from 1000.
const auth = mintBountyAuth({ handles: ['e37host', 'e37other', 'e37fan'], dataDir: SCRATCH });
const OWNER = roomOwnerKey({ provider: 'twitch', platformId: '1000' });
const OTHER = roomOwnerKey({ provider: 'twitch', platformId: '1001' });
const FAN = 'twitch:1002'; // the account key the fan's cookie resolves to

/** A claimed handle with N paid-for clips, approving the first `approve` of them. */
function pledged(handle, { n = 1, approve = n, contributor = FAN } = {}) {
  escrow.reserve({ platform: 'twitch', handle });
  const key = store.handleKey('twitch', handle);
  const claim = store.createClaim({ handleKey: key, claimant: handle, ttlMs: 1e9 });
  store.updateClaim(claim.id, { verificationState: 'VERIFIED' });
  store.updateReservedHandle(key, { claimedBy: handle });
  for (const to of ['RESERVED', 'CLAIM_PENDING', 'CLAIM_VERIFIED', 'AWAITING_AIRTIME']) {
    escrow.transition({ handleKey: key, to, actor: 'gate' });
  }
  const items = [];
  for (let i = 0; i < n; i++) {
    const { contribution } = escrow.pledge({
      targets: [{ platform: 'twitch', handle }], contributor,
      amount: '100', expiresInMs: 7 * 86_400_000,
    });
    const stored = clips.storeClip({
      handleKey: key, contributionId: contribution.id, contributor,
      mime: 'video/webm', durationS: 4, data: randomBytes(4096),
    });
    if (i < approve) clips.approveClip(stored.clipId, { by: handle });
    items.push({ contribution, clipId: stored.clipId });
  }
  return { key, claim, items };
}

const newRoom = (name, owner) => {
  const r = rooms.createRoom(name, {});
  if (owner) rooms.setRoomOwner(r.id, owner);
  return r.id;
};

// ── A. what the dispatcher will and will not put on air ────────────────────
{
  const room = newRoom('e37 selection', OTHER); // owned by the OTHER streamer
  const sc = pledged('e37sel', { n: 4, contributor: 'twitch:selfan' });
  const session = store.createAirSession({ claimId: sc.claim.id, roomId: room, platform: 'twitch' });
  // a: the plain case. b: refunded. c: already played. d: banked.
  const [a, b, c, d] = sc.items;

  ok('A1 an approved, paid-for, never-aired clip is a first-airing candidate',
    bank.firstAiringCandidates(room).some((x) => x.clipId === a.clipId),
    `${bank.firstAiringCandidates(room).length} candidate(s)`);

  // A clip the streamer never approved, in its own room and session.
  const room2 = newRoom('e37 unapproved', OTHER);
  const sc2 = pledged('e37unapproved', { n: 1, approve: 0, contributor: 'twitch:selfan' });
  store.createAirSession({ claimId: sc2.claim.id, roomId: room2, platform: 'twitch' });
  ok('A2 a clip the streamer has NOT approved is never dispatched',
    bank.firstAiringCandidates(room2).length === 0);

  clips.markPlayed(c.clipId, session.id);
  ok('A3 a clip that has already played is no longer a candidate',
    !bank.firstAiringCandidates(room).some((x) => x.clipId === c.clipId));

  bank._transitionForTests(d.contribution.id, 'QUEUED', {
    clipId: d.clipId, handleKey: sc.key, roomId: room, airSessionId: session.id,
  });
  ok('A4 a BANKED clip is not a first airing — the replay path owns it',
    !bank.firstAiringCandidates(room).some((x) => x.clipId === d.clipId));

  escrow.refund({
    handleKey: sc.key, reason: 'STREAMER_DECLINED', actor: 'gate',
    contributionIds: [b.contribution.id], settlement: quiet,
  });
  ok('A5 a refunded pledge is not dispatched — the fan has their money back',
    !bank.firstAiringCandidates(room).some((x) => x.clipId === b.clipId));

  // Visibility. A first airing needs only "not known hidden"; a replay needs a
  // positive all-clear. A manual-paste room emits nothing at all, and this
  // room is holding a banked clip while it does so.
  const mine = (xs) => xs.filter((x) => x.roomId === room);
  bank.setReplayer(() => ({ ok: true }));
  bank._resetDispatchPacing();
  const noSignal = mine(bank.drain({ now: Date.now() }));
  ok('A6 a room with NO visibility signal still airs a first airing — manual paste must work',
    noSignal.length === 1 && noSignal[0].kind === 'first',
    JSON.stringify(noSignal.map((x) => x.kind)));
  ok('A6 ...and its banked clip stays banked, because nothing confirmed the overlay is back',
    bank.bankRecord(d.contribution.id)?.state === 'QUEUED');

  bank._resetDispatchPacing();
  vis.recordSignal(room, { signal: 'overlay_hidden', reason: 'scene', at: Date.now() });
  ok('A7 a room whose overlay is KNOWN HIDDEN dispatches nothing at all',
    mine(bank.drain({ now: Date.now() })).length === 0);

  bank._resetDispatchPacing();
  vis.recordSignal(room, { signal: 'overlay_visible', at: Date.now() });
  const first = mine(bank.drain({ now: Date.now() }));
  ok('A8 with the overlay confirmed back, the REPLAY goes first — that money is already spent',
    first.length === 1 && first[0].kind === 'replay', JSON.stringify(first.map((x) => x.kind)));
  ok('A9 a second dispatch inside the interval starts nothing',
    mine(bank.drain({ now: Date.now() })).length === 0);
  const later = mine(bank.drain({ now: Date.now() + 10 * 60_000 }));
  ok('A10 once the replay is away, the next tick airs a first airing',
    later.length === 1 && later[0].kind === 'first', JSON.stringify(later.map((x) => x.kind)));

  bank.setReplayer(null);
  bank._resetDispatchPacing();
}

// ── the live scene, seeded BEFORE the server boots ─────────────────────────
const live = newRoom('e37 live room', OWNER);
const strangerRoom = newRoom('someone elses room', OTHER);
// Two pledges; only the FIRST is approved. The second is approved over HTTP in
// section D, so the approve → dispatch path is exercised as the streamer runs it.
const scene = pledged('e37host', { n: 2, approve: 1 });
writeFileSync(path.join(SCRATCH, 'pass.json'), JSON.stringify({
  _comment: 'every sampled frame carries the code',
  defaultAvailable: true, defaultCheck: { found: true, confidence: 0.95, pixelHeight: 40 },
}));

const srv = await startGateServer({
  port: PORT, dataDir: SCRATCH, label: 'e37',
  env: {
    ...auth.env, BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true',
    // The real interval is 20s; the gate must not wait 20s per dispatch.
    BOUNTY_BANK_DRAIN_INTERVAL_MS: '1000',
    BOUNTY_FIXTURE_PATH: path.join(SCRATCH, 'pass.json'),
  },
});

const asHost = { Cookie: auth.cookieFor('e37host') };
const asAdmin = { 'x-bounty-admin-key': auth.adminKey };
const post = (p, body, headers = {}) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p, headers = {}) => fetch(`${APP}${p}`, { headers })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
/** Poll the overlay DOM for the tile this clip renders as. */
const tileUp = async (page, clipId, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const up = await page.evaluate((s) => !!document.querySelector(s), `[data-seat-id="letter:${clipId}"]`);
    if (up) return true;
    await sleep(500);
  }
  return false;
};

let browser = null;
try {
  // ── B. a session is always bound to a room ──────────────────────────────
  const air = await post('/api/bounty/air-session', { claimId: scene.claim.id }, asHost);
  ok('B1 a session opened THE WAY THE CLAIM PAGE OPENS IT — no room id — is bound to a room anyway',
    air.status === 200 && !!air.body.airSession?.roomId,
    `roomId=${air.body.airSession?.roomId ?? 'null'}`);
  ok('B2 it binds to the room this streamer owns — never the shared default room',
    air.body.roomId === live.id || air.body.roomId === live,
    `${air.body.roomId} vs ${live}`);
  ok('B3 the response carries the STABLE overlay address, not the by-id form',
    air.body.overlayPath === `/overlay?room=${live}&bountyRoom=${live}`, air.body.overlayPath);

  const refused = await post('/api/bounty/air-session',
    { claimId: scene.claim.id, roomId: strangerRoom }, asHost);
  ok('B4 a room owned by someone else is refused — clips must not air into a stranger\'s broadcast',
    refused.status === 403, `http ${refused.status} ${refused.body?.reason || ''}`);

  const airSessionId = air.body.airSession.id;

  // ── C. THE CASE NOTHING COVERED ─────────────────────────────────────────
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${APP}${air.body.overlayPath}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(2_000); // let it subscribe as role:overlay

  const firstClip = scene.items[0].clipId;
  ok('C1 an APPROVED clip reaches a real overlay with nothing but the dispatcher driving it',
    await tileUp(page, firstClip), `tile for ${firstClip.slice(0, 8)}…`);
  ok('C2 ...with no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');

  const sessions = await get('/api/bounty/admin/sessions', asAdmin);
  const sess = sessions.body.sessions?.find((s) => s.id === airSessionId);
  const win = (sess?.playbackWindows || []).find((w) => w.clipId === firstClip);
  ok('C3 the airing opened a playback window bound to that clip', !!win, win?.playbackId || 'none');
  ok('C4 ...with a FRESH per-playback nonce, not the bare clip id',
    !!win && win.playbackId.startsWith(`${firstClip}#`), win?.playbackId);
  ok('C5 ...carrying at least one issued code, so the airing is provable',
    (win?.codes?.length || 0) > 0, `${win?.codes?.length || 0} code(s)`);

  // markPlayed — the function that had no caller until this pass.
  const mine = await get('/api/bounty/my', { Cookie: auth.cookieFor('e37fan') });
  const row = (mine.body.contributions || []).find((r) => r.clip?.clipId === firstClip);
  ok('C6 markPlayed FIRED — playCount was permanently 0 for every clip before this',
    (row?.clip?.playCount || 0) >= 1, `playCount=${row?.clip?.playCount ?? 'no row'}`);
  ok('C7 ...so the fan is told it PLAYED, not "waits for the streamer to play it on air"',
    row?.state === 'played', `state=${row?.state}`);

  await sleep(8_000); // let the clip finish
  const v = await post(`/api/bounty/air-session/${airSessionId}/verify`, {}, asHost);
  ok('C8 VERIFICATION SEES THE PLAYBACK — the airing is payable evidence',
    v.status === 200 && (v.body.verification?.verifiedClips || 0) >= 1,
    `result=${v.body.verification?.result} verifiedClips=${v.body.verification?.verifiedClips}`);
  // Fixture frames have no origin, so the tier table sends this to a person —
  // correct existing behaviour, and not E37's business to change. Resolving it
  // is what proves the airing reaches MONEY rather than stopping at evidence.
  ok('C9 ...and a person is asked, rather than it paying on frames of unknown origin',
    v.body.release?.skipped === 'pending_review' && !!v.body.review,
    `skipped=${v.body.release?.skipped}`);
  const resolved = await post(`/api/bounty/admin/reviews/${v.body.review.id}/resolve`,
    { approve: true, reason: 'gate: fixture frames, airing confirmed', actor: 'gate' }, asAdmin);
  // Approving is itself the release — the reviewer's judgement stands in for
  // the confidence floor that could not decide (bounty-routes.js, resolve).
  const paid = resolved.body.release?.released || 0;
  ok('C10 ...the review resolves', resolved.status === 200, `http ${resolved.status}`);
  ok('C11 ...and THEN the pledge PAYS — a first airing reaches the ledger, which is what E37 was blocking',
    paid > 0, `released=${paid}`);

  // ── D. a first airing into a hidden overlay BANKS, not vanishes ─────────
  const secondClip = scene.items[1].clipId;
  const approve = await post(`/api/bounty/clip/${secondClip}/approve`, { by: 'e37host' }, asHost);
  ok('D1 the streamer approves the second clip the way the queue does',
    approve.status === 200 && approve.body.clip?.approval?.state === 'APPROVED');
  ok('D2 ...and it airs, one at a time, without anything else being asked of them',
    await tileUp(page, secondClip), `tile for ${secondClip.slice(0, 8)}…`);
  // Hide the overlay WHILE it is on screen: the bury covers most of the window.
  await post(`/api/rooms/${live}/overlay-visibility`, { signal: 'overlay_hidden', reason: 'scene' }, asHost);
  await sleep(10_000); // let the clip end so onClipEnd runs
  const banked = await get('/api/bounty/bank?platform=twitch&handle=e37host', asHost);
  const rec2 = (banked.body.records || []).find((r) => r.clipId === secondClip);
  ok('D3 a clip buried mid-airing BANKS instead of vanishing — Session 2\'s path, entered from the front',
    rec2?.state === 'QUEUED', `state=${rec2?.state ?? 'no record'}`);

  // ── E. one payable airing per pledge, however it got on air ─────────────
  const again = await post(`/api/bounty/air-session/${airSessionId}/verify`, {}, asHost);
  ok('E1 re-verifying the same session pays nothing further',
    (again.body.release?.released || 0) === 0,
    `released=${again.body.release?.released} deduped=${again.body.release?.deduped}`);
  const pool = await get('/api/bounty/pool?platform=twitch&handle=e37host');
  const released = pool.body?.pool?.releasedContributor ?? pool.body?.releasedContributor;
  ok('E2 the LEDGER carries exactly that one release — a first airing does not pay twice',
    released === paid && paid > 0, `pool=${released} paid=${paid}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
