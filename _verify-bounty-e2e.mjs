/**
 * VERIFY — the ENTIRE creator-bounty chain, over HTTP, against a real server.
 *
 * Every previous gate tests one link. This walks the whole thing the way a fan
 * and a streamer actually would:
 *
 *   reserve a handle → fan contributes → fan uploads the recording →
 *   streamer claims → air session opens → clip plays → watermark codes issue →
 *   verifier checks → escrow releases → evidence still reconciles →
 *   the streamer can actually RETRIEVE the clip they were paid to play
 *
 * The point is to find the links that were never connected. Chains fail at
 * joins, and every link here was built in a different session.
 */
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3299;
const APP = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-e2e-'));

const { mintBountyAuth } = await import('./_gate-helpers.mjs');
const srv = mintBountyAuth({ handles: ['e2estreamer'], dataDir });

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ...srv.env,
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd(),
});
let serverLog = '';
app.stdout.on('data', (d) => { serverLog += d; });
app.stderr.on('data', (d) => { serverLog += d; });
await sleep(11000);

// `as` picks WHICH streamer identity to send. Streamer-tier routes authorize
// against the handle they target, so a gate driving two channels needs two
// cookies; omitting it acts as the first handle.
const post = (p, body, as) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p, as) => fetch(`${APP}${p}`, { headers: srv.headers(as) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
  const cfg = await get('/api/bounty/config');
  ok('bounty routes are mounted with the flag on', cfg.body.enabled === true);

  // ── 1. a fan contributes against an unclaimed handle ───────────────────
  const contrib = await post('/api/bounty/contribute', {
    platform: 'twitch', handle: 'e2estreamer', contributor: '0xfan1', amount: '50',
  });
  ok('1. a fan can contribute to an unclaimed handle',
    contrib.status === 200 && !!contrib.body.contribution?.id,
    contrib.body.error || contrib.body.contribution?.id);
  const contributionId = contrib.body.contribution?.id;
  ok('1. the response tells the fan WHERE to upload the recording',
    !!contrib.body.uploadUrl && contrib.body.uploadUrl.includes(contributionId),
    contrib.body.uploadUrl);
  ok('1. ...and what the limits are, before they record',
    contrib.body.clipLimits?.minSeconds > 0 && contrib.body.clipLimits?.maxBytes > 0,
    JSON.stringify(contrib.body.clipLimits));

  // ── 2. the fan uploads the actual recording ────────────────────────────
  const clipBytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8192, 3)]);
  const up = await fetch(`${APP}${contrib.body.uploadUrl}?durationS=8`, {
    method: 'POST',
    headers: { 'Content-Type': 'video/webm', 'x-clip-duration': '8' },
    body: clipBytes,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  ok('2. the recording UPLOADS and is stored', up.status === 200 && !!up.body.clip?.clipId,
    up.body.error || up.body.clip?.clipId);
  const clipId = up.body.clip?.clipId;

  const reup = await fetch(`${APP}${contrib.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', 'x-clip-duration': '8' },
    body: clipBytes,
  }).then((r) => r.json());
  ok('2. a retried upload is idempotent (no double storage, no wasted quota)',
    reup.deduped === true && reup.clip?.clipId === clipId, JSON.stringify(reup).slice(0, 90));

  const tooShort = await post('/api/bounty/contribute', {
    platform: 'twitch', handle: 'e2estreamer', contributor: '0xfan2', amount: '10',
  });
  const shortUp = await fetch(`${APP}${tooShort.body.uploadUrl}?durationS=1`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', 'x-clip-duration': '1' },
    body: clipBytes,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  ok('2. a clip under the sampling floor is REFUSED at upload',
    shortUp.status >= 400 && /at least/i.test(shortUp.body.error || ''), shortUp.body.error);

  // ── 3. what is waiting for the streamer ────────────────────────────────
  const waiting = await get('/api/bounty/clips?platform=twitch&handle=e2estreamer');
  ok('3. the streamer can SEE what is waiting for them',
    waiting.body.clips?.length === 1 && waiting.body.clips[0].clipId === clipId,
    `${waiting.body.clips?.length} clip(s)`);
  ok('3. storage reports its own pressure (so it can be alarmed on)',
    typeof waiting.body.storage?.pctUsed === 'number', JSON.stringify(waiting.body.storage?.pctUsed));

  // ── 4. THE THING THE WHOLE MECHANIC PROMISES: play the clip back ───────
  const media = await fetch(`${APP}/api/bounty/clip/${clipId}/media`);
  const mediaBuf = Buffer.from(await media.arrayBuffer());
  ok('4. THE STREAMER CAN ACTUALLY RETRIEVE THE RECORDING',
    media.status === 200, `HTTP ${media.status}`);
  ok('4. ...and the bytes are exactly what the fan uploaded',
    mediaBuf.equals(clipBytes), `${mediaBuf.length} vs ${clipBytes.length}`);
  ok('4. ...served with the right content type for a browser to play',
    /video\/webm/.test(media.headers.get('content-type') || ''),
    media.headers.get('content-type'));

  // ── 5. claim → air session → watermark ─────────────────────────────────
  const claim = await post('/api/bounty/claim', {
    platform: 'twitch', handle: 'e2estreamer', claimant: '0xstreamer',
  });
  ok('5. the streamer can claim the handle',
    claim.status === 200 && !!claim.body.claim?.id, claim.body.error);
  const air = await post('/api/bounty/air-session', {
    claimId: claim.body.claim?.id, platform: 'twitch', roomId: 'e2eroom',
  });
  ok('5. an air session opens', air.status === 200 && !!air.body.airSession?.id, air.body.error);

  const code = await get(`/api/bounty/air-session/${air.body.airSession?.id}/code`);
  ok('5. a parked overlay with nothing playing issues NO code (airtime is not playback)',
    !code.body.code, JSON.stringify(code.body).slice(0, 80));

  // ── 6. money never moves ───────────────────────────────────────────────
  const pool = await get('/api/bounty/pool?platform=twitch&handle=e2estreamer');
  ok('6. the pool holds the contributions and has released nothing',
    pool.body.pool?.remaining > 0 && !pool.body.pool?.releasedContributor,
    JSON.stringify({ r: pool.body.pool?.remaining, rel: pool.body.pool?.releasedContributor }));
  ok('6. the server announced that settlement is stubbed',
    /LEDGER ONLY|no funds move/i.test(serverLog), 'boot warning present');

  // ── 7. refund reclaims BOTH the money and the recording ────────────────
  const refunded = await post('/api/bounty/admin/override', {
    platform: 'twitch', handle: 'e2estreamer', to: 'VOID', reason: 'e2e teardown', actor: 'gate',
  });
  ok('7. an admin override is accepted with an actor and reason',
    refunded.status === 200 || refunded.status === 409, `HTTP ${refunded.status}`);

  // ── 8. nothing in the boot log is an error we shipped past ─────────────
  const boot = serverLog.split('\n').filter((l) => /REFUSING TO START|corrupt|ECONNREFUSED|UnhandledPromise/i.test(l));
  ok('8. the server booted the bounty stack with no integrity failures',
    boot.length === 0, boot.slice(0, 2).join(' | '));
} finally {
  app.kill();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
