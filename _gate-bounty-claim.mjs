/**
 * GATE — creator bounty (Run A).
 *
 * Covers every item in the prompt's "verification before you call it done",
 * plus the rule that matters most on a mainnet app: NO REAL SETTLEMENT PATH.
 *
 *  A. Escrow — every illegal transition in the table throws AND writes nothing.
 *  B. Escrow — double release with the same idempotency key releases once.
 *  C. Watermark — codes rotate, expire, and never collide across two
 *     concurrent air sessions.
 *  D. Badge — below threshold stops code rendering and records the violation.
 *  E. Verifier — pass / fail / partial / ambiguous fixtures each produce the
 *     expected verified-minutes and confidence.
 *  F. Refund — an unclaimed handle past expiry refunds contributors in the ledger.
 *  G. Flag off — no routes respond, no surfaces render, existing behavior identical.
 *  H. Source audit — no real settlement/transfer call anywhere in the feature.
 */
import { spawn } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import fsSync from 'fs';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRATCH = `${process.env.TEMP || '/tmp'}/mc-bounty-gate-${Date.now()}`;

// ── A–F: in-process against the real modules ───────────────────────────────
process.env.BOUNTY_CLAIM = '1';
process.env.DATA_DIR = SCRATCH;

const store = await import('./bounty-store.js');
const escrow = await import('./bounty-escrow.js');
const watermark = await import('./bounty-watermark.js');
const verifier = await import('./bounty-verifier.js');
const { StubSettlement } = await import('./bounty-settlement.js');
const { bountyConfig } = await import('./bounty-claim.config.js');
const quietSettlement = new StubSettlement({ log: { log() {} } });

// Validate the evidence chain up front, exactly as attachBountyRoutes does at
// boot. Without this every release fail-closes with `evidence_unverified` —
// which is the correct production behaviour (never pay against unvouched
// proof), but it means an in-process harness has to opt in the same way a
// booting server does.
store.verifyEvidenceIntegrity();

// ── A. every illegal transition throws and writes nothing ──────────────────
{
  escrow.reserve({ platform: 'twitch', handle: 'illegaltest' });
  const key = store.handleKey('twitch', 'illegaltest');
  const states = escrow.STATES;
  let checked = 0, allThrew = true, allClean = true;

  for (const from of states) {
    // Force the record into `from` directly (bypassing the machine) so every
    // origin state can be exercised, including terminals.
    store.updateReservedHandle(key, { claimStatus: from });
    const legal = new Set(escrow.ALLOWED_TRANSITIONS[from] || []);
    for (const to of states) {
      if (legal.has(to)) continue; // legal moves are not this test
      checked++;
      const before = store.listLedger().length;
      let threw = false;
      try {
        escrow.transition({ handleKey: key, to, actor: 'gate' });
      } catch (e) {
        threw = e.code === 'illegal_transition';
      }
      if (!threw) allThrew = false;
      if (store.listLedger().length !== before) allClean = false;
      // state must be untouched
      if (store.getReservedHandleByKey(key).claimStatus !== from) allClean = false;
    }
  }
  ok('A. every illegal transition throws IllegalTransition', allThrew, `${checked} combinations`);
  ok('A. illegal transitions write NOTHING (ledger + state untouched)', allClean);
}

// ── B. double release with the same idempotency key releases once ──────────
{
  escrow.reserve({ platform: 'twitch', handle: 'idemtest' });
  const key = store.handleKey('twitch', 'idemtest');
  escrow.contribute({ platform: 'twitch', handle: 'idemtest', contributor: '0xa', amount: '100' });
  for (const to of ['RESERVED', 'CLAIM_PENDING', 'CLAIM_VERIFIED', 'AWAITING_AIRTIME', 'VERIFYING']) {
    escrow.transition({ handleKey: key, to, actor: 'gate' });
  }
  const r1 = escrow.release({
    handleKey: key, claimId: 'c', airSessionId: 'a', verifiedClips: 2, verifiedClipSeconds: 20,
    confidence: 0.9, idempotencyKey: 'dup-key', settlement: quietSettlement,
  });
  const r2 = escrow.release({
    handleKey: key, claimId: 'c', airSessionId: 'a', verifiedClips: 2, verifiedClipSeconds: 20,
    confidence: 0.9, idempotencyKey: 'dup-key', settlement: quietSettlement,
  });
  const pool = store.getPool(key);
  ok('B. first release pays', r1.released > 0, `${r1.released}`);
  ok('B. replay with the same idempotency key is deduped and pays 0', r2.deduped && !r2.released);
  ok('B. pool reflects exactly ONE release', pool.releasedContributor === r1.released,
    `released=${pool.releasedContributor}`);
  ok('B. platform match is a SEPARATE bucket, never blended',
    pool.releasedPlatformMatch > 0 && pool.releasedPlatformMatch !== pool.releasedContributor,
    `match=${pool.releasedPlatformMatch}`);
}

// ── C. PLAYBACK-BOUND codes: rotation, clamping, no cross-clip overlap ─────
{
  store.reserveHandle({ platform: 'twitch', handle: 'wm', ttlMs: 1e9 });
  const claim = store.createClaim({ handleKey: 'twitch:wm', claimant: 'u', ttlMs: 1e9 });
  const s1 = store.createAirSession({ claimId: claim.id, roomId: 'rwm', platform: 'twitch' });
  const t0 = Date.now();

  // C0 — a parked overlay (nothing playing) can produce nothing verifiable.
  ok('C. parked overlay with NO clip playing issues no code',
    watermark.currentOrRotate(s1.id, { now: t0 }) === null);
  ok('C. parked overlay has zero codes in the session',
    watermark.allSessionCodes(s1.id).length === 0);

  // C1 — a 10s clip must yield at least one samplable code.
  const a = watermark.startClipPlayback(s1.id, { clipId: 'A', durationS: 10, now: t0 });
  for (let k = bountyConfig.codeRotateMs; k < 10_000; k += bountyConfig.codeRotateMs) {
    watermark.currentOrRotate(s1.id, { now: t0 + k });
  }
  const aCodes = watermark.allSessionCodes(s1.id).filter((c) => c.clipId === 'A');
  ok('C. a 10s clip yields at least one verifiable code', aCodes.length >= 1, `${aCodes.length} codes`);
  ok('C. codes rotate inside a long clip (>1 for 10s at 4s cadence)', aCodes.length > 1);
  ok('C. every code is bound to its clip id', aCodes.every((c) => c.clipId === 'A'));
  ok('C. code validity is CLAMPED to the clip end',
    aCodes.every((c) => c.expiresAt <= t0 + 10_000));
  watermark.endClipPlayback(s1.id, { clipId: 'A', now: t0 + 10_000 });

  // C2 — back-to-back clip: no instant may satisfy both.
  watermark.startClipPlayback(s1.id, { clipId: 'B', durationS: 10, now: t0 + 10_000 });
  for (let k = bountyConfig.codeRotateMs; k < 10_000; k += bountyConfig.codeRotateMs) {
    watermark.currentOrRotate(s1.id, { now: t0 + 10_000 + k });
  }
  let overlaps = 0;
  for (let t = t0; t < t0 + 20_000; t += 200) {
    const valid = watermark.codesValidAt(s1.id, t);
    if (new Set(valid.map((c) => c.clipId)).size > 1) overlaps++;
  }
  ok('C. ONE sampled frame can never satisfy two clips (zero overlapping instants)',
    overlaps === 0, `${overlaps} overlapping instants`);
  watermark.endClipPlayback(s1.id, { clipId: 'B', now: t0 + 20_000 });

  // C3 — clip below the sampling floor is refused, loudly, not silently paid.
  const shortClip = watermark.startClipPlayback(s1.id, { clipId: 'TINY', durationS: 1, now: t0 + 30_000 });
  ok('C. a clip below the sampling floor issues NO code', shortClip.code === null);
  ok('C. and records BELOW_SAMPLING_FLOOR rather than paying silently',
    store.getAirSession(s1.id).violations.some((v) => v.type === 'BELOW_SAMPLING_FLOOR'),
    shortClip.reason);

  // ── D. overlay self-report halts issuance (early warning, NOT enforcement) ─
  const s2 = store.createAirSession({ claimId: claim.id, roomId: 'rwm2', platform: 'twitch' });
  // NOTE: issueCodeForWindow takes a PLAYBACK id now, not a clip id — two
  // airings of one clip are two separate windows.
  const zPlay = watermark.startClipPlayback(s2.id, { clipId: 'Z', durationS: 10, now: t0 });
  watermark.reportBadgeTooSmall(s2.id, { ratio: 0.005, height: 6 });
  ok('D. self-reported too-small badge stops code issuance',
    watermark.issueCodeForWindow(s2.id, zPlay.playbackId, { now: t0 + 1000 }) === null);
  ok('D. violation recorded as a SELF REPORT (not proof of shrinking)',
    store.getAirSession(s2.id).violations.some((v) => v.type === 'BADGE_TOO_SMALL_SELF_REPORT'));
  watermark.clearBadgeViolation(s2.id);
  ok('D. clearing it resumes issuance',
    watermark.issueCodeForWindow(s2.id, zPlay.playbackId, { now: t0 + 2000 }) !== null);
}

// ── E. verifier: pass / fail / partial / ambiguous / too-small / no-playback ─
let ambiguousSessionId = null;
{
  let n = 0;
  const mkSession = (clipDurations) => {
    store.reserveHandle({ platform: 'twitch', handle: 'vf', ttlMs: 1e9 });
    const c = store.createClaim({ handleKey: 'twitch:vf', claimant: 'u', ttlMs: 1e9 });
    const s = store.createAirSession({ claimId: c.id, roomId: `rvf${n++}`, platform: 'twitch' });
    let t = Date.now() - 600_000;
    for (const d of clipDurations) {
      const cid = `clip-${t}`;
      watermark.startClipPlayback(s.id, { clipId: cid, durationS: d, now: t });
      for (let k = bountyConfig.codeRotateMs; k < d * 1000; k += bountyConfig.codeRotateMs) {
        watermark.currentOrRotate(s.id, { now: t + k });
      }
      watermark.endClipPlayback(s.id, { clipId: cid, now: t + d * 1000 });
      t += d * 1000 + 2000;
    }
    return s.id;
  };
  const run = async (fixtureFile, clips = [10, 10, 10]) => {
    const fx = JSON.parse(readFileSync(`fixtures/${fixtureFile}`, 'utf8'));
    const id = mkSession(clips);
    const r = await verifier.verifyAirSession(id, {
      frameSource: new verifier.MockFrameSource(fx),
      codeChecker: new verifier.MockCodeChecker(fx),
    });
    return { id, ...r };
  };

  const p = await run('bounty-pass.json');
  ok('E. PASS fixture verifies every clip playback',
    p.result === 'PASS' && p.verifiedClips === 3 && p.verifiedClipSeconds === 30,
    `${p.result} clips=${p.verifiedClips} secs=${p.verifiedClipSeconds}`);

  const single = await run('bounty-pass.json', [10]);
  ok('E. a single 10s clip verifies and pays proportionally (1 clip, 10s)',
    single.verifiedClips === 1 && single.verifiedClipSeconds === 10,
    `clips=${single.verifiedClips} secs=${single.verifiedClipSeconds}`);

  const f = await run('bounty-fail.json');
  ok('E. FAIL fixture verifies zero clips', f.result === 'FAIL' && f.verifiedClips === 0);

  const ts = await run('bounty-toosmall.json', [10, 10]);
  ok('E. FOUND BUT TOO SMALL fails the sample (legibility enforced at verify time)',
    ts.result === 'FAIL_TOO_SMALL' && ts.verifiedClips === 0,
    `${ts.result} clips=${ts.verifiedClips}`);
  ok('E. and records CODE_TOO_SMALL_IN_FRAME',
    store.getAirSession(ts.id).violations.some((v) => v.type === 'CODE_TOO_SMALL_IN_FRAME'));

  const am = await run('bounty-ambiguous.json');
  ambiguousSessionId = am.id;
  ok('E. AMBIGUOUS is distinct from FAIL and under the confidence floor',
    am.result === 'AMBIGUOUS' && am.confidence < bountyConfig.minConfidence,
    `${am.result} conf=${am.confidence}`);

  // E-parked: overlay up, zero clips played ⇒ zero payable units, no release.
  store.reserveHandle({ platform: 'twitch', handle: 'parked', ttlMs: 1e9 });
  const pk = store.handleKey('twitch', 'parked');
  escrow.contribute({ platform: 'twitch', handle: 'parked', contributor: '0x', amount: '100' });
  const pc = store.createClaim({ handleKey: pk, claimant: 'u', ttlMs: 1e9 });
  const ps = store.createAirSession({ claimId: pc.id, roomId: 'rparked', platform: 'twitch' });
  const parked = await verifier.verifyAirSession(ps.id, {
    frameSource: new verifier.MockFrameSource({ defaultAvailable: true }),
    codeChecker: new verifier.MockCodeChecker({ defaultCheck: { found: true, confidence: 0.99, pixelHeight: 40 } }),
  });
  ok('E. PARKED overlay (zero clips played) accrues ZERO payable units',
    parked.result === 'NO_PLAYBACK' && parked.verifiedClips === 0 && parked.verifiedClipSeconds === 0,
    parked.result);
  for (const to of ['RESERVED', 'CLAIM_PENDING', 'CLAIM_VERIFIED', 'AWAITING_AIRTIME', 'VERIFYING']) {
    escrow.transition({ handleKey: pk, to, actor: 'gate' });
  }
  const parkedRelease = escrow.release({
    handleKey: pk, claimId: pc.id, airSessionId: ps.id,
    verifiedClips: parked.verifiedClips, verifiedClipSeconds: parked.verifiedClipSeconds,
    confidence: 0.99, idempotencyKey: 'parked-1', settlement: quietSettlement,
  });
  ok('E. PARKED overlay releases NOTHING',
    parkedRelease.released === 0 && store.getPool(pk).releasedContributor === 0,
    parkedRelease.skipped || '');
}

// ── I. ambiguous → review queue blocks release until a human resolves ──────
{
  store.reserveHandle({ platform: 'twitch', handle: 'revq', ttlMs: 1e9 });
  const k = store.handleKey('twitch', 'revq');
  escrow.contribute({ platform: 'twitch', handle: 'revq', contributor: '0x', amount: '100' });
  const claim = store.createClaim({ handleKey: k, claimant: 'u', ttlMs: 1e9 });
  const s = store.getAirSession(ambiguousSessionId);
  for (const to of ['RESERVED', 'CLAIM_PENDING', 'CLAIM_VERIFIED', 'AWAITING_AIRTIME', 'VERIFYING']) {
    escrow.transition({ handleKey: k, to, actor: 'gate' });
  }
  const review = store.createReview({
    airSessionId: s.id, claimId: claim.id, handleKey: k,
    verificationId: 'v1', confidence: 0.35, reason: 'ambiguous',
  });
  ok('I. an ambiguous result opens a review in OPEN state', review.state === 'OPEN');
  ok('I. the session reports an open review', store.hasOpenReview(s.id) === true);

  const blocked = escrow.release({
    handleKey: k, claimId: claim.id, airSessionId: s.id,
    verifiedClips: 3, verifiedClipSeconds: 30, confidence: 0.99,
    idempotencyKey: 'rev-block-1', settlement: quietSettlement,
  });
  ok('I. release is BLOCKED while a review is open (no silent zero-payout)',
    blocked.released === 0 && blocked.skipped === 'pending_review', blocked.skipped);

  store.updateReview(review.id, { state: 'RESOLVED_APPROVE', resolvedAt: Date.now(), resolvedBy: 'gate', resolutionReason: 'looked at the VOD' });
  const afterResolve = escrow.release({
    handleKey: k, claimId: claim.id, airSessionId: s.id,
    verifiedClips: 3, verifiedClipSeconds: 30, confidence: 1,
    idempotencyKey: 'rev-block-2', settlement: quietSettlement,
  });
  ok('I. once resolved, release proceeds', afterResolve.released > 0, `${afterResolve.released}`);
  ok('I. SLA breach is computable from review age',
    Date.now() - review.openedAt < bountyConfig.reviewSlaMs);
}

// ── F. refund an unclaimed handle past expiry ──────────────────────────────
{
  escrow.reserve({ platform: 'twitch', handle: 'refundme' });
  const key = store.handleKey('twitch', 'refundme');
  escrow.contribute({ platform: 'twitch', handle: 'refundme', contributor: '0xc1', amount: '25' });
  escrow.contribute({ platform: 'twitch', handle: 'refundme', contributor: '0xc2', amount: '15' });
  const rows = escrow.refundExpired({ handleKey: key, actor: 'gate', settlement: quietSettlement });
  const pool = store.getPool(key);
  const ledger = store.listLedger({ handleKey: key });
  ok('F. every held contribution is refunded in the ledger', rows.length === 2);
  ok('F. refunded total matches contributions', pool.refunded === 40, `${pool.refunded}`);
  ok('F. handle ends REFUNDED', store.getReservedHandleByKey(key).claimStatus === 'REFUNDED');
  ok('F. refund rows carry the contributor for Run B settlement',
    ledger.filter((r) => r.type === 'REFUND').every((r) => r.meta?.contributor));
  // idempotent: refunding twice must not double-refund
  const again = escrow.refundExpired({ handleKey: key, actor: 'gate', settlement: quietSettlement });
  ok('F. refunding again is idempotent (no double refund)',
    store.getPool(key).refunded === 40, `still ${store.getPool(key).refunded}`);
}

// ── K. PER-PLAYBACK NONCE: same clip twice must be two separate evidences ──
{
  store.reserveHandle({ platform: 'twitch', handle: 'twice', ttlMs: 1e9 });
  const claim = store.createClaim({ handleKey: 'twitch:twice', claimant: 'u', ttlMs: 1e9 });
  const s = store.createAirSession({ claimId: claim.id, roomId: 'rtwice', platform: 'twitch' });
  const t0 = Date.now();

  const r1 = watermark.startClipPlayback(s.id, { clipId: 'SAME', durationS: 10, now: t0 });
  for (let k = bountyConfig.codeRotateMs; k < 10_000; k += bountyConfig.codeRotateMs) {
    watermark.currentOrRotate(s.id, { now: t0 + k });
  }
  watermark.endClipPlayback(s.id, { clipId: 'SAME', now: t0 + 10_000 });
  const p1 = watermark.allSessionCodes(s.id).filter((c) => c.playbackId === r1.playbackId);

  const r2 = watermark.startClipPlayback(s.id, { clipId: 'SAME', durationS: 10, now: t0 + 60_000 });
  for (let k = bountyConfig.codeRotateMs; k < 10_000; k += bountyConfig.codeRotateMs) {
    watermark.currentOrRotate(s.id, { now: t0 + 60_000 + k });
  }
  watermark.endClipPlayback(s.id, { clipId: 'SAME', now: t0 + 70_000 });
  const p2 = watermark.allSessionCodes(s.id).filter((c) => c.playbackId === r2.playbackId);

  ok('K. replaying the SAME clip issues codes for the second airing too',
    p1.length > 0 && p2.length > 0, `p1=${p1.length} p2=${p2.length}`);
  ok('K. the two airings have DISTINCT playback ids',
    r1.playbackId !== r2.playbackId);
  ok('K. and distinct code namespaces',
    p1[0].code.split('-')[0] !== p2[0].code.split('-')[0],
    `${p1[0].code} vs ${p2[0].code}`);
  const validMid2 = watermark.codesValidAt(s.id, t0 + 65_000).map((c) => c.code);
  ok('K. NO playback-1 code validates inside playback-2 window (no double-pay)',
    !validMid2.some((c) => p1.map((x) => x.code).includes(c)));
  ok('K. two separate windows exist for one clip id',
    store.getAirSession(s.id).playbackWindows.filter((w) => w.clipId === 'SAME').length === 2);

  // Both airings evidenced ⇒ the verifier counts TWO playbacks.
  const fx = JSON.parse(readFileSync('fixtures/bounty-pass.json', 'utf8'));
  const v = await verifier.verifyAirSession(s.id, {
    frameSource: new verifier.MockFrameSource(fx),
    codeChecker: new verifier.MockCodeChecker(fx),
  });
  ok('K. a clip aired twice pays for TWO verified playbacks',
    v.verifiedClips === 2, `verifiedClips=${v.verifiedClips}`);
}

// ── L. EVIDENCE LOG: append-only, validated, and gating payouts ────────────
{
  const evd = await import('./bounty-evidence.js');
  store.reserveHandle({ platform: 'twitch', handle: 'eviD', ttlMs: 1e9 });
  const claim = store.createClaim({ handleKey: store.handleKey('twitch', 'eviD'), claimant: 'u', ttlMs: 1e9 });
  const s = store.createAirSession({ claimId: claim.id, roomId: 'revid', platform: 'twitch' });
  const t0 = Date.now();
  watermark.startClipPlayback(s.id, { clipId: 'EV', durationS: 10, now: t0 });
  for (let k = bountyConfig.codeRotateMs; k < 10_000; k += bountyConfig.codeRotateMs) {
    watermark.currentOrRotate(s.id, { now: t0 + k });
  }

  const rows = evd.allEvidence();
  ok('L. evidence records carry seq + checksum',
    rows.length > 0 && rows.every((r) => r.seq > 0 && typeof r.sum === 'string'));
  ok('L. evidence captures the code issuance a payout rests on',
    rows.some((r) => r.type === 'CODE_ISSUED'));
  const rebuilt = evd.rebuildWindows(s.id);
  ok('L. windows rebuild from evidence alone (independent of the cache)',
    rebuilt.length === 1 && rebuilt[0].codes.length > 0,
    `windows=${rebuilt.length} codes=${rebuilt[0]?.codes.length}`);
  const recon = store.reconcileSessionEvidence(s.id);
  ok('L. cache matches evidence when nothing is damaged', recon.diverged === false);

  // Divergence must BLOCK a release rather than pay on a damaged cache.
  const key = store.handleKey('twitch', 'eviD');
  escrow.contribute({ platform: 'twitch', handle: 'eviD', contributor: '0x', amount: '100' });
  for (const to of ['RESERVED', 'CLAIM_PENDING', 'CLAIM_VERIFIED', 'AWAITING_AIRTIME', 'VERIFYING']) {
    escrow.transition({ handleKey: key, to, actor: 'gate' });
  }
  const sess = store.getAirSession(s.id);
  const realCodes = sess.playbackWindows[0].codes;
  sess.playbackWindows[0].codes = realCodes.slice(0, 1); // simulate cache damage
  const blocked = escrow.release({
    handleKey: key, claimId: claim.id, airSessionId: s.id,
    verifiedClips: 1, verifiedClipSeconds: 10, confidence: 0.95,
    idempotencyKey: 'evid-1', settlement: quietSettlement,
  });
  ok('L. a payout is REFUSED when cache diverges from evidence',
    blocked.released === 0 && blocked.skipped === 'evidence_diverged', blocked.skipped);
  sess.playbackWindows[0].codes = realCodes; // restore

  // Same file-integrity guarantees as the ledger.
  const evPath = `${SCRATCH}/bounty-evidence.jsonl`;
  const before = fsSync.readFileSync(evPath, 'utf8');
  fsSync.appendFileSync(evPath, '{"type":"CODE_ISSUED","seq":999,"tor');
  store._resetCache();
  const rec = store.verifyEvidenceIntegrity();
  ok('L. a torn FINAL evidence record recovers', rec.recovered === 1);

  const lines = fsSync.readFileSync(evPath, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]); tampered.code = 'FAKE-CODE';
  fsSync.writeFileSync(evPath, [lines[0], JSON.stringify(tampered), ...lines.slice(2)].join('\n') + '\n');
  store._resetCache();
  let refused = false;
  try { store.verifyEvidenceIntegrity(); } catch (e) { refused = e.code === 'ledger_corrupt'; }
  ok('L. a TAMPERED interior evidence record refuses to load', refused);
  ok('L. and evidence is then marked untrustworthy, blocking payouts',
    store.evidenceIsTrustworthy().ok === false);

  fsSync.writeFileSync(evPath, before); // leave the scratch chain valid
  store._resetCache();
  store.verifyEvidenceIntegrity();
}

// ── H. source audit: no real settlement/transfer anywhere ──────────────────
{
  const files = readdirSync('.').filter((f) => /^bounty-.*\.(js|mjs)$/.test(f));
  const banned = /\b(sendTransaction|writeContract|transferFrom|\.transfer\(|signTransaction|privateKeyToAccount|walletClient)\b/;
  const offenders = files.filter((f) => banned.test(readFileSync(f, 'utf8')));
  ok('H. NO real transfer/settlement call in any bounty module', offenders.length === 0,
    offenders.join(',') || `${files.length} files scanned`);
  const settlementSrc = readFileSync('bounty-settlement.js', 'utf8');
  ok('H. settlement module is stub-only and says so',
    /NO FUNDS MOVE/i.test(settlementSrc) && /TODO\(run-b\)/.test(settlementSrc));
}

// ── J. ledger integrity: torn final recovers, interior corruption refuses ──
{
  const { createLedger, LedgerCorrupt } = await import('./bounty-ledger.js');
  const dir = `${SCRATCH}-ledger`;
  fsSync.mkdirSync(dir, { recursive: true });
  const p = `${dir}/l.jsonl`;

  const L = createLedger({ filePath: p, log: { warn() {}, error() {}, log() {} } });
  L.append({ type: 'A', amount: '1' });
  L.append({ type: 'B', amount: '2' });
  L.append({ type: 'C', amount: '3' });
  ok('J. records carry a sequence number and checksum',
    L.all().every((r) => r.seq > 0 && typeof r.sum === 'string' && r.sum.length > 0));
  ok('J. sequence numbers are strictly consecutive',
    L.all().map((r) => r.seq).join(',') === '1,2,3');

  // torn FINAL record (crash mid-append) — recoverable
  fsSync.appendFileSync(p, '{"type":"D","seq":4,"partial');
  const L2 = createLedger({ filePath: p, log: { warn() {}, error() {}, log() {} } });
  const res = L2.load();
  ok('J. a torn FINAL record recovers by truncating to the last valid seq',
    res.recovered === 1 && L2.all().length === 3, `recovered=${res.recovered} rows=${L2.all().length}`);

  // INTERIOR corruption — must refuse, never fold a corrupt ledger into balances
  const lines = fsSync.readFileSync(p, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[0]);
  tampered.amount = '999999';                    // edit without fixing the checksum
  fsSync.writeFileSync(p, [JSON.stringify(tampered), ...lines.slice(1)].join('\n') + '\n');
  let refused = false;
  try {
    createLedger({ filePath: p, log: { warn() {}, error() {}, log() {} } }).load();
  } catch (e) {
    refused = e instanceof LedgerCorrupt || e.code === 'ledger_corrupt';
  }
  ok('J. a tampered INTERIOR record refuses to load (no wrong pool totals)', refused);

  // a mid-chain GAP must also refuse
  const p2 = `${dir}/gap.jsonl`;
  const L3 = createLedger({ filePath: p2, log: { warn() {}, error() {}, log() {} } });
  L3.append({ type: 'A' }); L3.append({ type: 'B' }); L3.append({ type: 'C' });
  const g = fsSync.readFileSync(p2, 'utf8').trim().split('\n');
  fsSync.writeFileSync(p2, [g[0], g[2]].join('\n') + '\n'); // drop seq 2
  let gapRefused = false;
  try {
    createLedger({ filePath: p2, log: { warn() {}, error() {}, log() {} } }).load();
  } catch (e) { gapRefused = e.code === 'ledger_corrupt'; }
  ok('J. a GAP in the middle of the chain refuses to load', gapRefused);
}

console.log(`\n  [server-side subtotal] ${pass} pass, ${fail} fail`);

// ── G. flag OFF: no routes, no surfaces ────────────────────────────────────
const launch = (port, env) => spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(port), DATA_DIR: `${SCRATCH}-http`, ...env },
  stdio: 'ignore', cwd: process.cwd(),
});

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
});

const off = launch(3250, { BOUNTY_CLAIM: '0' });
await sleep(9000);
try {
  const codes = await Promise.all(
    ['/api/bounty/pools', '/api/bounty/config', '/api/bounty/admin/sessions']
      .map((p) => fetch(`http://localhost:3250${p}`).then((r) => r.status).catch(() => 0)),
  );
  ok('G. flag off: every bounty route 404s (nothing mounted)',
    codes.every((c) => c === 404), codes.join(','));
  const health = await fetch('http://localhost:3250/api/health').then((r) => r.status);
  ok('G. flag off: the rest of the app is unaffected', health === 200);

  const page = await browser.newPage();
  await page.goto('http://localhost:3250/bounty', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1200);
  const txt = await page.evaluate(() => document.body.innerText);
  ok('G. flag off: /bounty renders no bounty surface (no board, no claim CTA)',
    !/This is me|Creator bounties waiting|Claim this handle/i.test(txt) && /Not available yet/i.test(txt));
  await page.close();
} finally { off.kill(); }

// flag ON: routes live + page renders the board
const on = launch(3251, { BOUNTY_CLAIM: '1' });
await sleep(9000);
try {
  const cfg = await fetch('http://localhost:3251/api/bounty/config').then((r) => r.json());
  ok('G. flag on: config route reports enabled', cfg.enabled === true);
  await fetch('http://localhost:3251/api/bounty/contribute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'twitch', handle: 'gateshow', contributor: '0x', amount: '80', letterRef: 'L' }),
  });
  const page = await browser.newPage();
  await page.goto('http://localhost:3251/bounty', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  const txt = await page.evaluate(() => document.body.innerText);
  ok('G. flag on: the board renders the real pool', /gateshow/i.test(txt), txt.slice(0, 80).replace(/\n/g, ' '));
  ok('G. flag on: the preview build states no funds move', /no funds move/i.test(txt));
  await page.close();
} finally { on.kill(); }

await browser.close();
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
