/**
 * GATE — the overlay UX picks of 2026-11-09, on the REAL overlay page served
 * by the REAL server, each one run against a copy of the tree with the old
 * overlay.html (and the old /<handle>/overlay fallback) put back. Every NEW
 * assertion has an OLD counterpart that must come out the other way.
 *
 *   ov-link-mistakes  /<unknown>/overlay serves the transparent overlay, not
 *                     the site's 404; /overlay with no room opens no socket
 *                     and subscribes to nothing (old: room "default")
 *   ov-source-size    tiles and chips scale by innerWidth ÷ 1920 (720p source)
 *   ov-name-chip      24px at 1080p, the viewer's casing, no fringe shadow
 *   ov-no-fallback    the hold layer paints a solid card; a clip that cannot
 *                     decode flies out at once (old: black until letter_end)
 *   ov-too-small-locks  flagged: the code's box is measured and tooSmall:false
 *                     is posted (old: warning measured, nothing posted)
 *   ov-too-small-on-air no "NOT EARNING" text on air; the text fallback has its
 *                     own floor, so a correct 1080p source does not trip
 *   ov-no-test-tile   POST …/overlay-test draws three labelled sample tiles and
 *                     the badge, then clears (new only: the route is new)
 *
 * Zero spend: free rooms, a free Holler with undecodable bytes, bounty
 * endpoints stubbed in the page. Run in the FOREGROUND (puppeteer).
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync,
  symlinkSync, lstatSync, rmdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startGateServer } from './_gate-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT_NEW = 3473;
const PORT_OLD = 3474;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENV = {
  KEEP_ORPHAN_ROOMS: 'true',
  SELLER_PRIVATE_KEY: '0x' + '11'.repeat(32), // dummy signer (holds nothing) so the Holler route is up
  TEMPO_RPC_URL: 'http://127.0.0.1:9',
  LAZY_CONNECT: '0',
  BOUNTY_CLAIM: '0',
};
const PASSWORD = 'r3-overlay-gate';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

const JUNCTIONS = ['node_modules', 'web/node_modules', 'web/.next'];
function removeCopy(dir) {
  for (const j of JUNCTIONS) {
    const p = path.join(dir, j);
    try { if (lstatSync(p).isSymbolicLink()) rmdirSync(p); } catch { /* absent */ }
  }
  if (JUNCTIONS.some((j) => { try { lstatSync(path.join(dir, j)); return true; } catch { return false; } })) {
    console.log(`\n  (old copy LEFT at ${dir}: remove the junctions before the folder)`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}
function oldCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mc-ovr3-old-'));
  const media = /\.(png|jpe?g|gif|webp|mp4|webm|mov|wav|mp3|ogg|ttf|woff2?|psd|zip|pdf)$/i;
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: HERE }).toString().split('\0');
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: HERE }).toString().split('\0')
    .filter((f) => /\.(m?js|cjs)$/.test(f) && !f.includes('/'));
  for (const f of [...tracked, ...untracked]) {
    if (!f || f.startsWith('design-assets/') || f.startsWith('docs/') || media.test(f)) continue;
    const src = path.join(HERE, f);
    if (!existsSync(src)) continue;
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    copyFileSync(src, path.join(dir, f));
  }
  for (const j of JUNCTIONS) symlinkSync(path.join(HERE, j), path.join(dir, j), 'junction');
  // The overlay page exactly as committed before these picks.
  writeFileSync(path.join(dir, 'public', 'overlay.html'), execFileSync('git', ['show', 'HEAD:public/overlay.html'], { cwd: HERE }));
  // The old /<handle>/overlay: an unknown handle fell through to the site's 404.
  const p = path.join(dir, 'server.js');
  const src = readFileSync(p, 'utf8');
  const from = "if (!/^[a-z0-9_]{1,32}$/i.test(req.params.handle)) return next();";
  if (!src.includes(from)) throw new Error('mutation pattern not found in server.js (handle fallback)');
  writeFileSync(p, src.replace(from, 'return next();'));
  return dir;
}

/** Bounty endpoints answered inside the page, so no bounty session is needed. */
function stubBounty(cfg) {
  const orig = window.fetch.bind(window);
  window.__badgePosts = [];
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/bounty/config')) return j({ badgeMinHeightPx: 18, badgeMinHeightRatio: 0.03 });
    if (/\/api\/bounty\/(room|air-session)\/[^/]+\/code/.test(u)) {
      return j({ code: cfg.code, badgeTooSmall: cfg.flagged, airSessionId: 'sess-r3', rotateMs: 4000 });
    }
    if (/\/api\/bounty\/air-session\/[^/]+\/badge/.test(u)) {
      try { window.__badgePosts.push(JSON.parse(opts.body || '{}')); } catch { window.__badgePosts.push({}); }
      return j({ ok: true });
    }
    if (/\/api\/bounty\/air-session\/[^/]+\/overlay-env/.test(u)) return j({ ok: true });
    return orig(url, opts);
  };
}

async function run(base, browser, label) {
  const out = {};
  const json = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(json);
  const created = await post('/api/dashboard/create', {
    name: `R3 ${label}`, password: PASSWORD,
    config: { passkeyTickPrice: '0', maxSeats: 3, transport: 'vdo', joinStream: { enabled: true }, letters: { enabled: true, maxSeconds: 6, price: '0', moderation: 'auto' } },
  });
  if (created.status !== 201) throw new Error(`create: ${created.status} ${JSON.stringify(created.body)}`);
  const room = created.body.room.id;

  const newPage = async ({ w = 1920, h = 1080, bounty = null, blockMatrix = false, hookWs = false } = {}) => {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (/vdo\.ninja/.test(u) || (blockMatrix && /code-matrix\.cjs/.test(u))) return req.abort();
      return req.continue();
    });
    if (bounty) await page.evaluateOnNewDocument(stubBounty, bounty);
    if (hookWs) {
      await page.evaluateOnNewDocument(() => {
        window.__wsMade = 0; window.__wsSent = [];
        const W = window.WebSocket;
        window.WebSocket = function (...a) { window.__wsMade++; const s = new W(...a); const send = s.send.bind(s); s.send = (d) => { window.__wsSent.push(String(d)); return send(d); }; return s; };
        window.WebSocket.prototype = W.prototype;
      });
    }
    return page;
  };

  // ── ov-link-mistakes ────────────────────────────────────────────────────
  {
    const r = await fetch(`${base}/zzgonehandle/overlay`);
    const body = await r.text();
    out.unknownHandle = { status: r.status, overlay: body.includes('id="stage"') && body.includes('bounty-badge') };
    const page = await newPage({ hookWs: true });
    await page.goto(`${base}/overlay`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1200);
    out.noRoom = await page.evaluate(() => ({ made: window.__wsMade, sent: window.__wsSent }));
    await page.close();
  }

  // ── ov-source-size + ov-name-chip at a 720p source ──────────────────────
  {
    const page = await newPage({ w: 1280, h: 720 });
    await page.goto(`${base}/overlay?room=${room}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(800);
    await page.evaluate(() => window.OverlayTest.addSeat({ id: 'r3-a', username: 'Kai🔥Rivera', viewUrl: 'https://vdo.ninja/?view=r3fake' }));
    await sleep(900);
    out.chip720 = await page.evaluate(() => {
      const t = document.querySelector('[data-seat-id="r3-a"]');
      const l = t?.querySelector('.username-label');
      const cs = l ? getComputedStyle(l) : null;
      const r = t?.getBoundingClientRect();
      return t ? { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right), font: cs.fontSize, transform: cs.textTransform, shadow: cs.textShadow, text: l.textContent, rendered: l.innerText } : null;
    });
    // ov-no-fallback: the hold layer, on a real tile.
    out.hold = await page.evaluate(() => {
      const t = document.querySelector('[data-seat-id="r3-a"]');
      t.classList.add('lk-holding');
      const a = getComputedStyle(t, '::after');
      return { bg: a.backgroundColor, img: a.backgroundImage, content: a.content };
    });
    await page.close();
  }
  {
    const page = await newPage();
    await page.goto(`${base}/overlay?room=${room}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(800);
    await page.evaluate(() => window.OverlayTest.addSeat({ id: 'r3-b', username: 'Kai🔥Rivera', viewUrl: 'https://vdo.ninja/?view=r3fake' }));
    await sleep(900);
    out.chip1080 = await page.evaluate(() => {
      const t = document.querySelector('[data-seat-id="r3-b"]');
      const cs = getComputedStyle(t.querySelector('.username-label'));
      const r = t.getBoundingClientRect();
      return { w: Math.round(r.width), font: cs.fontSize };
    });
    await page.close();
  }

  // ── ov-no-fallback: a Holler whose clip cannot decode ───────────────────
  {
    const page = await newPage();
    await page.goto(`${base}/overlay?room=${room}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1200);
    const s = await post('/api/letter/submit', { room, username: 'badclip', durationS: 5, mime: 'video/webm' });
    if (s.status !== 200) throw new Error(`submit ${s.status} ${JSON.stringify(s.body)}`);
    await fetch(base + s.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: Buffer.alloc(4096, 7) });
    let seenAt = 0;
    for (let i = 0; i < 60 && !seenAt; i++) {
      if (await page.evaluate(() => !!document.querySelector('[data-seat-id^="letter:"]'))) seenAt = Date.now();
      else await sleep(150);
    }
    await sleep(2500);
    out.badClip = { appeared: !!seenAt, stillUp3s: seenAt ? await page.evaluate(() => !!document.querySelector('[data-seat-id^="letter:"]:not(.leaving)')) : null };
    await sleep(6000); // let letter_end pass before the next section reuses the room
    await page.close();
  }

  // ── ov-too-small-locks / on-air: the server holds the flag, no code ─────
  {
    const page = await newPage({ bounty: { code: null, flagged: true } });
    await page.goto(`${base}/overlay?room=${room}&bountyRoom=${room}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(4500);
    out.flagged = await page.evaluate(() => {
      const b = document.getElementById('bounty-badge');
      const cs = getComputedStyle(b);
      return {
        posts: window.__badgePosts.map((p) => p.tooSmall),
        visible: cs.display !== 'none' && cs.visibility !== 'hidden',
        text: document.getElementById('bounty-code').textContent,
      };
    });
    if (label === 'new') {
      const env = await fetch(`${base}/api/rooms/${room}/overlay-env`).then(json);
      out.envFlagged = env.body;
    }
    await page.close();
  }
  // ── the text fallback (no matrix lib) at a CORRECT 1920×1080 source ─────
  {
    const page = await newPage({ bounty: { code: '37-K4QX', flagged: false }, blockMatrix: true });
    await page.goto(`${base}/overlay?room=${room}&bountyRoom=${room}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);
    out.legacy = await page.evaluate(() => ({ posts: window.__badgePosts.map((p) => p.tooSmall), text: document.getElementById('bounty-code').textContent }));
    await page.close();
  }

  // ── ov-no-test-tile (new route) ─────────────────────────────────────────
  if (label === 'new') {
    const page = await newPage({ bounty: { code: null, flagged: false } });
    await page.goto(`${base}/overlay?room=${room}&bountyRoom=${room}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1500);
    out.testNoAuth = (await post(`/api/rooms/${room}/overlay-test`, {})).status;
    const t = await post(`/api/rooms/${room}/overlay-test`, {}, { 'X-Room-Password': PASSWORD });
    out.testStatus = t.status;
    await sleep(900);
    out.testDuring = await page.evaluate(() => ({
      labels: [...document.querySelectorAll('.tile .username-label')].map((l) => l.textContent),
      badge: document.getElementById('bounty-badge').classList.contains('show'),
    }));
    await sleep(6000);
    out.testAfter = await page.evaluate(() => ({ tiles: document.querySelectorAll('.tile').length, badge: document.getElementById('bounty-badge').classList.contains('show') }));
    await page.close();
  }
  return out;
}

let oldDir = null, srvNew = null, srvOld = null, browser = null;
try {
  browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

  console.log('\n— NEW (working tree) —');
  srvNew = await startGateServer({ port: PORT_NEW, label: 'ovr3-new', env: ENV });
  const n = await run(`http://localhost:${PORT_NEW}`, browser, 'new');
  console.log('  ', JSON.stringify(n));
  ok('link: /<unknown>/overlay serves the transparent overlay (200), not the 404 page', n.unknownHandle.status === 200 && n.unknownHandle.overlay, JSON.stringify(n.unknownHandle));
  ok('link: /overlay with no room opens no socket and subscribes to nothing', n.noRoom.made === 0 && n.noRoom.sent.length === 0, JSON.stringify(n.noRoom));
  ok('size: a 720p source scales the tile to 320 × 1280/1920 = 213 wide, margin 13', n.chip720 && Math.abs(n.chip720.w - 213) <= 1 && Math.abs(n.chip720.right - 13) <= 1, JSON.stringify(n.chip720));
  ok('size: ...and a 1080p source keeps 320', n.chip1080.w === 320, JSON.stringify(n.chip1080));
  ok('chip: 24px at 1080p, 16px at 720p', n.chip1080.font === '24px' && n.chip720.font === '16px');
  ok('chip: the viewer\'s casing, no fringe shadow', n.chip720.transform === 'none' && n.chip720.shadow === 'none' && n.chip720.rendered === 'Kai🔥Rivera', JSON.stringify(n.chip720));
  ok('hold: the hold layer paints solid ultramarine with "Connecting"', /rgb\(47, 42, 216\)/.test(n.hold.bg) && /Connecting/.test(n.hold.content), JSON.stringify(n.hold));
  ok('clip: an undecodable Holler appeared and flew out within 2.5 s', n.badClip.appeared && n.badClip.stillUp3s === false, JSON.stringify(n.badClip));
  ok('locks: flagged, the overlay measures the code\'s box and posts tooSmall:false', n.flagged.posts.includes(false), JSON.stringify(n.flagged.posts));
  ok('on-air: flagged, nothing is visible on the broadcast and no "NOT EARNING" text', !n.flagged.visible && !/NOT EARNING/.test(n.flagged.text), JSON.stringify(n.flagged));
  ok('on-air: the overlay reports its badge state to the dashboard (overlay-env)', n.envFlagged?.overlays >= 1 && n.envFlagged?.env && typeof n.envFlagged.env.badgeTooSmall === 'boolean', JSON.stringify(n.envFlagged));
  ok('fallback: the text code at a correct 1080p source does not trip (posts tooSmall:false)', n.legacy.posts.length > 0 && n.legacy.posts.every((p) => p === false) && n.legacy.text === '37-K4QX', JSON.stringify(n.legacy));
  ok('test: the test route refuses a caller with no room access', n.testNoAuth === 401, String(n.testNoAuth));
  ok('test: with access it draws a sample Holler and two "Test" seats, and the badge', n.testStatus === 200 && JSON.stringify(n.testDuring.labels) === JSON.stringify(['📼 Test Holler', 'Test', 'Test']) && n.testDuring.badge, JSON.stringify(n.testDuring));
  ok('test: ...and clears them after 5 s', n.testAfter.tiles === 0 && !n.testAfter.badge, JSON.stringify(n.testAfter));
  srvNew.kill(); srvNew = null;

  console.log('\n— OLD (overlay.html and the handle fallback put back) —');
  oldDir = oldCopy();
  srvOld = await startGateServer({ port: PORT_OLD, label: 'ovr3-old', args: [path.join(oldDir, 'server.js'), '--prod'], env: ENV });
  const o = await run(`http://localhost:${PORT_OLD}`, browser, 'old');
  console.log('  ', JSON.stringify(o));
  ok('DISCRIMINATES link: old /<unknown>/overlay is the 404 page', o.unknownHandle.status === 404, JSON.stringify(o.unknownHandle));
  ok('DISCRIMINATES link: old /overlay subscribes to room "default"', o.noRoom.made === 1 && o.noRoom.sent.some((s) => /"room":"default"/.test(s)), JSON.stringify(o.noRoom));
  ok('DISCRIMINATES size: old 720p tile stays 320 wide', o.chip720?.w === 320, JSON.stringify(o.chip720));
  ok('DISCRIMINATES chip: old chip is 12px uppercase with a fringe', o.chip1080.font === '12px' && o.chip720.transform === 'uppercase' && o.chip720.shadow !== 'none');
  ok('DISCRIMINATES hold: old hold layer paints nothing', !/rgb\(47, 42, 216\)/.test(o.hold.bg) && !/Connecting/.test(o.hold.content), JSON.stringify(o.hold));
  ok('DISCRIMINATES clip: old undecodable Holler is still on screen 2.5 s in', o.badClip.appeared && o.badClip.stillUp3s === true, JSON.stringify(o.badClip));
  ok('DISCRIMINATES locks: old never posts tooSmall:false while flagged', !o.flagged.posts.includes(false), JSON.stringify(o.flagged.posts));
  ok('DISCRIMINATES on-air: old airs "BADGE TOO SMALL — NOT EARNING"', o.flagged.visible && /NOT EARNING/.test(o.flagged.text), JSON.stringify(o.flagged));
  ok('DISCRIMINATES fallback: old text code trips at a correct 1080p source', o.legacy.posts.includes(true), JSON.stringify(o.legacy));
} catch (e) {
  ok(`run completed — ${e.stack || e.message}`, false);
} finally {
  await browser?.close().catch(() => {});
  srvNew?.kill();
  srvOld?.kill();
  if (oldDir) { await sleep(800); removeCopy(oldDir); }
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
