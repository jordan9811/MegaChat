/**
 * OVERLAY SETUP HELPER — keeps a badge on screen so the operator can SEE it.
 *
 * The rehearsal's canary answers "is the overlay on the stream?" in 45 seconds
 * and then exits. That is the right shape for a run, and the wrong shape for
 * SETTING UP: it gives one bit of feedback per attempt, with a minutes-long
 * warmup in front of it, so getting an OBS browser source right becomes a
 * blind guess-and-wait loop. Three real broadcasts went that way.
 *
 * This holds a clip open indefinitely instead. The badge stays on screen, the
 * current code is printed here, and the operator can fiddle with OBS until it
 * appears — immediate feedback, no broadcast consumed, nothing to co-ordinate.
 *
 * It deliberately does NOT verify anything and never touches escrow. It exists
 * so the real run starts from a known-good scene.
 *
 * Usage:  node _setup-overlay.mjs [--room pfrehearsal] [--minutes 20]
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

try { process.loadEnvFile('.env'); } catch { /* env may be injected */ }

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const ROOM = arg('room', 'pfrehearsal');
const MINUTES = Number(arg('minutes', 20));
const HANDLE = arg('handle', 'setupstreamer');
const PORT = 3309;
const APP = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { startGateServer } = await import('./_gate-helpers.mjs');
const srv = await startGateServer({
  port: PORT, dataDir: mkdtempSync(path.join(tmpdir(), 'mc-setup-')),
  label: 'overlay-setup', bountyAuth: { handles: [`kick:${HANDLE}`] },
  env: { BOUNTY_CLAIM: '1', BOUNTY_IDENTITY_REAL: '0', KEEP_ORPHAN_ROOMS: 'true' },
  readyTimeoutMs: 180_000,
});
const post = (p, b, as) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
  body: JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p, as) => fetch(`${APP}${p}`, { headers: srv.headers(as) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const AS = `kick:${HANDLE}`;
const cleanup = () => { try { srv.kill(); } catch { /* gone */ } };
process.on('SIGINT', () => { cleanup(); process.exit(130); });

try {
  const pl = await post('/api/bounty/pledge', {
    targets: [{ platform: 'kick', handle: HANDLE }],
    contributor: '0xsetup', amount: '25', expiresInMs: 86_400_000,
  }, AS);
  await fetch(`${APP}${pl.body.uploadUrl}?durationS=8`, {
    method: 'POST', headers: { 'Content-Type': 'video/webm', ...srv.headers(AS) },
    body: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 5)]),
  });
  const claim = await post('/api/bounty/claim',
    { platform: 'kick', handle: HANDLE, claimant: HANDLE }, AS);
  const air = await post('/api/bounty/air-session',
    { claimId: claim.body.claim.id, roomId: ROOM }, AS);
  const airId = air.body.airSession?.id;
  if (!airId) throw new Error(`air-session failed: ${JSON.stringify(air.body).slice(0, 200)}`);

  console.log('');
  console.log('='.repeat(72));
  console.log('  PUT THIS IN OBS AS A BROWSER SOURCE  (Width 1280, Height 720)');
  console.log('');
  console.log(`    ${APP}/overlay?bountyRoom=${ROOM}`);
  console.log('');
  console.log('  Drag it ABOVE your other sources. A badge should appear within');
  console.log('  ~15 seconds. This will keep a code on screen until you stop it,');
  console.log('  so take as long as you need — no broadcast is being spent.');
  console.log('='.repeat(72));
  console.log('');

  const deadline = Date.now() + MINUTES * 60_000;
  let clipN = 0;
  while (Date.now() < deadline) {
    // Clips are capped in length, so roll a fresh one as each expires. The
    // badge is continuously present across the whole session.
    clipN += 1;
    const clipId = `SETUP${clipN}`;
    await post('/api/bounty/admin/playback', { airSessionId: airId, clipId, durationS: 120 });
    for (let i = 0; i < 12 && Date.now() < deadline; i += 1) {
      await sleep(10_000);
      const c = await get(`/api/bounty/room/${ROOM}/code`, AS);
      console.log(`[setup] badge should read: ${c.body.code ?? '(none)'}`
        + `   session ${String(c.body.airSessionId || '').slice(0, 8)}…`);
    }
    await post('/api/bounty/admin/playback/end', { airSessionId: airId, clipId });
  }
  console.log('\n[setup] time is up — stopping. Re-run if you need longer.');
} catch (e) {
  console.error('[setup] FAILED:', e?.message || e);
  process.exitCode = 1;
} finally {
  cleanup();
}
