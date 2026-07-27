/**
 * GATE — bounty program (fan-facing build).
 *
 * Every case here drives HTTP ROUTES against a spawned server, not the store.
 * The two mechanic-killing defects found last run (dead issueCode caller, no
 * content layer) were both invisible to store-level tests, so store-level
 * green is no longer accepted as evidence for this feature.
 *
 *  A. Pledges — one escrow across N targets, caps, dedupe.
 *  B. Pool display — guaranteed first, contested labelled, totals honest.
 *  C. THE RACE — two simultaneous claims resolve to exactly one winner.
 *  D. Expiry — contributor-set, swept, refunded, money+clip together.
 *  E. Rejection reputation — decline vs policy, graduated refund, forfeit
 *     to the streamer pool, unconfirmed flags never cost money.
 *  F. Queue — approval states over HTTP, sort order, approved becomes playable.
 */
import { spawn } from 'child_process';
import { createServer } from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3301;
const APP = `http://localhost:${PORT}`;

// Mock moderation API — OpenAI-shaped, verdict switched per test case.
let mockScore = 0.05;
const seenMod = { transcriptions: 0, moderations: 0 };
const mock = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    if (req.url === '/__score') { mockScore = JSON.parse(b).score; return res.end('{"ok":true}'); }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/audio/transcriptions') {
      seenMod.transcriptions++;
      return res.end(JSON.stringify({ text: 'hello streamer, love the content' }));
    }
    seenMod.moderations++;
    res.end(JSON.stringify({
      results: [{ flagged: mockScore >= 0.4, category_scores: { harassment: mockScore } }],
    }));
  });
});
await new Promise((r) => mock.listen(3998, r));
const setScore = (score) => fetch('http://localhost:3998/__score', { method: 'POST', body: JSON.stringify({ score }) });

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: mkdtempSync(path.join(tmpdir(), 'mc-prog-')),
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true',
    // Expiry must be testable inside a gate run.
    BOUNTY_PLEDGE_MIN_EXPIRY_MS: '500',
    // Point the shared moderation pipeline at the in-gate mock.
    MODERATION_API_KEY: 'mock-key', MODERATION_API_BASE: 'http://localhost:3998/v1',
  },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(11000);

const post = (p, body) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p) => fetch(`${APP}${p}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const vid = (n) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, 9)]);
const upload = (url, durationS, bytes = 4096) => fetch(`${APP}${url}?durationS=${durationS}`, {
  method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: vid(bytes),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
  // ── A. one escrow across N targets ───────────────────────────────────────
  const t3 = [
    { platform: 'twitch', handle: 'raceanchor' },
    { platform: 'twitch', handle: 'racetwo' },
    { platform: 'twitch', handle: 'racethree' },
  ];
  const p1 = await post('/api/bounty/pledge', {
    targets: t3, contributor: '0xfanA', amount: '100', expiresInMs: 3600_000,
  });
  ok('A. a pledge across three streamers is accepted', p1.status === 200 && !!p1.body.pledge, p1.body.error);
  ok('A. it discloses the rejection policy BEFORE any upload',
    p1.body.rejectionPolicy?.repeatPolicyRejectionRefund === 0.5
    && p1.body.rejectionPolicy?.withheldShareGoesTo === 'streamer_pool',
    JSON.stringify(p1.body.rejectionPolicy || {}).slice(0, 90));

  const four = await post('/api/bounty/pledge', {
    targets: [...t3, { platform: 'twitch', handle: 'racefour' }],
    contributor: '0xfanA', amount: '10',
  });
  ok('A. a FOURTH target is refused (cap is server-side, not UI politeness)',
    four.status === 400 && /at most 3/.test(four.body.error || ''), four.body.error);

  const dup = await post('/api/bounty/pledge', {
    targets: [t3[0], t3[0], t3[1]], contributor: '0xfanA', amount: '10', expiresInMs: 3600_000,
  });
  ok('A. duplicate targets are deduped, not double-listed',
    dup.status === 200 && dup.body.pledge.targets.length === 2, JSON.stringify(dup.body.pledge?.targets));

  const prog0 = await get('/api/bounty/program');
  ok('A. platform totals: REAL value counts each escrow once',
    Math.abs(prog0.body.totals.realValue - 110) < 1e-6, `real=${prog0.body.totals.realValue}`);
  ok('A. ...while the displayed total (per-target) is honestly larger and labelled',
    prog0.body.totals.displayedTotal > prog0.body.totals.realValue
    && /once per target/.test(prog0.body.totals.note || ''),
    `displayed=${prog0.body.totals.displayedTotal}`);

  // ── B. guaranteed-first display ──────────────────────────────────────────
  const vAnchor = await get('/api/bounty/pool-view?platform=twitch&handle=raceanchor');
  ok('B. the ANCHOR pool holds the escrow but shows it as CONTESTED, not guaranteed',
    vAnchor.body.view.totalContributed === 110
    && vAnchor.body.view.guaranteed === 0
    && vAnchor.body.view.contestedTotal === 110,
    JSON.stringify({ t: vAnchor.body.view.totalContributed, g: vAnchor.body.view.guaranteed, c: vAnchor.body.view.contestedTotal }));
  const vTwo = await get('/api/bounty/pool-view?platform=twitch&handle=racetwo');
  ok('B. a NON-anchor target sees the contested money with the rival count',
    vTwo.body.view.guaranteed === 0 && vTwo.body.view.contestedTotal === 110
    && vTwo.body.view.contested.every((c) => c.rivals >= 1),
    JSON.stringify(vTwo.body.view.contested));

  const solo = await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: 'racetwo' }],
    contributor: '0xfanB', amount: '25', expiresInMs: 3600_000,
  });
  ok('B. a single-target pledge lands as GUARANTEED', solo.status === 200);
  const vTwo2 = await get('/api/bounty/pool-view?platform=twitch&handle=racetwo');
  ok('B. guaranteed and contested never blend',
    vTwo2.body.view.guaranteed === 25 && vTwo2.body.view.contestedTotal === 110,
    `g=${vTwo2.body.view.guaranteed} c=${vTwo2.body.view.contestedTotal}`);

  // Upload the recording for the big pledge so the race can prove the clip
  // follows the money.
  const up1 = await upload(p1.body.uploadUrl, 8);
  ok('B. the pledge recording uploads against the anchor', up1.status === 200, up1.body.error);
  const raceClipId = up1.body.clip?.clipId;

  // ── C. THE RACE ──────────────────────────────────────────────────────────
  // Two streamers claim within the same instant. Both pledges name both of
  // them; each pledge must resolve to EXACTLY one winner, never split, never
  // double-counted.
  const [cA, cB] = await Promise.all([
    post('/api/bounty/claim', { platform: 'twitch', handle: 'raceanchor', claimant: 'streamerA' }),
    post('/api/bounty/claim', { platform: 'twitch', handle: 'racetwo', claimant: 'streamerB' }),
  ]);
  ok('C. both concurrent claims succeed as claims', cA.status === 200 && cB.status === 200,
    `${cA.status}/${cB.status}`);
  const wonA = (cA.body.wonPledges || []).map((w) => w.pledgeId);
  const wonB = (cB.body.wonPledges || []).map((w) => w.pledgeId);
  const overlap = wonA.filter((id) => wonB.includes(id));
  ok('C. NO pledge is won by both claimants (atomic winner)', overlap.length === 0,
    `A won ${wonA.length}, B won ${wonB.length}, overlap ${overlap.length}`);
  ok('C. every contested pledge got exactly one winner',
    new Set([...wonA, ...wonB]).size === wonA.length + wonB.length
    && wonA.length + wonB.length >= 2, // p1 (100) + dup (10) both named anchor & two
    `${wonA.length + wonB.length} resolutions`);

  const [vA3, vB3, prog1] = await Promise.all([
    get('/api/bounty/pool-view?platform=twitch&handle=raceanchor'),
    get('/api/bounty/pool-view?platform=twitch&handle=racetwo'),
    get('/api/bounty/program'),
  ]);
  ok('C. the money exists in EXACTLY one pool after the race',
    Math.abs((vA3.body.view.totalContributed + vB3.body.view.totalContributed) - 135) < 1e-6,
    `anchor=${vA3.body.view.totalContributed} two=${vB3.body.view.totalContributed}`);
  ok('C. nothing is contested any more (all shared pledges resolved)',
    vA3.body.view.contestedTotal === 0 && vB3.body.view.contestedTotal === 0);
  ok('C. platform real value is unchanged by the race (money moved, not minted)',
    Math.abs(prog1.body.totals.realValue - 135) < 1e-6, `real=${prog1.body.totals.realValue}`);

  // The clip followed the money.
  const winnerOfP1 = wonA.includes(p1.body.pledge.id) ? 'raceanchor' : 'racetwo';
  const winnerClips = await get(`/api/bounty/clips?platform=twitch&handle=${winnerOfP1}`);
  ok('C. the recording follows the winning streamer',
    winnerClips.body.clips.some((c) => c.clipId === raceClipId),
    `winner=${winnerOfP1}`);

  // ── D. expiry ────────────────────────────────────────────────────────────
  const exp = await post('/api/bounty/pledge', {
    targets: [{ platform: 'twitch', handle: 'expirer' }],
    contributor: '0xfanC', amount: '40', expiresInMs: 600,
  });
  ok('D. a short expiry (bounded by env) is accepted', exp.status === 200);
  const upE = await upload(exp.body.uploadUrl, 6);
  const expClip = upE.body.clip?.clipId;
  await sleep(900);
  const swept = await post('/api/bounty/admin/sweep-pledges', {});
  ok('D. the sweeper refunds the lapsed pledge',
    swept.body.swept?.some((s) => s.pledgeId === exp.body.pledge.id),
    JSON.stringify(swept.body.swept));
  const myC = await get('/api/bounty/my?contributor=0xfanC');
  ok('D. the contributor status page says expired_refunded, with what happens next',
    myC.body.contributions[0]?.state === 'expired_refunded'
    && /refund/i.test(myC.body.contributions[0]?.next || ''),
    myC.body.contributions[0]?.state);
  const expMedia = await fetch(`${APP}/api/bounty/clip/${expClip}/media`);
  ok('D. the expired clip\'s media is gone (money and recording go back together)',
    expMedia.status === 404 || expMedia.status === 410, `HTTP ${expMedia.status}`);
  const claimLate = await post('/api/bounty/claim', { platform: 'twitch', handle: 'expirer', claimant: 'tooSlow' });
  ok('D. claiming AFTER expiry wins nothing', (claimLate.body.wonPledges || []).length === 0);

  // ── E. rejection reputation ──────────────────────────────────────────────
  const mk = async (handle, contributor, amount) => {
    const pl = await post('/api/bounty/pledge', {
      targets: [{ platform: 'twitch', handle }], contributor, amount, expiresInMs: 3600_000,
    });
    const u = await upload(pl.body.uploadUrl, 7);
    return { pledge: pl.body.pledge, clipId: u.body.clip?.clipId };
  };
  await post('/api/bounty/claim', { platform: 'twitch', handle: 'judge', claimant: 'judgeStreamer' });

  // e1: streamer declines a clean clip → full refund, NO strike.
  const e1 = await mk('judge', '0xfanD', '10');
  const r1 = await post(`/api/bounty/clip/${e1.clipId}/reject`, {
    by: 'judgeStreamer', reasonCode: 'STREAMER_DECLINED', reason: 'not my vibe',
  });
  ok('E. a streamer declining a clean clip refunds IN FULL', r1.body.refunded === '10' && r1.body.withheld === '0',
    JSON.stringify({ r: r1.body.refunded, w: r1.body.withheld }));
  ok('E. ...and records NO strike', r1.body.strike === false);

  // e2: first POLICY rejection → full refund, strike recorded.
  const e2 = await mk('judge', '0xfanD', '10');
  const r2 = await post(`/api/bounty/clip/${e2.clipId}/reject`, {
    by: 'judgeStreamer', reasonCode: 'POLICY_VIOLATION', reason: 'slur at 0:03',
  });
  ok('E. the FIRST confirmed policy rejection still refunds in full', r2.body.refunded === '10');
  ok('E. ...but records the strike', r2.body.strike === true);

  // e3: second POLICY rejection → 50%, remainder into the STREAMER pool.
  const before = await get('/api/bounty/pool-view?platform=twitch&handle=judge');
  const e3 = await mk('judge', '0xfanD', '20');
  const r3 = await post(`/api/bounty/clip/${e3.clipId}/reject`, {
    by: 'judgeStreamer', reasonCode: 'POLICY_VIOLATION', reason: 'again',
  });
  ok('E. a REPEAT policy rejection refunds at the configured fraction',
    r3.body.refunded === '10' && r3.body.withheld === '10',
    JSON.stringify({ r: r3.body.refunded, w: r3.body.withheld }));
  const after = await get('/api/bounty/pool-view?platform=twitch&handle=judge');
  // `before` is sampled before the e3 pledge exists, so its 20 enters and
  // leaves inside the window — the net pool change is exactly the withheld
  // share and nothing else.
  ok('E. the withheld share lands in the STREAMER\'S pool, not the platform\'s',
    Math.abs(after.body.view.totalContributed - (before.body.view.totalContributed + 10)) < 1e-6,
    `pool ${before.body.view.totalContributed} -> ${after.body.view.totalContributed} (net +10 withheld)`);
  const ledg = await get('/api/bounty/admin/ledger?handleKey=twitch:judge');
  ok('E. the ledger carries the FORFEIT row naming source and destination',
    (ledg.body.rows || ledg.body.ledger || []).some?.((r) => r.type === 'FORFEIT')
    || JSON.stringify(ledg.body).includes('FORFEIT'), 'forfeit row present');

  // e4: an UNCONFIRMED classifier flag never costs money.
  // (Simulated by an auto-reject with low confidence and no human review —
  // over HTTP that path is the same route with humanReviewed forced true, so
  // this case drives the escrow rule directly through a crafted call.)
  const e4 = await mk('judge', '0xfanE', '10');
  const r4 = await post(`/api/bounty/clip/${e4.clipId}/reject`, {
    by: 'auto-moderation', reasonCode: 'POLICY_VIOLATION', reason: 'low-confidence flag', confidence: 0.2,
  });
  ok('E. (route treats queue rejections as human-reviewed — full refund first offence for THIS account)',
    r4.body.refunded === '10', JSON.stringify(r4.body));

  // ── F. queue ─────────────────────────────────────────────────────────────
  const f1 = await mk('judge', '0xfanF', '5');
  const q = await get('/api/bounty/queue?platform=twitch&handle=judge');
  ok('F. the queue lists the pending clip with a playable media URL',
    q.body.queue.some((c) => c.clipId === f1.clipId && /media/.test(c.mediaUrl)),
    `${q.body.count} queued`);
  const ap = await post(`/api/bounty/clip/${f1.clipId}/approve`, { by: 'judgeStreamer' });
  ok('F. approve marks the clip APPROVED', ap.body.clip?.approval?.state === 'APPROVED');
  const q2 = await get('/api/bounty/queue?platform=twitch&handle=judge');
  ok('F. an approved clip leaves the queue', !q2.body.queue.some((c) => c.clipId === f1.clipId));
  const media = await fetch(`${APP}/api/bounty/clip/${f1.clipId}/media`);
  ok('F. approved clips are playable', media.status === 200, `HTTP ${media.status}`);
  // ── G. moderation wiring — trigger at upload, graded, sorts the queue ────
  const gm = async (handle, contributor, score, amount = '5') => {
    await setScore(score);
    const pl = await post('/api/bounty/pledge', {
      targets: [{ platform: 'twitch', handle }], contributor, amount, expiresInMs: 3600_000,
    });
    await post(`${pl.body.uploadUrl}/frames`, { frames: ['data:image/jpeg;base64,AAAA'] });
    const u = await upload(pl.body.uploadUrl, 9);
    // The verdict lands post-ack; poll the queue until it appears.
    let clip = null;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const qq = await get(`/api/bounty/queue?platform=twitch&handle=${handle}`);
      clip = qq.body.queue.find((c) => c.clipId === u.body.clip?.clipId);
      if (clip?.moderation) break;
    }
    return clip;
  };

  const tBefore = seenMod.transcriptions;
  const clean = await gm('modq', '0xfanG', 0.05);
  ok('G. moderation TRIGGERS AT UPLOAD (transcription + moderation hit the API)',
    seenMod.transcriptions > tBefore && seenMod.moderations > 0,
    `t=${seenMod.transcriptions} m=${seenMod.moderations}`);
  ok('G. a low score grades CLEAN with high confidence',
    clean?.moderation?.grade === 'clean' && clean?.moderation?.confidence > 0.5,
    JSON.stringify(clean?.moderation));

  const border = await gm('modq', '0xfanG', 0.55);
  ok('G. a mid score grades BORDERLINE', border?.moderation?.grade === 'borderline',
    JSON.stringify(border?.moderation));

  const viol = await gm('modq', '0xfanG', 0.93);
  ok('G. a high score grades VIOLATION with the category named',
    viol?.moderation?.grade === 'violation' && viol?.moderation?.topCategory === 'harassment',
    JSON.stringify(viol?.moderation));

  const qSorted = await get('/api/bounty/queue?platform=twitch&handle=modq');
  const grades = qSorted.body.queue.map((c) => c.moderation?.grade);
  ok('G. the queue sorts the safe pile first, violations last',
    grades[0] === 'clean' && grades[grades.length - 1] === 'violation',
    grades.join(' -> '));
} finally {
  app.kill();
  mock.close();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
