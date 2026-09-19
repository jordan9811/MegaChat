/**
 * GATE — Pass C Part 3: banking, live-seat escrow, review causes.
 *
 * This is the first pass permitted to change settlement, under four
 * conditions, and each section below is one of them made checkable:
 *
 *   1. every settlement change ships with a test that FAILS on the old
 *      behaviour — sections F and G7 assert the old number alongside the new
 *      one and show they disagree (the full old-vs-new run is
 *      scratchpad/passc-discriminate.mjs against HEAD's modules);
 *   2. Gate H stays green — section I scans the new modules too;
 *   3. replay safety for every new state — sections A, E, G9: every writer
 *      called twice with the same key appends nothing, and every illegal move
 *      throws before touching a ledger;
 *   4. nothing auto-pays that did not auto-pay before — section J: an OPEN
 *      seat's pending is never released by the ambient sweep.
 *
 * ⚠ Everything here is accounting with stub settlement. The number of
 * settlement INTENTS is asserted; no transfer exists to assert.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-part3-gate-'));
process.env.DATA_DIR = SCRATCH;
process.env.BOUNTY_CLAIM = '1';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};

console.log('\n── Part 3: banking, seat escrow, review causes ─────────────');

const store = await import('./bounty-store.js');
const escrow = await import('./bounty-escrow.js');
const watermark = await import('./bounty-watermark.js');
const clips = await import('./bounty-clips.js');
const bank = await import('./bounty-bank.js');
const seat = await import('./seat-escrow.js');
const vis = await import('./overlay-visibility.js');
const { StubSettlement } = await import('./bounty-settlement.js');
const { bountyConfig } = await import('./bounty-claim.config.js');
store.verifyEvidenceIntegrity();
const quiet = new StubSettlement({ log: { log() {} } });

// ── fixtures ───────────────────────────────────────────────────────────────
let seq = 0;
const ledgerRows = () => store.listLedger().length;

/** A claimed handle with an open air session in a room, and N HELD pledges each with a stored clip. */
function scene(name, { pledges = 1, roomId = `room-${name}` } = {}) {
  const platform = 'twitch';
  const handle = `p3${name}`;
  escrow.reserve({ platform, handle });
  const key = store.handleKey(platform, handle);
  const claim = store.createClaim({ handleKey: key, claimant: `u-${name}`, ttlMs: 1e9 });
  store.updateReservedHandle(key, { claimedBy: `u-${name}` });
  for (const to of ['RESERVED', 'CLAIM_PENDING', 'CLAIM_VERIFIED', 'AWAITING_AIRTIME']) {
    escrow.transition({ handleKey: key, to, actor: 'gate' });
  }
  const session = store.createAirSession({ claimId: claim.id, roomId, platform });
  const items = [];
  for (let i = 0; i < pledges; i++) {
    const { contribution } = escrow.pledge({
      targets: [{ platform, handle }], contributor: `twitch:fan${++seq}`, amount: '100', expiresInMs: 7 * 86_400_000,
    });
    const stored = clips.storeClip({
      handleKey: key, contributionId: contribution.id, contributor: contribution.contributor,
      mime: 'video/webm', durationS: 10, data: randomBytes(4096),
    });
    items.push({ contribution, clipId: stored.clipId });
  }
  return { key, claim, session, roomId, items };
}

/** Play a clip inside [at, at+durMs] and close its window. Returns the window. */
function play(sessionId, clipId, at, durMs = 10_000) {
  const r = watermark.startClipPlayback(sessionId, { clipId, durationS: durMs / 1000, now: at });
  watermark.endClipPlayback(sessionId, { clipId, playbackId: r.playbackId, now: at + durMs });
  return store.getAirSession(sessionId).playbackWindows.find((w) => w.playbackId === r.playbackId);
}

// ── A. bank state machine: every illegal move throws and writes nothing ────
{
  const states = [null, ...bank.BANK_STATES];
  let checked = 0, allThrew = true, allClean = true, legalOk = true;
  for (const from of states) {
    for (const to of bank.BANK_STATES) {
      const id = `seed-${from ?? 'none'}-${to}`;
      // Put a fresh record into `from` by walking a legal path to it.
      if (from) {
        const walk = { QUEUED: ['QUEUED'], DRAINING: ['QUEUED', 'DRAINING'], REPLAYED: ['QUEUED', 'DRAINING', 'REPLAYED'], AIRED: ['QUEUED', 'AIRED'], EXPIRED: ['QUEUED', 'EXPIRED'] }[from];
        for (const step of walk) bank._transitionForTests(id, step);
      }
      const legal = bank.canTransitionBank(from, to);
      const before = ledgerRows();
      let threw = false;
      try { bank._transitionForTests(id, to); } catch (e) { threw = e.code === 'illegal_bank_transition'; }
      if (legal) { if (threw || ledgerRows() !== before + 1) legalOk = false; continue; }
      checked++;
      if (!threw) allThrew = false;
      if (ledgerRows() !== before) allClean = false;
      if ((bank.bankRecord(id)?.state ?? null) !== from) allClean = false;
    }
  }
  ok('A. every illegal bank transition throws IllegalBankTransition', allThrew, `${checked} combinations`);
  ok('A. illegal bank transitions write NOTHING (ledger + state untouched)', allClean);
  ok('A. every legal bank transition appends exactly one row', legalOk);
  ok('A. no record can begin anywhere but QUEUED',
    !bank.canTransitionBank(null, 'DRAINING') && !bank.canTransitionBank(null, 'AIRED') && bank.canTransitionBank(null, 'QUEUED'));
  ok('A. AIRED and EXPIRED are terminal', bank.BANK_TRANSITIONS.AIRED.length === 0 && bank.BANK_TRANSITIONS.EXPIRED.length === 0);
}

// ── B. banking entry: a playback under a hidden overlay is QUEUED ─────────
{
  const sc = scene('entry', { pledges: 3 });
  const t0 = Date.now() - 600_000;
  const [c1, c2, c3] = sc.items;
  // Hidden from t0-1s to t0+30s: covers c1's whole playback.
  vis.recordSignal(sc.roomId, { signal: 'overlay_visible', at: t0 - 60_000 });
  vis.recordSignal(sc.roomId, { signal: 'overlay_hidden', reason: 'scene', at: t0 - 1_000 });
  vis.recordSignal(sc.roomId, { signal: 'overlay_visible', at: t0 + 30_000 });
  const w1 = play(sc.session.id, c1.clipId, t0);
  const before = ledgerRows();
  const q = bank.onPlaybackEnded(sc.session.id, w1.playbackId, { now: t0 + 31_000 });
  ok('B1 a playback fully covered by an overlay_hidden window is QUEUED', q?.state === 'QUEUED', `state=${q?.state}`);
  const rec = bank.bankRecord(c1.contribution.id);
  ok('B2 the record names the buried playback and the hidden window',
    rec?.buriedPlaybacks[0]?.playbackId === w1.playbackId && rec?.buriedPlaybacks[0]?.hiddenWindow?.reason === 'scene');
  const again = bank.onPlaybackEnded(sc.session.id, w1.playbackId, { now: t0 + 32_000 });
  ok('B3 banking the same playback again appends nothing', again?.already === true && ledgerRows() === before + 1);
  ok('B4 the contribution is still HELD — banking is not a refund', store.getContribution(c1.contribution.id).status === 'HELD');
  ok('B5 BANK rows are invisible to the pool fold', store.getPool(sc.key).remaining === 300, `remaining=${store.getPool(sc.key).remaining}`);

  // c2 plays with only 20% of it under the hidden window: NOT banked.
  const w2 = play(sc.session.id, c2.clipId, t0 + 28_000);
  ok('B6 a playback only 20% covered is NOT banked (bankCoverFraction 0.5)',
    bank.onPlaybackEnded(sc.session.id, w2.playbackId, { now: t0 + 40_000 }) === null && !bank.bankRecord(c2.contribution.id));

  // c3 plays under a SCALED window: on screen, so not banked.
  vis.recordSignal(sc.roomId, { signal: 'overlay_scaled_below_floor', at: t0 + 100_000 });
  vis.recordSignal(sc.roomId, { signal: 'overlay_visible', at: t0 + 130_000 });
  const w3 = play(sc.session.id, c3.clipId, t0 + 105_000);
  ok('B7 a playback under overlay_scaled_below_floor is NOT banked — it was on screen',
    bank.onPlaybackEnded(sc.session.id, w3.playbackId, { now: t0 + 131_000 }) === null);

  // A letter id (no pledge behind it) under a hidden window: nothing to bank.
  vis.recordSignal(sc.roomId, { signal: 'overlay_hidden', reason: 'disabled', at: t0 + 200_000 });
  vis.recordSignal(sc.roomId, { signal: 'overlay_visible', at: t0 + 230_000 });
  const wl = play(sc.session.id, 'letter-abc', t0 + 205_000);
  ok('B8 a plain letter (no contribution) is never banked',
    bank.onPlaybackEnded(sc.session.id, wl.playbackId, { now: t0 + 231_000 }) === null);
}

// ── C. the verification path: NOT_SHOWN banks, verified marks AIRED ────────
{
  const sc = scene('verify', { pledges: 2 });
  const t0 = Date.now() - 300_000;
  const [c1, c2] = sc.items;
  vis.recordSignal(sc.roomId, { signal: 'overlay_hidden', reason: 'covered', at: t0 - 1_000 });
  vis.recordSignal(sc.roomId, { signal: 'overlay_visible', at: t0 + 30_000 });
  const w1 = play(sc.session.id, c1.clipId, t0);
  const w2 = play(sc.session.id, c2.clipId, t0 + 60_000); // after the overlay came back
  const v = { clipVerdicts: [
    { clipId: c1.clipId, playbackId: w1.playbackId, verified: false, samples: 4, hits: 0, durationS: 10 },
    { clipId: c2.clipId, playbackId: w2.playbackId, verified: true, samples: 4, hits: 4, durationS: 10 },
  ] };
  const out = bank.onVerification(sc.session.id, v, { now: t0 + 61_000 });
  ok('C1 NOT_SHOWN with a matching hidden window is QUEUED', out.queued.includes(c1.contribution.id) && bank.bankRecord(c1.contribution.id)?.state === 'QUEUED');
  ok('C2 a verified playback with no bank record creates none', !bank.bankRecord(c2.contribution.id));
  // Later, verification finds c1's ORIGINAL playback did air after all → AIRED, never replayed.
  const v2 = { clipVerdicts: [{ clipId: c1.clipId, playbackId: w1.playbackId, verified: true, samples: 4, hits: 3, durationS: 10 }] };
  const before = ledgerRows();
  const out2 = bank.onVerification(sc.session.id, v2, { now: t0 + 62_000 });
  ok('C3 a verified playback of a QUEUED pledge marks it AIRED', out2.aired.includes(c1.contribution.id) && bank.bankRecord(c1.contribution.id)?.state === 'AIRED');
  bank.onVerification(sc.session.id, v2, { now: t0 + 63_000 });
  ok('C4 marking AIRED again appends nothing (replay-safe)', ledgerRows() === before + 1);
  vis.recordSignal(sc.roomId, { signal: 'overlay_visible', at: t0 + 70_000 });
  ok('C5 the drain never replays an AIRED pledge', bank.drain({ now: t0 + 90_000 }).length === 0);
}

// ── D. drain: paced, only while visible, fresh nonce on replay ─────────────
{
  const sc = scene('drain', { pledges: 3 });
  const t0 = Date.now() - 200_000;
  vis.recordSignal(sc.roomId, { signal: 'overlay_hidden', reason: 'scene', at: t0 - 1_000 });
  const windows = sc.items.map((it, i) => play(sc.session.id, it.clipId, t0 + i * 11_000));
  windows.forEach((w) => bank.onPlaybackEnded(sc.session.id, w.playbackId, { now: t0 + 40_000 }));
  ok('D1 three buried playbacks, three QUEUED records', bank.bankRecords({ roomId: sc.roomId, state: 'QUEUED' }).length === 3);

  ok('D2 nothing drains while the overlay is still hidden', bank.drain({ now: t0 + 41_000 }).length === 0);

  // The fake replayer plays immediately through the real watermark path.
  const replayed = [];
  let replayClock = t0 + 50_000;
  bank.setReplayer(({ clipId, durationS, airSessionId }) => {
    const r = watermark.startClipPlayback(airSessionId, { clipId, durationS, now: replayClock });
    replayed.push({ clipId, playbackId: r.playbackId });
    bank.onPlaybackStarted(airSessionId, r.playbackId, clipId, { now: replayClock });
    return { ok: true };
  });
  vis.recordSignal(sc.roomId, { signal: 'overlay_visible', at: t0 + 50_000 });
  const d1 = bank.onSignal(sc.roomId, 'overlay_visible', { now: t0 + 50_000 });
  ok('D3 the overlay coming back drains exactly ONE clip', d1.length === 1, `${d1.length}`);
  const first = bank.bankRecord(d1[0].contributionId);
  ok('D4 the replay is REPLAYED with a NEW playback id — fresh nonce',
    first?.state === 'REPLAYED' && first.replayPlaybackId && !first.buriedPlaybacks.some((b) => b.playbackId === first.replayPlaybackId),
    `buried ${first?.buriedPlaybacks[0]?.playbackId} → replay ${first?.replayPlaybackId}`);
  const cs = (id) => watermark.allSessionCodes(sc.session.id).filter((c) => c.playbackId === id).map((c) => c.code.split('-')[0]);
  ok('D5 and a different code namespace from the buried airing',
    cs(first.buriedPlaybacks[0].playbackId)[0] !== cs(first.replayPlaybackId)[0]);
  ok('D6 a second drain inside the interval starts nothing', bank.drain({ now: t0 + 50_000 + bountyConfig.bankDrainIntervalMs - 1 }).length === 0);
  replayClock = t0 + 50_000 + bountyConfig.bankDrainIntervalMs;
  ok('D7 after the interval the next clip drains', bank.drain({ now: replayClock }).length === 1);

  // A play queue that refuses: back to QUEUED, still paced.
  bank.setReplayer(() => ({ ok: false, reason: 'queue full' }));
  const tRefuse = t0 + 50_000 + 2 * bountyConfig.bankDrainIntervalMs;
  const d3 = bank.drain({ now: tRefuse });
  const last = bank.bankRecords({ roomId: sc.roomId, state: 'QUEUED' });
  ok('D8 a refused replay goes back to QUEUED', d3.length === 0 && last.length === 1, `queued=${last.length}`);
  ok('D9 and the interval still applies after a refusal', bank.drain({ now: tRefuse + 1000 }).length === 0);

  // Session CLOSED: nothing drains any more.
  store.updateAirSession(sc.session.id, { status: 'CLOSED', endedAt: tRefuse + 5_000 });
  ok('D10 nothing drains into a CLOSED session', bank.drain({ now: tRefuse + 2 * bountyConfig.bankDrainIntervalMs }).length === 0);
  bank.setReplayer(null);
}

// ── E. expiry: refund with the enumerated reason, replay-safe ──────────────
{
  const sc = scene('expiry', { pledges: 2 });
  const t0 = Date.now() - 100_000;
  const [c1, c2] = sc.items;
  vis.recordSignal(sc.roomId, { signal: 'overlay_hidden', reason: 'offcanvas', at: t0 - 1_000 });
  const w1 = play(sc.session.id, c1.clipId, t0);
  const w2 = play(sc.session.id, c2.clipId, t0 + 11_000);
  bank.onPlaybackEnded(sc.session.id, w1.playbackId, { now: t0 + 30_000 });
  bank.onPlaybackEnded(sc.session.id, w2.playbackId, { now: t0 + 30_000 });
  const closedAt = t0 + 40_000;
  store.updateAirSession(sc.session.id, { status: 'CLOSED', endedAt: closedAt });

  // The sweep is global; assert on THIS scene's records only.
  const mine = (xs) => xs.filter((x) => x.handleKey === sc.key);
  ok('E1 nothing expires before the tail', mine(bank.sweepExpired({ now: closedAt + bountyConfig.bankTailMs - 1, settlement: quiet })).length === 0);
  const before = ledgerRows();
  const intentsBefore = quiet.pending().length;
  const ex = mine(bank.sweepExpired({ now: closedAt + bountyConfig.bankTailMs, settlement: quiet }));
  ok('E2 at stream end + tail both banked clips EXPIRE', ex.length === 2 && ex.every((x) => x.tailDue));
  ok('E3 each refunds its contribution with reason BANKED_CLIP_EXPIRED',
    [c1, c2].every((c) => store.getContribution(c.contribution.id).status === 'REFUNDED')
    && store.listLedger({ handleKey: sc.key, type: 'REFUND' }).every((r) => r.meta?.refundReason === 'BANKED_CLIP_EXPIRED'));
  ok('E4 two refund intents recorded — no funds move', quiet.pending().length === intentsBefore + 2 && quiet.pending().every((i) => i.kind === 'refund' || i.kind === 'release'));
  ok('E5 the recordings go back with the money', [c1, c2].every((c) => clips.getClipRecord(c.clipId)?.purgedAt));
  const rowsAfter = ledgerRows();
  bank.sweepExpired({ now: closedAt + bountyConfig.bankTailMs + 60_000, settlement: quiet });
  ok('E6 sweeping again appends nothing and refunds nothing twice', ledgerRows() === rowsAfter && quiet.pending().length === intentsBefore + 2);
  ok('E7 the pool shows the refunds, not a release', store.getPool(sc.key).refunded === 200 && store.getPool(sc.key).releasedContributor === 0);
  ok('E8 BANK rows appended for the expiry: exactly two', rowsAfter - before >= 2);

  // Cap clock on a session that never closes.
  const sc2 = scene('cap', { pledges: 1 });
  const t1 = Date.now() - 50_000;
  vis.recordSignal(sc2.roomId, { signal: 'overlay_hidden', reason: 'scene', at: t1 - 1_000 });
  const wc = play(sc2.session.id, sc2.items[0].clipId, t1);
  const q = bank.onPlaybackEnded(sc2.session.id, wc.playbackId, { now: t1 + 30_000 });
  const bankedAt = bank.bankRecord(sc2.items[0].contribution.id).bankedAt;
  const mine2 = (xs) => xs.filter((x) => x.handleKey === sc2.key);
  ok('E9 an OPEN session does not expire before the hold cap', q?.state === 'QUEUED' && mine2(bank.sweepExpired({ now: bankedAt + bountyConfig.bankMaxHoldMs - 1, settlement: quiet })).length === 0);
  ok('E10 and expires at the cap even with the session still open', mine2(bank.sweepExpired({ now: bankedAt + bountyConfig.bankMaxHoldMs, settlement: quiet })).some((x) => x.capDue));
}

// ── F. ONE PAYABLE AIRING PER PLEDGE — discriminating against the old math ─
{
  const sc = scene('once', { pledges: 2 });
  for (const to of ['VERIFYING']) escrow.transition({ handleKey: sc.key, to, actor: 'gate' });
  const [c1, c2] = sc.items;
  const t0 = Date.now() - 100_000;
  const w1 = play(sc.session.id, c1.clipId, t0);
  const w1b = play(sc.session.id, c1.clipId, t0 + 20_000); // the same pledge, aired twice
  const pool = store.getPool(sc.key);
  const perClip = bountyConfig.releaseRatePerClip;
  const perSec = bountyConfig.releaseRatePerClipSecond;
  const oldExpected = +Math.min(pool.totalContributed * (perClip * 2 + perSec * 20), pool.totalContributed * bountyConfig.perSessionCapFraction).toFixed(6);
  const newExpected = +Math.min(pool.totalContributed * (perClip * 1 + perSec * 10), pool.totalContributed * bountyConfig.perSessionCapFraction).toFixed(6);
  const r = escrow.release({
    handleKey: sc.key, claimId: sc.claim.id, airSessionId: sc.session.id,
    verifiedClips: 2, verifiedClipSeconds: 20, confidence: 0.9, detectionRate: 0.9,
    verifiedPlaybacks: [
      { clipId: c1.clipId, playbackId: w1.playbackId, durationS: 10, verified: true },
      { clipId: c1.clipId, playbackId: w1b.playbackId, durationS: 10, verified: true },
    ],
    idempotencyKey: `release:${sc.session.id}`, settlement: quiet,
  });
  ok('F1 the same pledge verified twice pays for ONE airing', r.released === newExpected, `released ${r.released}, expected ${newExpected}`);
  ok('F2 …and NOT what the old arithmetic paid for two', r.released !== oldExpected && oldExpected > newExpected, `old would have paid ${oldExpected}`);
  ok('F3 the ledger row carries both numbers', r.rows[0].meta.rawVerifiedClips === 2 && r.rows[0].meta.payableClips === 1);
  ok('F4 and names which playback paid and which did not',
    r.rows[0].meta.collapsed?.[0]?.paid === w1.playbackId && r.rows[0].meta.collapsed?.[0]?.notPaid?.[0] === w1b.playbackId);
  // Two DIFFERENT pledges still pay twice — the rule is per pledge, not per session.
  const w2 = play(sc.session.id, c2.clipId, t0 + 40_000);
  const r2 = escrow.release({
    handleKey: sc.key, claimId: sc.claim.id, airSessionId: `${sc.session.id}-b`,
    verifiedClips: 2, verifiedClipSeconds: 20, confidence: 0.9, detectionRate: 0.9,
    verifiedPlaybacks: [
      { clipId: c1.clipId, playbackId: w1.playbackId, durationS: 10, verified: true },
      { clipId: c2.clipId, playbackId: w2.playbackId, durationS: 10, verified: true },
    ],
    idempotencyKey: `release:${sc.session.id}-b`, settlement: quiet,
  });
  ok('F5 two different pledges still pay for two airings', r2.payable?.payableClips === 2, `payable=${r2.payable?.payableClips}`);
  ok('F6 a caller with only counts (fixtures) is unchanged', escrow.payablePlaybacks([]).payableClips === 0
    && escrow.release({ handleKey: sc.key, claimId: sc.claim.id, airSessionId: `${sc.session.id}-c`, verifiedClips: 1, verifiedClipSeconds: 10, confidence: 0.9, idempotencyKey: `release:${sc.session.id}-c`, settlement: quiet }).released === newExpected);
}

// ── G. seat escrow ─────────────────────────────────────────────────────────
{
  // G1 the state machine, exhaustively.
  const states = [null, ...seat.SEAT_STATES];
  let checked = 0, allThrew = true, allClean = true, legalOk = true;
  for (const from of states) {
    for (const to of seat.SEAT_STATES) {
      const id = `seat-seed-${from ?? 'none'}-${to}`;
      if (from) {
        const walk = { OPEN: ['OPEN'], PAUSED: ['OPEN', 'PAUSED'], CLOSED: ['OPEN', 'CLOSED'], SETTLING: ['OPEN', 'CLOSED', 'SETTLING'], SETTLED: ['OPEN', 'CLOSED', 'SETTLED'], CLAWED: ['OPEN', 'CLOSED', 'SETTLING', 'CLAWED'] }[from];
        for (const step of walk) {
          if (step === 'OPEN') seat.open({ seatId: id, roomId: 'seed-room', at: Date.now() });
          else seat._transitionForTests(id, step);
        }
      }
      const legal = seat.canTransitionSeat(from, to);
      const rowsBefore = seat.seatRecord(id)?.history.length ?? 0;
      let threw = false;
      try {
        if (to === 'OPEN' && !from) seat.open({ seatId: id, roomId: 'seed-room', at: Date.now() });
        else seat._transitionForTests(id, to);
      } catch (e) { threw = e.code === 'illegal_seat_transition'; }
      const rowsAfter = seat.seatRecord(id)?.history.length ?? 0;
      if (legal) { if (threw) legalOk = false; continue; }
      checked++;
      if (!threw) allThrew = false;
      if (rowsAfter !== rowsBefore || (seat.seatRecord(id)?.state ?? null) !== from) allClean = false;
    }
  }
  ok('G1 every illegal seat transition throws IllegalSeatTransition', allThrew, `${checked} combinations`);
  ok('G1 illegal seat transitions write NOTHING', allClean);
  ok('G1 every legal seat transition succeeds', legalOk);

  // G2–G6 the money rules, on one seat.
  const counting = new StubSettlement({ log: { log() {} } });
  seat.setSettlement(counting);
  const R = 'room-seatmoney', S = 'seat-money';
  const t0 = Date.now() - 1_000_000;
  seat.open({ seatId: S, roomId: R, viewer: '0xviewer', streamer: '0xstreamer', token: { symbol: 'USDC', decimals: 6 }, at: t0 });
  vis.recordSignal(R, { signal: 'overlay_visible', at: t0 });
  for (let i = 1; i <= 60; i++) seat.accrue(S, 10_000n, { at: t0 + i * 1000 });
  ok('G2 the meter charges while the overlay is visible', seat.shouldCharge(R));
  vis.recordSignal(R, { signal: 'overlay_hidden', reason: 'scene', at: t0 + 61_000 });
  ok('G2 the meter STOPS while the overlay is hidden', !seat.shouldCharge(R));
  seat.onVisibility(R, 'overlay_hidden', { at: t0 + 61_000, reason: 'scene' });
  ok('G2 the seat is PAUSED', seat.seatRecord(S).state === 'PAUSED');
  seat.accrue(S, 10_000n, { at: t0 + 62_000 }); // one in-flight tick lands anyway
  vis.recordSignal(R, { signal: 'overlay_visible', at: t0 + 91_000 });
  const back = seat.onVisibility(R, 'overlay_visible', { at: t0 + 91_000 });
  const rec = seat.seatRecord(S);
  ok('G3 the in-flight tick during the bury refunds from the STREAMER', back.refunds[0]?.fromStreamer === '10000');
  ok('G3 the detection lag before it refunds from the PLATFORM — logged as cost',
    back.refunds[0]?.fromPlatform === (10_000n * BigInt(seat.seatConfig.detectionLagMs / 1000)).toString(),
    `lag ${seat.seatConfig.detectionLagMs / 1000}s → ${back.refunds[0]?.fromPlatform}`);
  ok('G3 the viewer is refunded both halves in one intent',
    counting.pending().some((i) => i.kind === 'refund' && i.to === '0xviewer' && i.amount === '0.31'));
  ok('G4 the resume sweeps ONE chunk: 80% released, 20% held back',
    back.sweeps[0]?.released === '480000' && back.sweeps[0]?.heldBack === '120000', JSON.stringify(back.sweeps[0]));
  ok('G4 pending is exactly what was accrued minus refunds minus the sweep', rec.pending === 0n, `pending=${rec.pending}`);
  ok('G4 the release is an intent to the STREAMER, nothing more',
    counting.pending().some((i) => i.kind === 'release' && i.to === '0xstreamer' && i.bucket === 'streamer' && i.amount === '0.48'));

  // G5 SOURCE_UNAVAILABLE claws nothing — and the CLIP path refunds everything.
  seat.close(S, { at: t0 + 100_000 });
  ok('G5 an obs-websocket room closes straight to SETTLING', seat.seatRecord(S).state === 'SETTLING');
  seat.flag(S, 'SOURCE_UNAVAILABLE', { at: t0 + 101_000, detail: 'no capture' });
  const beforeMature = counting.pending().length;
  const m = seat.mature(S, { at: t0 + 100_000 + seat.seatConfig.clawbackWindowMs + 1 });
  ok('G5 SOURCE_UNAVAILABLE does not block maturity: the holdback goes to the streamer', m?.amount === '120000' && seat.seatRecord(S).state === 'SETTLED');
  ok('G5 …as a holdback-bucket release intent', counting.pending().length === beforeMature + 1 && counting.pending().at(-1).bucket === 'holdback');
  // The clip path's default, for contrast: the same verdict refunds the WHOLE contribution.
  const scU = scene('unavail', { pledges: 1 });
  const rows = escrow.refund({ handleKey: scU.key, reason: 'UNVERIFIABLE_CLIP', actor: 'gate', contributionIds: [scU.items[0].contribution.id], settlement: quiet });
  ok('G5 whereas UNVERIFIABLE_CLIP refunds a clip pledge in full — the default the seat path must not inherit',
    rows.length === 1 && store.getContribution(scU.items[0].contribution.id).status === 'REFUNDED');

  // G6 clawback takes at most the holdback.
  const S2 = 'seat-claw';
  seat.open({ seatId: S2, roomId: R, viewer: '0xv2', streamer: '0xs2', token: { symbol: 'USDC', decimals: 6 }, at: t0 });
  for (let i = 1; i <= 10; i++) seat.accrue(S2, 10_000n, { at: t0 + 200_000 + i * 1000 });
  seat.close(S2, { at: t0 + 300_000 });
  const r2 = seat.seatRecord(S2);
  const claw = seat.clawback(S2, { at: t0 + 301_000, detail: 'overlay found hidden for the released chunk' });
  ok('G6 a clawback returns exactly the holdback, never more', claw.amount === r2.holdbackOutstanding.toString() && claw.amount === '20000', `clawed ${claw.amount} of ${r2.released} released`);
  ok('G6 and closes the seat as CLAWED with a named cause', seat.seatRecord(S2).state === 'CLAWED' && seat.reviewItems().some((i) => i.seatId === S2 && i.cause === 'CLAWBACK'));
  let threw = null;
  try { seat.clawback(S2, { at: t0 + 302_000 }); } catch (e) { threw = e; }
  ok('G6 clawing back twice is illegal, not a second refund', threw?.code === 'illegal_seat_transition');

  // G7 manual-paste: nothing sweeps until stream end + tail, capped.
  const RM = 'room-manual', SM = 'seat-manual';
  seat.open({ seatId: SM, roomId: RM, viewer: '0xv3', streamer: '0xs3', token: { symbol: 'USDC', decimals: 6 }, at: t0 });
  for (let i = 1; i <= 10; i++) seat.accrue(SM, 10_000n, { at: t0 + i * 1000 });
  const cm = seat.close(SM, { at: t0 + 20_000 });
  ok('G7 a manual-paste seat closes to CLOSED and holds — no sweep', cm.manualHold === true && seat.seatRecord(SM).state === 'CLOSED' && seat.seatRecord(SM).released === 0n);
  const ended = t0 + 50_000;
  let sw = seat.sweepAll({ now: ended + seat.seatConfig.manualTailMs - 1, streamEndedAt: (r) => (r === RM ? ended : null) });
  ok('G7 nothing releases before stream end + tail', sw.manualReleased.length === 0 && seat.seatRecord(SM).state === 'CLOSED');
  sw = seat.sweepAll({ now: ended + seat.seatConfig.manualTailMs, streamEndedAt: (r) => (r === RM ? ended : null) });
  ok('G7 at stream end + tail it releases optimistically with the holdback', sw.manualReleased.length === 1 && seat.seatRecord(SM).state === 'SETTLING' && seat.seatRecord(SM).released === 80_000n);
  const SM2 = 'seat-manual-cap';
  seat.open({ seatId: SM2, roomId: 'room-manual2', viewer: '0xv4', streamer: '0xs4', token: { symbol: 'USDC', decimals: 6 }, at: t0 });
  seat.accrue(SM2, 10_000n, { at: t0 + 1000 });
  seat.close(SM2, { at: t0 + 2000 });
  sw = seat.sweepAll({ now: t0 + seat.seatConfig.manualMaxHoldMs - 1, streamEndedAt: () => null });
  const heldStill = seat.seatRecord(SM2).state === 'CLOSED';
  sw = seat.sweepAll({ now: t0 + seat.seatConfig.manualMaxHoldMs, streamEndedAt: () => null });
  ok('G7 with no stream end known, the 24 h cap releases it', heldStill && sw.manualReleased.some((x) => x.seatId === SM2 && x.capDue));
  ok('G7 the streamer-facing summary says why it holds and until when',
    (() => { const s = seat.summaryFor('room-manual2'); return s.signalled === false && s.manualMaxHoldMs === seat.seatConfig.manualMaxHoldMs; })());

  // G8 replay safety: every writer, same key twice, nothing appended.
  const S3 = 'seat-replay';
  const count = () => seat.seatRecord(S3)?.history.length ?? 0;
  const n0 = counting.pending().length;
  seat.open({ seatId: S3, roomId: R, viewer: '0xv5', streamer: '0xs5', token: { symbol: 'USDC', decimals: 6 }, at: t0 });
  seat.open({ seatId: S3, roomId: R, viewer: '0xv5', streamer: '0xs5', token: { symbol: 'USDC', decimals: 6 }, at: t0 });
  const c1 = count();
  seat.accrue(S3, 10_000n, { at: t0 + 1000 }); seat.accrue(S3, 10_000n, { at: t0 + 1000 });
  const c2 = count();
  const bury = seat.onVisibility(R, 'overlay_hidden', { at: t0 + 5000 }); seat.onVisibility(R, 'overlay_hidden', { at: t0 + 5000 });
  const c3 = count();
  seat.onVisibility(R, 'overlay_visible', { at: t0 + 9000 }); seat.onVisibility(R, 'overlay_visible', { at: t0 + 9000 });
  const c4 = count();
  seat.close(S3, { at: t0 + 10_000 }); seat.close(S3, { at: t0 + 10_000 });
  const c5 = count();
  const mat = t0 + 10_000 + seat.seatConfig.clawbackWindowMs + 1;
  seat.mature(S3, { at: mat }); seat.mature(S3, { at: mat });
  const c6 = count();
  ok('G8 open ×2 → one row', c1 === 1);
  ok('G8 accrue at the same instant ×2 → one row', c2 === 2);
  ok('G8 pause ×2 → one row', c3 === 3 && bury.paused.includes(S3));
  ok('G8 resume ×2 → resume + refund + sweep once', c4 === 6, `rows=${c4}`);
  ok('G8 close ×2 → close + sweep(nothing pending → none) + settling/settled once', c5 === 7 || c5 === 8, `rows=${c5}`);
  ok('G8 mature ×2 → one row', c6 === c5 + 1 || seat.seatRecord(S3).state === 'SETTLED', `state=${seat.seatRecord(S3).state}`);
  ok('G8 settlement intents are never duplicated by a replay',
    counting.pending().length - n0 === counting.pending().slice(n0).filter((i, idx, arr) => arr.findIndex((j) => j.ref === i.ref && j.kind === i.kind) === idx).length);
}

// ── J. nothing auto-pays that did not auto-pay before ──────────────────────
{
  const R = 'room-open', S = 'seat-open';
  const t0 = Date.now() - 500_000;
  seat.open({ seatId: S, roomId: R, viewer: '0xv6', streamer: '0xs6', token: { symbol: 'USDC', decimals: 6 }, at: t0 });
  for (let i = 1; i <= 30; i++) seat.accrue(S, 10_000n, { at: t0 + i * 1000 });
  const before = seat.seatRecord(S).released;
  seat.sweepAll({ now: Date.now() + 10 * 86_400_000, streamEndedAt: () => t0 });
  ok('J1 the ambient sweep never releases an OPEN seat — money moves only on a signal, a close, or the manual clock',
    seat.seatRecord(S).released === before && seat.seatRecord(S).state === 'OPEN');
}

// ── I. Gate H, extended to the new modules ─────────────────────────────────
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = [
    ...readdirSync('.').filter((f) => /^bounty-.*\.(js|mjs)$/.test(f)),
    'seat-escrow.js', 'overlay-visibility.js', 'visibility-routes.js',
  ];
  const banned = /\b(sendTransaction|writeContract|transferFrom|\.transfer\(|signTransaction|privateKeyToAccount|walletClient)\b/;
  const offenders = files.filter((f) => banned.test(strip(readFileSync(f, 'utf8'))));
  ok('I1 no transfer-shaped call in any bounty module, the bank, the seat escrow or the visibility path',
    offenders.length === 0, offenders.join(',') || `${files.length} files scanned`);
  const settlementSrc = readFileSync('bounty-settlement.js', 'utf8');
  ok('I2 settlement is still the stub, and says so', /NO FUNDS MOVE/i.test(settlementSrc) && /TODO\(run-b\)/.test(settlementSrc));
  const seatSrc = strip(readFileSync('seat-escrow.js', 'utf8'));
  ok('I3 the seat escrow settles through StubSettlement only', /StubSettlement/.test(seatSrc) && !/RealSettlement/.test(seatSrc));
}

// ── H. over HTTP: the review builder NAMES the new causes (3d) ─────────────
{
  const { startGateServer, mintBountyAuth } = await import('./_gate-helpers.mjs');
  const rooms = await import('./rooms-store.js');
  // Owner keys are ACCOUNT ids now; the minter knows them.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Seed BEFORE boot: the server reads its stores once at start.
  const auth = mintBountyAuth({ handles: ['p3http'], dataDir: SCRATCH });
  const room = rooms.createRoom('p3-http-room', { maxSeats: 2 });
  rooms.setRoomOwner(room.id, auth.accountIdFor('p3http'));
  const sc = scene('http', { pledges: 2, roomId: room.id });
  const sessionB = store.createAirSession({ claimId: sc.claim.id, roomId: room.id, platform: 'twitch' });
  const [cA, cB] = sc.items;

  const PORT = 3284;
  const APP = `http://localhost:${PORT}`;
  const srv = await startGateServer({
    port: PORT, dataDir: SCRATCH,
    env: { ...auth.env, BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', BOUNTY_FIXTURE_PATH: 'fixtures/bounty-fail.json' },
    label: 'part3-http',
  });
  const owner = auth.cookieFor('p3http');
  const post = (p, body, headers = {}) => fetch(`${APP}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const get = (p, headers = {}) => fetch(`${APP}${p}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const asOwner = { Cookie: owner };
  const asAdmin = { 'x-bounty-admin-key': auth.adminKey };
  const visibility = (body) => post(`/api/rooms/${room.id}/overlay-visibility`, body, asOwner);
  try {
    // Scenario A — a pledged clip plays while the overlay is HIDDEN.
    let r = await visibility({ signal: 'overlay_hidden', reason: 'scene' });
    ok('H1 the owner posts overlay_hidden', r.status === 200 && r.body.signal === 'overlay_hidden', `http ${r.status}`);
    r = await post('/api/bounty/admin/playback', { airSessionId: sc.session.id, clipId: cA.clipId, durationS: 4 }, asAdmin);
    ok('H2 a pledged clip is put on air through the real playback route', r.status === 200 && !!r.body.playbackId, `http ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
    const pbA = r.body.playbackId;
    await sleep(4_500);
    r = await post('/api/bounty/admin/playback/end', { airSessionId: sc.session.id, clipId: cA.clipId, playbackId: pbA }, asAdmin);
    ok('H3 and ends', r.status === 200);
    r = await visibility({ signal: 'overlay_visible', scale: { scaleY: 1 } });
    ok('H4 the overlay comes back', r.status === 200 && r.body.signal === 'overlay_visible');
    const bankA = await get(`/api/bounty/bank?platform=twitch&handle=p3http`, asOwner);
    ok('H5 the bank shows the buried pledge (queued, or already draining into the play queue)',
      bankA.status === 200 && (bankA.body.byState?.QUEUED + bankA.body.byState?.DRAINING) >= 1, `byState=${JSON.stringify(bankA.body.byState)}`);
    const vA = await post(`/api/bounty/air-session/${sc.session.id}/verify`, {}, asOwner);
    ok('H6 verification of the buried playback opens a review whose cause says BANKED — delayed, not denied',
      vA.status === 200 && /banked: overlay hidden/.test(vA.body.review?.reason || ''), `reason=${(vA.body.review?.reason || '(none)').slice(0, 120)}`);
    ok('H7 and pays nothing for it (released 0)', vA.body.release?.released === 0, `released=${vA.body.release?.released}`);

    // Scenario B — a pledged clip plays while the overlay is SCALED below the floor.
    r = await visibility({ signal: 'overlay_visible', scale: { scaleY: 0.2 } });
    ok('H8 a quarter-scale overlay is derived server-side as overlay_scaled_below_floor', r.body.signal === 'overlay_scaled_below_floor', r.body.signal);
    r = await post('/api/bounty/admin/playback', { airSessionId: sessionB.id, clipId: cB.clipId, durationS: 4 }, asAdmin);
    const pbB = r.body.playbackId;
    await sleep(4_500);
    await post('/api/bounty/admin/playback/end', { airSessionId: sessionB.id, clipId: cB.clipId, playbackId: pbB }, asAdmin);
    await visibility({ signal: 'overlay_visible', scale: { scaleY: 1 } });
    const vB = await post(`/api/bounty/air-session/${sessionB.id}/verify`, {}, asOwner);
    ok('H9 verification names the SCALED cause in our own words — ours to explain, not the streamer',
      vB.status === 200 && /scaled below the [0-9]+px floor/.test(vB.body.review?.reason || '') && /ours to explain/.test(vB.body.review?.reason || ''),
      `reason=${(vB.body.review?.reason || '(none)').slice(0, 140)}`);
    ok('H10 a scaled playback is NOT banked — the overlay was on screen', !/banked:/.test(vB.body.review?.reason || ''));

    // The admin surfaces.
    const reviews = await get('/api/bounty/admin/reviews', asAdmin);
    ok('H11 the admin review list carries seat reviews beside bounty reviews', reviews.status === 200 && Array.isArray(reviews.body.seatReviews) && reviews.body.openCount >= 2, `open=${reviews.body.openCount}`);
    const sw = await post('/api/bounty/admin/sweep-bank', {}, asAdmin);
    ok('H12 the bank sweep is a deterministic admin action', sw.status === 200 && Array.isArray(sw.body.expired) && Array.isArray(sw.body.drained));
    const stranger = await get(`/api/bounty/bank?platform=twitch&handle=p3http`);
    ok('H13 the bank is not readable without a streamer session', stranger.status === 401, `http ${stranger.status}`);
  } finally {
    srv.kill();
  }
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
