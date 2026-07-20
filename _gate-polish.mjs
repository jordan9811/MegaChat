/**
 * GATE — FIX + POLISH pass, all seven items, on the real built app.
 *
 *  1. tx errors: viem InsufficientBalance wall → ONE clean sentence with
 *     have/costs in BOTH modes (credits + USDC) + Add funds; unknown wall →
 *     generic + collapsible raw details; short app errors pass through.
 *  2. free-room checkbox: backspacing the price to empty does NOT check it;
 *     create disables + inline hint; checking free still hides the price.
 *  3. mic visually centered at mobile + desktop (alpha-mass math, ±8px);
 *     og.png is 1200x630 and the meta points at it.
 *  4. landing hero: How it works replaces Browse rooms; browse still in nav.
 *  5. account layer: seeded identity + sealed cookie → Account tab (handle
 *     link + linked accounts), Defaults save → prefills a fresh create form,
 *     clear → stock; header menu deep-links ?section=account.
 *  6. no "15s"/"15 seconds" in rendered join/how-it-works/landing text.
 *  7. new hero sentence + equation line present; old credits sentence gone.
 *  Both themes sanity-checked on landing + dashboard (distinct bg, text
 *  legible), Simple/Advanced both exercised in item 1.
 */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHmac } from 'crypto';
import puppeteer from 'puppeteer-core';

try { process.loadEnvFile(); } catch { /* env external */ }

const PORT = 3218;
const APP = `http://localhost:${PORT}`;
const AUTH_SECRET = 'polish-gate-secret';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seeded identity → sealed cookie, same HMAC the server uses.
const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-polish-'));
writeFileSync(path.join(dataDir, 'identities.json'), JSON.stringify({
  identities: {
    'twitch:gate1': {
      provider: 'twitch', platformId: 'gate1', username: 'gatestreamer',
      handle: 'gatestreamer', createdAt: new Date().toISOString(),
    },
  },
  handles: { gatestreamer: 'twitch:gate1' },
}));
const seal = (obj) => {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${payload}.${createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')}`;
};
const identityCookie = {
  name: 'mc_identity',
  value: encodeURIComponent(seal({ provider: 'twitch', platformId: 'gate1' })),
  domain: 'localhost',
  path: '/',
};

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(PORT), AUTH_SECRET, DATA_DIR: dataDir, KEEP_ORPHAN_ROOMS: 'true' },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(9000);

// viem-shaped fixtures (signature line + values line, like the real wall)
const WALL_INSUFFICIENT = `The contract function "transferFrom" reverted.

Error: InsufficientBalance(address sender, uint256 balance, uint256 needed)
                          (0x1f2a3B4c5D6e7F8a9b0C1d2E3f4A5b6C7d8E9f0A, 20000, 1010000)

Contract Call:
  address:   0x20c000000000000000000000b9537d11c60e8b50
  function:  transferFrom(address from, address to, uint256 value)
  args:                  (0x1f2a3B4c5D6e7F8a9b0C1d2E3f4A5b6C7d8E9f0A, 0x9999, 1010000)

Docs: https://viem.sh/docs/contract/simulateContract
Version: viem@2.21.0`;
const WALL_UNKNOWN = `RpcRequestError: HTTP request failed.

Status: 503
URL: https://rpc.tempo.xyz
Request body: {"method":"eth_sendRawTransaction","params":["0x02f87082..."]}

Details: upstream connect error or disconnect/reset before headers
Version: viem@2.21.0`;

try {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', protocolTimeout: 90000,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });

  // ── 1. human-readable tx errors, through the REAL message pipeline ─────────
  const join = await browser.newPage();
  await join.goto(`${APP}/join`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1200);

  const msgState = () => join.evaluate(() => {
    const m = document.getElementById('message');
    const details = m?.querySelector('details.tx-details');
    return {
      text: (m?.innerText || '').slice(0, 400),
      hasDetails: !!details,
      raw: details ? (details.querySelector('pre')?.textContent || '') : '',
      hasAddFunds: !!m?.querySelector('.tx-addfunds'),
    };
  });

  await join.evaluate(async (wall) => { await window.showTxError('', new Error(wall), { need: '2' }); }, WALL_INSUFFICIENT);
  let m = await msgState();
  ok('1. insufficient → one clean sentence with have/costs (advanced: USDC)',
    /Not enough balance — you have 0\.02 .*this costs 1\.01/.test(m.text), m.text.split('\n')[0]);
  ok('1. insufficient → [Add funds] attached, no raw wall dumped',
    m.hasAddFunds && !m.text.includes('0x20c0') && !m.text.includes('viem.sh'));

  await join.evaluate(() => { document.documentElement.dataset.ui = 'simple'; });
  await join.evaluate(async (wall) => { await window.showTxError('', new Error(wall), { need: '2' }); }, WALL_INSUFFICIENT);
  m = await msgState();
  ok('1. simple mode: SAME failure reads in credits',
    /Not enough balance — you have \d+ credits.*costs \d+ credits/.test(m.text.replace(/\n/g, ' ')), m.text.split('\n')[0]);
  await join.evaluate(() => { document.documentElement.dataset.ui = 'advanced'; });

  await join.evaluate(async (wall) => { await window.showTxError('', new Error(wall), {}); }, WALL_UNKNOWN);
  m = await msgState();
  ok('1. unknown wall → short generic + collapsible technical details',
    /didn't go through/i.test(m.text) && m.hasDetails && m.raw.includes('eth_sendRawTransaction'));
  ok('1. unknown wall → raw hidden behind the expander (not in the open text)',
    !m.text.includes('eth_sendRawTransaction'));

  await join.evaluate(async () => { await window.showTxError('', new Error('This room is not accepting new joins right now.'), {}); });
  m = await msgState();
  ok('1. short app errors pass through untouched (no expander)',
    m.text.includes('not accepting new joins') && !m.hasDetails);

  // ── landing: items 3 / 4 / 7 (+6 on its text) ──────────────────────────────
  const land = await browser.newPage();
  await land.setViewport({ width: 1280, height: 900 });
  await land.goto(APP, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1000);

  const hero = await land.evaluate(() => {
    const section = document.querySelector('section');
    // hero ACTION slots only — the shared FooterNav strip lives inside the
    // same <section>, so nav links must not count as hero slots
    const links = [...(section?.querySelectorAll('a') || [])]
      .filter((a) => !a.closest('nav'))
      .map((a) => a.textContent.trim());
    const nav = [...document.querySelectorAll('nav a')].map((a) => a.textContent.trim());
    return {
      heroLinks: links,
      navHasBrowse: nav.some((t) => /browse rooms/i.test(t)),
      // scoped to the hero <section> only — the browse directory below the
      // fold legitimately prints "USDC" per room card and must not count
      heroText: section?.innerText || '',
      bodyText: document.body.innerText,
    };
  });
  ok('4. hero: "How it works" is a hero action', hero.heroLinks.some((t) => /how it works/i.test(t)));
  ok('4. hero: "Browse rooms" removed from the hero slot', !hero.heroLinks.some((t) => /browse rooms/i.test(t)));
  ok('4. hero: "Create room" is a hero action (matches the dashboard\'s own button label)',
    hero.heroLinks.some((t) => /create room/i.test(t)));
  ok('4. browse still reachable from the nav', hero.navHasBrowse);
  // ONE sentence, no mode split, no USDC — same text in Simple and Advanced.
  ok('7a. exact sentence: "pay per second … camera ON your live broadcast", no USDC',
    /pay per second to put their camera on your live broadcast/i.test(hero.heroText)
    && !/USDC/.test(hero.heroText));
  const simpleText = await land.evaluate(() => {
    document.documentElement.dataset.ui = 'simple';
    const t = document.body.innerText;
    document.documentElement.dataset.ui = 'advanced';
    return t;
  });
  ok('7a. identical in simple mode (no mode split on this line)',
    /pay per second to put their camera on your live broadcast/i.test(simpleText));
  ok('7a. old credits/in-your sentences gone',
    !/spend credits by the second/i.test(hero.bodyText + simpleText)
    && !/camera in your live/i.test(hero.bodyText + simpleText));
  ok('7b. equation brand line present',
    /Call-in show\s*\+\s*FaceTime\s*\+\s*Superchat\s*=\s*MegaChat/i.test(hero.bodyText.replace(/\n/g, ' ')));
  ok('6. landing text has no 15-second claim', !/15\s*s(econds)?\b/i.test(hero.bodyText));

  // mic centering — alpha-mass center vs its column center (measured ratios
  // from _diag-mic-bbox.mjs: mass sits at x=319.96/698 of the canvas)
  const micCheck = async (page) => page.evaluate(() => {
    const img = document.querySelector('img[alt="Crowned glitch microphone"]');
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const massX = r.left + r.width * (319.96 / 698);
    // the fix translates the container +4.5% — its PRE-translate center is
    // where mx-auto centered it in the column; the mass must land there
    const holder = img.closest('.reveal');
    const h = holder.getBoundingClientRect();
    const preCenter = h.left + h.width / 2 - 0.045 * h.width;
    return { off: massX - preCenter, w: r.width };
  });
  let mic = await micCheck(land);
  ok('3. mic mass centered on desktop (±8px)', mic && Math.abs(mic.off) <= 8, `off=${mic?.off?.toFixed(1)}px`);
  await land.setViewport({ width: 375, height: 812 });
  await sleep(600);
  mic = await micCheck(land);
  ok('3. mic mass centered on MOBILE (±8px)', mic && Math.abs(mic.off) <= 8, `off=${mic?.off?.toFixed(1)}px`);

  // og image + meta
  const ogRes = await fetch(`${APP}/og.png`);
  const ogBuf = Buffer.from(await ogRes.arrayBuffer());
  const w = ogBuf.readUInt32BE(16), h = ogBuf.readUInt32BE(20); // PNG IHDR
  ok('3. /og.png serves a real 1200x630 PNG', ogRes.ok && w === 1200 && h === 630, `${w}x${h}`);
  const landHtml = await (await fetch(APP)).text();
  ok('3. og:image + twitter card point at it',
    /property="og:image"[^>]*og\.png/.test(landHtml) && /og:image:width[^>]*1200/.test(landHtml)
    && /twitter:card[^>]*summary_large_image/.test(landHtml));

  // ── 6. join + how-it-works rendered text ───────────────────────────────────
  const joinText = await join.evaluate(() => document.body.innerText);
  const fifteen = (joinText.match(/[^\n]*\b15\s*s(econds)?\b[^\n]*/i) || [])[0] || '';
  ok('6. join page: no 15-second claim', !fifteen, fifteen.slice(0, 100));
  const hiw = await browser.newPage();
  await hiw.goto(`${APP}/how-it-works`, { waitUntil: 'networkidle2', timeout: 60000 });
  const hiwText = await hiw.evaluate(() => document.body.innerText);
  ok('6. how-it-works: no 15-second claim', !/15\s*s(econds)?\b/i.test(hiwText) && !/fifteen seconds/i.test(hiwText));

  // ── 2. free-room checkbox vs price field ───────────────────────────────────
  const dash = await browser.newPage();
  await dash.goto(`${APP}/dashboard`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1200);
  const priceState = () => dash.evaluate(() => ({
    free: document.getElementById('free-room')?.checked ?? null,
    price: document.getElementById('price')?.value ?? null,
    priceVisible: !!document.getElementById('price'),
    hint: !!document.getElementById('price-invalid'),
    // LAST match — the first "Create room" button is the TAB, the submit
    // sits at the bottom of the form
    createDisabled: [...document.querySelectorAll('button')]
      .filter((b) => /create room|launch/i.test(b.textContent))
      .pop()?.disabled ?? null,
  }));
  // React-controlled input: clear via select-all + Backspace with the
  // KEYBOARD (a triple-click can miss the affix-wrapped input entirely)
  const clearPrice = async (page) => {
    await page.focus('#price');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
  };
  let ps = await priceState();
  ok('2. baseline: price filled, free unchecked', ps.free === false && parseFloat(ps.price) > 0, JSON.stringify(ps));
  await clearPrice(dash);
  await sleep(300);
  ps = await priceState();
  ok('2. EMPTY price does NOT auto-check free', ps.free === false && ps.price === '');
  ok('2. empty price → inline hint + create disabled', ps.hint && ps.createDisabled === true, JSON.stringify(ps));
  await dash.type('#price', '0.005');
  await sleep(300);
  ps = await priceState();
  ok('2. typing a price clears the hint + re-enables create',
    !ps.hint && ps.createDisabled === false && ps.free === false);
  await dash.click('#free-room');
  await sleep(300);
  ps = await priceState();
  ok('2. checking FREE hides the price box (kept behavior)', ps.free === true && !ps.priceVisible);
  await dash.click('#free-room');
  await sleep(300);
  ps = await priceState();
  ok('2. unchecking restores a sane price', ps.free === false && ps.price === '0.001');

  // ── 5. account layer (seeded identity, sealed cookie) ──────────────────────
  const acct = await browser.newPage();
  await acct.setCookie(identityCookie);
  await acct.goto(`${APP}/dashboard?section=account`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  const acctState = await acct.evaluate(() => ({
    tabActive: document.getElementById('section-account')?.getAttribute('aria-current') === 'page',
    handleLink: [...document.querySelectorAll('code')].some((c) => /\/gatestreamer/.test(c.textContent)),
    linked: document.getElementById('linked-accounts')?.innerText || '',
    roomsHidden: !document.getElementById('price')?.offsetParent,
  }));
  ok('5. ?section=account deep-link lands on the Account tab', acctState.tabActive);
  ok('5. handle shown as your room link', acctState.handleLink);
  ok('5. linked accounts listed (twitch identity)', /twitch/i.test(acctState.linked) && /gatestreamer/.test(acctState.linked));

  // Defaults: tune the create form → save → fresh page prefilled → clear.
  await acct.evaluate(() => document.getElementById('section-rooms').click());
  await sleep(400);
  await clearPrice(acct);
  await acct.type('#price', '0.042');
  await sleep(300);
  await acct.evaluate(() => document.getElementById('section-defaults').click());
  await sleep(400);
  await acct.click('#save-defaults');
  await sleep(800);
  const summary = await acct.evaluate(() => document.getElementById('defaults-summary')?.innerText || '');
  ok('5. save defaults → summary reflects the saved price', /0\.042/.test(summary), summary.slice(0, 60));

  const acct2 = await browser.newPage();
  await acct2.setCookie(identityCookie);
  await acct2.goto(`${APP}/dashboard`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1800);
  const prefilled = await acct2.evaluate(() => document.getElementById('price')?.value);
  ok('5. fresh dashboard: create form STARTS from saved defaults', prefilled === '0.042', `price=${prefilled}`);
  await acct2.evaluate(() => document.getElementById('section-defaults').click());
  await sleep(400);
  await acct2.click('#clear-defaults');
  await sleep(800);
  const acct3 = await browser.newPage();
  await acct3.setCookie(identityCookie);
  await acct3.goto(`${APP}/dashboard`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1800);
  const stock = await acct3.evaluate(() => document.getElementById('price')?.value);
  ok('5. cleared → back to stock settings', stock === '0.001', `price=${stock}`);

  // header menu carries the Account entry
  const menu = await acct3.evaluate(async () => {
    const chip = [...document.querySelectorAll('header button')].find((b) => /@|account/i.test(b.textContent));
    chip?.click();
    await new Promise((r) => setTimeout(r, 300));
    return [...document.querySelectorAll('[role="menu"] a')].map((a) => `${a.textContent.trim()}→${a.getAttribute('href')}`).join(' | ');
  });
  ok('5. header chip menu deep-links to Account', /Account→\/dashboard\?section=account/.test(menu), menu.slice(0, 120));

  // ── themes: both render with distinct backgrounds + visible text ───────────
  const themed = async (page, cls) => page.evaluate((c) => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(c);
    const bg = getComputedStyle(document.body).backgroundColor;
    const el = document.querySelector('h1, h2, .font-heading');
    return { bg, color: el ? getComputedStyle(el).color : null };
  }, cls);
  const darkT = await themed(land, 'dark');
  const lightT = await themed(land, 'light');
  ok('themes: landing renders distinct light/dark backgrounds',
    darkT.bg !== lightT.bg && !!darkT.color && !!lightT.color, `${darkT.bg} vs ${lightT.bg}`);
  const dashDark = await themed(dash, 'dark');
  const dashLight = await themed(dash, 'light');
  ok('themes: dashboard renders distinct light/dark backgrounds', dashDark.bg !== dashLight.bg);

  // ── Create-room CTA: readable against its OWN background in both themes ───
  // (the earlier tinted-border/10%-fill lime button was reported hard to
  // read in light mode — this checks the fix holds, not just that it exists)
  const ctaContrast = await land.evaluate((theme) => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
    const a = [...document.querySelectorAll('a')].find((x) => /create room/i.test(x.textContent));
    if (!a) return null;
    const cs = getComputedStyle(a);
    // getComputedStyle can serialize wide-gamut CSS colors as lab()/oklch()
    // (Chrome does, for our oklch() tokens) — a naive rgb()-regex parse
    // silently mis-reads those. Painting onto a canvas always normalizes to
    // 8-bit sRGB regardless of the input's serialization.
    const probe = document.createElement('canvas');
    probe.width = 1; probe.height = 1;
    const pctx = probe.getContext('2d');
    const parse = (c) => {
      pctx.clearRect(0, 0, 1, 1);
      pctx.fillStyle = c;
      pctx.fillRect(0, 0, 1, 1);
      return [...pctx.getImageData(0, 0, 1, 1).data];
    };
    const lum = ([r, g, b]) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgL = lum(parse(cs.backgroundColor));
    const fgL = lum(parse(cs.color));
    const ratio = (Math.max(bgL, fgL) + 0.05) / (Math.min(bgL, fgL) + 0.05);
    return { ratio, bg: cs.backgroundColor, fg: cs.color };
  }, 'light');
  ok('CTA: "Create room" button text passes WCAG AA against its own fill in LIGHT mode',
    ctaContrast && ctaContrast.ratio >= 4.5, ctaContrast ? `${ctaContrast.ratio.toFixed(2)}:1 (${ctaContrast.fg} on ${ctaContrast.bg})` : 'button not found');

  await browser.close();
} finally {
  app.kill();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
