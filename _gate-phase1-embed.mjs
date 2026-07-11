/**
 * GATE — MEGA Phase 1: embedded target stream + watch-to-earn surface.
 *  1. twitchChannel round-trips: create room with channel + rewards → config
 *     API returns the sanitized channel; bad channels come back null.
 *  2. Join page renders the official Twitch embed (player.twitch.tv iframe,
 *     right channel, parent = page host) with the delay label; the drops
 *     hint shows because rewards are on.
 *  3. A room WITHOUT a channel hides the embed cleanly.
 *  4. Drops accrue while watching: a rewards WS session (wallet + visible)
 *     receives rewards_earned on the room's interval.
 *  5. Join flow unregressed: join card controls all present, no console
 *     errors on either room.
 */
import WebSocket from 'ws';
import puppeteer from 'puppeteer-core';

const BASE = process.env.GATE_BASE_URL || 'http://localhost:3212';
const WS_URL = BASE.replace(/^http/, 'ws');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── 1. Room with channel + fast rewards; sanitize check ─────────────────────
const mk = async (name, config) => {
  const res = await fetch(`${BASE}/api/dashboard/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: 'phase1-gate', config }),
  });
  const data = await res.json();
  if (res.status !== 201) { console.error('create failed', data); process.exit(1); }
  return data.room;
};

const roomA = await mk('Embed Gate A', {
  twitchChannel: '@MegaChatTV', // @ + caps → must sanitize to megachattv
  rewards: { enabled: true, earnInterval: 2, earnAmount: '3', earnCap: '9', rewardType: 'points', rewardTokenAddress: null },
});
const roomB = await mk('Embed Gate B', {}); // no channel

ok('sanitizer normalizes @MegaChatTV → megachattv', roomA.twitchChannel === 'megachattv', roomA.twitchChannel);
const cfgA = await (await fetch(`${BASE}/api/config?room=${roomA.id}`)).json();
ok('config API exposes twitchChannel + rewardsEnabled',
  cfgA.twitchChannel === 'megachattv' && cfgA.rewardsEnabled === true,
  `channel=${cfgA.twitchChannel} rewards=${cfgA.rewardsEnabled}`);
const bad = await mk('Embed Gate Bad', { twitchChannel: 'x y!!' });
ok('invalid channel stored as null', bad.twitchChannel === null, String(bad.twitchChannel));

// ── 2+3+5. Browser: embed renders on A, hidden on B, join flow intact ───────
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
});
const page = await browser.newPage();
const errors = [];
// Benign third-party noise: Privy's background auth iframe (CSP chatter,
// 40x on its own endpoints), Twitch player internals, favicons.
const BENIGN = /privy|twitch|favicon|\.well-known|ERR_BLOCKED|Content Security Policy/i;
page.on('console', (m) => {
  // Bare "Failed to load resource" lines carry no URL — the response hook
  // below captures the same events WITH urls and the benign filter.
  if (m.type() === 'error' && !BENIGN.test(m.text())
      && !/^Failed to load resource/.test(m.text())) {
    errors.push(m.text().slice(0, 140));
  }
});
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 140)));
page.on('response', (r) => {
  if (r.status() >= 400 && !BENIGN.test(r.url())) {
    errors.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`);
  }
});

await page.goto(`${BASE}/join?room=${roomA.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));
const probeA = await page.evaluate(() => {
  const wrap = document.getElementById('streamPreview');
  const iframe = document.querySelector('#streamPreviewMount iframe');
  const drops = document.getElementById('streamPreviewDrops');
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
  return {
    wrapVisible: vis(wrap),
    src: iframe ? iframe.src : null,
    label: wrap ? wrap.textContent.includes('~15s behind live') : false,
    dropsVisible: vis(drops),
    joinControls: ['username', 'joinBtn', 'passkeyBtn', 'connectBtn', 'priceAmount']
      .every((id) => !!document.getElementById(id)),
  };
});
ok('embed visible on room with channel', probeA.wrapVisible);
ok('official Twitch player, right channel + parent',
  !!probeA.src && probeA.src.startsWith('https://player.twitch.tv/')
  && probeA.src.includes('channel=megachattv') && probeA.src.includes('parent=localhost'),
  probeA.src);
ok('delay label present', probeA.label);
ok('drops hint visible (rewards on)', probeA.dropsVisible);
ok('join controls intact on room A', probeA.joinControls);

await page.goto(`${BASE}/join?room=${roomB.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 2000));
const probeB = await page.evaluate(() => {
  const wrap = document.getElementById('streamPreview');
  return {
    hidden: !wrap || getComputedStyle(wrap).display === 'none',
    iframeCount: document.querySelectorAll('#streamPreviewMount iframe').length,
    joinControls: ['username', 'joinBtn', 'priceAmount'].every((id) => !!document.getElementById(id)),
  };
});
ok('embed hidden cleanly when no channel set', probeB.hidden && probeB.iframeCount === 0);
ok('join controls intact on room B', probeB.joinControls);
ok('no first-party console/network errors on either room', errors.length === 0, errors.join(' | '));
await browser.close();

// ── 4. Drops accrue while watching (rewards WS session on room A) ───────────
{
  const wallet = '0x' + 'a1'.repeat(20);
  const ws = new WebSocket(WS_URL);
  const earned = [];
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'rewards_register', wallet, roomId: roomA.id }));
  ws.send(JSON.stringify({ type: 'rewards_visibility', visible: true }));
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'rewards_earned' && m.credited) earned.push(m);
    } catch { /* ignore */ }
  });
  await new Promise((r) => setTimeout(r, 5500)); // interval=2s → expect ≥2 credits
  ok('drops accrue while watching', earned.length >= 2,
    `${earned.length} credits, last session total ${earned.at(-1)?.earnedSession ?? '—'} PTS`);
  ws.close();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
