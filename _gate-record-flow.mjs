/**
 * GATE — the fan record-and-send surface, driven IN A REAL BROWSER.
 *
 * Every other bounty gate talks HTTP with fabricated webm bytes. This one does
 * what a fan does: opens the streamer page in Chrome, records through a real
 * MediaRecorder off Chrome's fake camera, previews, re-records, sets the
 * terms, pays at submit — and then the assertions are about WHAT LANDED, not
 * about what ran:
 *
 *   - the clip is IN the clip store, and its bytes are a real webm (EBML
 *     magic), big enough to be a recording rather than a stub
 *   - the clip record KEYS to the contribution the pledge created — the exact
 *     join that silently broke in self-capture (a capture nothing could find)
 *   - the pool grew by exactly the amount typed into the browser
 *   - the expiry choice made in the UI is the expiry on the pledge
 *   - the status page shows the contribution on the honest ladder
 *
 * And the negative that proves PAY-AT-SUBMIT structurally:
 *   - a too-short take is refused BEFORE any pledge exists — the ledger and
 *     the clip store are untouched, because nothing was ever created
 *   - stopping at preview (never clicking pay) also creates nothing
 *
 * Zero external network: fake camera, localhost server, no platform creds.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { startGateServer } from './_gate-helpers.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 3240;
const APP = `http://localhost:${PORT}`;
const FAN = 'fanrecorder';
const STAR = 'targetstar';

const srv = await startGateServer({
  port: PORT, label: 'record-flow',
  bountyAuth: { handles: [FAN] },
  env: {
    BOUNTY_CLAIM: '1', KEEP_ORPHAN_ROOMS: 'true', MODERATION_API_KEY: '',
    TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '',
    // The shipped default min (3s) — the gate records both sides of it.
    BOUNTY_MIN_CLIP_SECONDS: '3',
  },
});

const jget = (p, as) => fetch(`${APP}${p}`, { headers: srv.headers(as) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const jpost = (p, body, as) => fetch(`${APP}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.headers(as) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// Media is content-addressed under bounty-clips/media/; the sibling
// index.jsonl is the append-only record of what each blob IS.
const clipFiles = () => {
  const d = path.join(srv.dataDir, 'bounty-clips', 'media');
  return existsSync(d) ? readdirSync(d) : [];
};
const clipIndexRows = () => {
  const f = path.join(srv.dataDir, 'bounty-clips', 'index.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split(String.fromCharCode(10)).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
};
const ledgerLines = () => {
  const f = path.join(srv.dataDir, 'bounty-ledger.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
};

let browser;
try {
  // The target streamer's pool must exist for the page to render a bounty.
  const seeded = await jpost('/api/bounty/admin/seed', { platform: 'twitch', handle: STAR });
  ok('setup: target pool seeded', seeded.status === 200, JSON.stringify(seeded.body).slice(0, 80));

  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: [
      // Chrome's built-in synthetic camera + mic, permission auto-granted:
      // MediaRecorder then produces REAL webm from a REAL capture pipeline.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 950 });

  // Sign the fan in exactly as the app does: the sealed identity cookie.
  const cookieStr = srv.cookieFor(FAN); // "mc_identity=<value>"
  const eq = cookieStr.indexOf('=');
  await page.setCookie({
    name: cookieStr.slice(0, eq), value: cookieStr.slice(eq + 1), url: APP,
  });

  const clickText = async (txt) => {
    const hit = await page.evaluate((t) => {
      const el = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim().includes(t));
      if (!el) return false;
      el.click();
      return true;
    }, txt);
    if (!hit) throw new Error(`no button containing "${txt}"`);
  };
  const waitText = async (txt, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const found = await page.evaluate((t) => document.body.innerText.includes(t), txt);
      if (found) return true;
      await sleep(250);
    }
    return false;
  };

  await page.goto(`${APP}/bounty/s/twitch/${STAR}`, { waitUntil: 'networkidle2', timeout: 60000 });
  ok('the streamer page renders the record entry point',
    await waitText(`Record a MegaChat for ${STAR}`), 'entry button present');

  await clickText(`Record a MegaChat for ${STAR}`);
  // The minimum duration must be DISCLOSED before recording starts.
  ok('the minimum duration is stated BEFORE recording starts',
    await waitText('3s minimum'), 'not discovered after a failed take');

  // ── A. too-short take: refused before any money object exists ───────────
  const ledgerBefore = ledgerLines();
  await clickText('Record');
  await sleep(1400); // ~1s of media — under the 3s floor
  await clickText('Stop');
  ok('A. a too-short take is refused with the "nothing charged" message',
    await waitText('Nothing was charged'), 'fan is told, not billed');
  ok('A. ...and NO pledge/ledger row exists (pay-at-submit, proven by absence)',
    ledgerLines() === ledgerBefore, `${ledgerLines()} rows before and after`);
  ok('A. ...and the clip store is untouched', clipFiles().length === 0);

  // ── B. real take: record → preview → RE-RECORD → terms → pay → submit ──
  await clickText('Record');
  await sleep(4600);
  await clickText('Stop');
  ok('B. stopping lands on preview with a re-record choice',
    await waitText('Re-record'), 'preview stage reached');

  // Exercise the re-record path — the take being discarded must cost nothing.
  await clickText('Re-record');
  await sleep(300);
  await clickText('Record');
  await sleep(4600);
  await clickText('Stop');
  ok('B. re-record produces a second preview', await waitText('Re-record'));
  ok('B. ...and still nothing exists server-side before submit',
    ledgerLines() === ledgerBefore && clipFiles().length === 0,
    'preview is free; only submit pays');

  await clickText('Looks good — set the bounty');
  ok('B. the rejection policy is on screen BEFORE the pay button is pressed',
    (await waitText('Before you pay')) && (await waitText('full refund')),
    'disclosed pre-payment, not post-dispute');
  ok('B. ...and the refund destination is stated honestly (the account)',
    await waitText('Refunds go to the account'), 'contributor string is display-only');

  // Amount 7.5 — typed through React's controlled input.
  await page.evaluate(() => {
    const label = [...document.querySelectorAll('label')]
      .find((l) => (l.textContent || '').includes('Bounty amount'));
    const input = label.querySelector('input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(input, '7.5');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickText('2 weeks');
  await clickText('& send');

  ok('B. the submit completes to the done panel', await waitText('Sent', 25000));

  // ── C. what actually LANDED ─────────────────────────────────────────────
  const pool = await jget(`/api/bounty/pool?platform=twitch&handle=${STAR}`);
  ok('C. the pool grew by exactly the amount typed in the browser',
    pool.body.pool?.totalContributed === 7.5,
    `totalContributed=${pool.body.pool?.totalContributed}`);

  const mine = await jget('/api/bounty/my', FAN);
  const rows = mine.body.contributions || mine.body.mine || [];
  ok('C. the signed-in fan has exactly one contribution', rows.length === 1,
    `${rows.length} row(s)`);
  const row = rows[0] || {};
  ok('C. ...on the honest status ladder with a next-step sentence',
    typeof row.state === 'string' && row.state !== 'pending_upload' && !!row.next,
    `state=${row.state} next="${String(row.next).slice(0, 60)}"`);

  const files = clipFiles();
  ok('C. exactly one clip file landed in the store', files.length === 1, files.join(','));
  const media = readFileSync(path.join(srv.dataDir, 'bounty-clips', 'media', files[0]));
  ok('C. ...its bytes are a real webm recording, not a stub',
    media.length > 20_000
    && media[0] === 0x1a && media[1] === 0x45 && media[2] === 0xdf && media[3] === 0xa3,
    `${(media.length / 1024).toFixed(0)}KB, EBML magic ok`);

  // THE JOIN: the clip record must key to the contribution the pledge minted.
  // A clip that exists but keys to nothing is the self-capture bug wearing a
  // different hat — present on disk, unreachable at verify time. Read the
  // INDEX the verifier-side lookups fold from, not a summary route.
  const clipRec = clipIndexRows().find((r) => r.clipId && r.contributionId) || {};
  const contributionId = row.contributionId || row.contribution?.id || null;
  ok('C. the clip record keys to the pledge\'s contribution',
    !!clipRec.contributionId && !!contributionId && clipRec.contributionId === contributionId,
    `clip.contributionId=${clipRec.contributionId} vs pledge's=${contributionId}`);
  ok('C. ...and to the target streamer\'s pool',
    clipRec.handleKey === `twitch:${STAR}`, clipRec.handleKey);
  ok('C. ...with a believable duration for a ~4.6s take',
    clipRec.durationS >= 3 && clipRec.durationS <= 10, `${clipRec.durationS}s`);

  // Expiry choice made in the UI (2 weeks) is the expiry on the pledge.
  const pledgeRow = rows[0].pledge || rows[0];
  const expMs = (pledgeRow.expiresAt || 0) - Date.now();
  ok('C. the expiry picked in the browser is the pledge\'s expiry (~14d)',
    expMs > 13.5 * 86_400_000 && expMs < 14.5 * 86_400_000,
    `${(expMs / 86_400_000).toFixed(2)} days out`);

  // ── D. the status page renders the ladder for this fan ─────────────────
  await page.goto(`${APP}/bounty/mine`, { waitUntil: 'networkidle2', timeout: 60000 });
  const ladderShown = await waitText(STAR, 12000)
    && (await page.evaluate(() => /Awaiting claim|In review|Streamer reviewing|Approved/.test(document.body.innerText)));
  ok('D. the status page shows the contribution on the ladder', ladderShown);
  ok('D. ...with the amount the fan paid', await waitText('7.5'));
} finally {
  if (browser) await browser.close();
  srv.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
