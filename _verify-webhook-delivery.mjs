/**
 * TASK 2 — verify real webhook delivery end to end against PRODUCTION.
 *
 * Connects a genuine participant to the real LiveKit Cloud project under a
 * `seat:` identity (so it is BILLABLE, not discounted as a probe), holds ~10s,
 * and disconnects. LiveKit Cloud delivers participant_joined / participant_left
 * to https://megachat.fun/api/livekit/webhook.
 *
 * Asserts: the pair arrives, the session opens and closes, the duration is
 * right, nothing is left open, and the breaker meters NON-ZERO from webhook
 * data — which was the entire point of activating the webhook.
 *
 * Cost: ~10 seconds of one participant. Budget for this task is 10 minutes.
 */
import 'dotenv/config';
import { AccessToken } from 'livekit-server-sdk';
import puppeteer from 'puppeteer-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROD = 'https://megachat.fun';
const URL = process.env.LIVEKIT_URL;
const KEY = process.env.LIVEKIT_API_KEY;
const SECRET = process.env.LIVEKIT_API_SECRET;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const burn = () => fetch(`${PROD}/api/livekit/burn`).then((r) => r.json());

const ROOM = 'mc-webhookverify';
const IDENT = 'seat:webhookverify';
const HOLD_MS = 10_000;

const before = await burn();
console.log(`baseline: open=${before.webhook.openCount} closed=${before.webhook.closedCount} minutesToday=${before.webhook.minutesToday}\n`);

const at = new AccessToken(KEY, SECRET, { identity: IDENT, ttl: '10m' });
at.addGrant({ roomJoin: true, room: ROOM, canPublish: true, canSubscribe: true });
const token = await at.toJwt();

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', protocolTimeout: 120000,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
try {
  // Same-origin page that is NOT the overlay (an overlay here would connect on
  // its own and muddy the measurement).
  const page = await browser.newPage();
  await page.goto(`${PROD}/how-it-works`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const joinedAt = Date.now();
  const res = await page.evaluate(async ({ url, token, prod }) => {
    await new Promise((r, j) => {
      const s = document.createElement('script');
      s.src = `${prod}/vendor/livekit-client.umd.js`; s.onload = r; s.onerror = j;
      document.head.appendChild(s);
    });
    const LK = window.LivekitClient;
    const room = new LK.Room();
    await room.connect(url, token);
    const c = document.createElement('canvas'); c.width = 320; c.height = 180;
    const ctx = c.getContext('2d');
    setInterval(() => { ctx.fillStyle = '#0f0'; ctx.fillRect(0, 0, 320, 180); }, 100);
    await room.localParticipant.publishTrack(c.captureStream(15).getVideoTracks()[0]);
    window.__room = room;
    return { identity: room.localParticipant.identity, state: room.state };
  }, { url: URL, token, prod: PROD });
  console.log(`connected as ${res.identity} (${res.state})`);

  await sleep(4000);
  const during = await burn();
  const openNow = during.webhook.openSessions.find((s) => s.identity === IDENT);
  ok('participant_joined delivered — session OPEN in prod', !!openNow,
    JSON.stringify(during.webhook.openSessions));
  ok('classified as a billable guest (seat: prefix)',
    openNow?.kind === 'guest' && openNow?.billable === true,
    `kind=${openNow?.kind} billable=${openNow?.billable}`);

  await sleep(HOLD_MS);
  await page.evaluate(async () => { await window.__room.disconnect(); });
  const leftAt = Date.now();
  console.log(`disconnected after ~${((leftAt - joinedAt) / 1000).toFixed(1)}s`);

  await sleep(6000);
  const after = await burn();
  const stillOpen = after.webhook.openSessions.find((s) => s.identity === IDENT);
  ok('participant_left delivered — nothing left OPEN', !stillOpen,
    `openCount=${after.webhook.openCount}`);
  ok('session CLOSED and counted', after.webhook.closedCount > before.webhook.closedCount,
    `closed ${before.webhook.closedCount} -> ${after.webhook.closedCount}`);

  const heldMin = (leftAt - joinedAt) / 60_000;
  const deltaMin = after.webhook.minutesToday - before.webhook.minutesToday;
  ok('duration recorded accurately (within 30s of wall clock)',
    Math.abs(deltaMin - heldMin) < 0.5,
    `webhook ${deltaMin.toFixed(3)}min vs actual ${heldMin.toFixed(3)}min`);

  ok('BREAKER NOW READS NON-ZERO FROM WEBHOOK DATA (the point of activating it)',
    after.webhook.minutesToday > 0,
    `minutesToday=${after.webhook.minutesToday}, daily budget used ${after.breaker.pct.daily}%`);

  const rec = after.reconciliation;
  console.log('\n── RECONCILIATION (webhook vs our ledger) ──');
  console.log(JSON.stringify(rec, null, 2));
  console.log(`\nLIVEKIT MINUTES CONSUMED BY THIS TEST: ~${deltaMin.toFixed(2)}`);
} finally {
  await browser.close();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
