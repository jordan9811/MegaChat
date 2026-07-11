/**
 * GATE — MEGA Phase 5: OAuth identity (Twitch + X).
 *
 * Two server instances, both REAL code:
 *   :3213 — no creds → providers report unconfigured, /auth/* answer 503,
 *           join page renders disabled "not configured" buttons.
 *   :3214 — creds set + endpoint bases pointed at a LOCAL MOCK IdP → the
 *           full round-trip (authorize → code → token → user → suffix
 *           picker → claim → cookie → /r/<handle>) runs through the real
 *           handlers with zero external dependencies. Collision handling
 *           and identity persistence asserted.
 */
import { createServer } from 'http';
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Mock IdP (Twitch-shaped) on :3999 ────────────────────────────────────────
const RAND = Math.random().toString(36).slice(2, 8);
const MOCK_LOGIN = 'mock_' + RAND;
const MOCK_USER = { id: 'id_' + RAND, login: MOCK_LOGIN, display_name: MOCK_LOGIN };
const idp = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:3999');
  if (url.pathname === '/oauth2/authorize') {
    // a real IdP would show a consent screen; the mock consents instantly
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'mock-code-123');
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (url.pathname === '/oauth2/token' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ access_token: 'mock-token', token_type: 'bearer' }));
  }
  if (url.pathname === '/helix/users') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [MOCK_USER] }));
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => idp.listen(3999, r));
console.log('  [setup] mock IdP on :3999');

// ── Two app instances ────────────────────────────────────────────────────────
function boot(port, extraEnv) {
  const child = spawn(process.execPath, ['server.js', '--prod'], {
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  return child;
}
const plain = boot(3213, { TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '', X_CLIENT_ID: '', X_CLIENT_SECRET: '' });
const mocked = boot(3214, {
  TWITCH_CLIENT_ID: 'mock-client',
  TWITCH_CLIENT_SECRET: 'mock-secret',
  TWITCH_AUTH_BASE: 'http://localhost:3999/oauth2',
  TWITCH_API_BASE: 'http://localhost:3999/helix',
  X_CLIENT_ID: '',
  X_CLIENT_SECRET: '',
});
await sleep(9000); // both boots (prod mount)

try {
  // ── A. Unconfigured server: honest disabled state ─────────────────────────
  const prov = await (await fetch('http://localhost:3213/api/auth/providers')).json();
  ok('providers report unconfigured', prov.twitch === false && prov.x === false, JSON.stringify(prov));
  const start = await fetch('http://localhost:3213/auth/twitch', { redirect: 'manual' });
  ok('/auth/twitch answers 503 without creds', start.status === 503);

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
  });
  {
    const page = await browser.newPage();
    await page.goto('http://localhost:3213/join?room=default', { waitUntil: 'networkidle2' });
    await sleep(1500);
    const btns = await page.evaluate(() => ({
      twitch: {
        disabled: document.getElementById('authTwitchBtn').disabled,
        text: document.getElementById('authTwitchBtn').textContent.trim(),
      },
      x: {
        disabled: document.getElementById('authXBtn').disabled,
        text: document.getElementById('authXBtn').textContent.trim(),
      },
    }));
    ok('join page renders disabled not-configured buttons',
      btns.twitch.disabled && /not configured/.test(btns.twitch.text)
      && btns.x.disabled && /not configured/.test(btns.x.text),
      JSON.stringify(btns));
    await page.close();
  }

  // ── B. Mock-IdP server: full round-trip through the REAL handlers ─────────
  const prov2 = await (await fetch('http://localhost:3214/api/auth/providers')).json();
  ok('providers report twitch configured', prov2.twitch === true && prov2.x === false);

  const page = await browser.newPage();
  await page.goto('http://localhost:3214/join?room=default', { waitUntil: 'networkidle2' });
  await sleep(1200);
  const enabled = await page.evaluate(() => ({
    disabled: document.getElementById('authTwitchBtn').disabled,
    text: document.getElementById('authTwitchBtn').textContent.trim(),
  }));
  ok('Continue with Twitch enabled', !enabled.disabled && /Continue with Twitch/.test(enabled.text));

  // Click → mock IdP → callback → suffix/claim picker
  await page.click('#authTwitchBtn');
  await page.waitForSelector('#go', { timeout: 15000 });
  const picker = await page.evaluate(() => ({
    handle: document.getElementById('h').value,
    text: document.body.innerText.slice(0, 200),
  }));
  ok('claim picker shows the platform username as suggestion',
    picker.handle === MOCK_LOGIN && /verified/i.test(picker.text), picker.handle);

  await page.click('#go');
  await page.waitForFunction(() => location.pathname === '/join', { timeout: 15000 });
  await sleep(1500);
  const after = await page.evaluate(() => ({
    who: document.getElementById('authIdentity')?.textContent || '',
    username: document.getElementById('username')?.value,
    msg: document.getElementById('message')?.textContent || '',
  }));
  ok('identity chip + username prefill after claim',
    after.who.includes('@' + MOCK_LOGIN) && after.username === MOCK_LOGIN, JSON.stringify(after));
  ok('welcome toast names the handle', after.msg.includes(MOCK_LOGIN));

  // /r/<handle>… handles from IDENTITIES aren't room links (no room yet) —
  // but the handle must now be RESERVED against room claims:
  const clash = await fetch('http://localhost:3214/api/dashboard/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Clash', password: 'phase5-gate', handle: MOCK_LOGIN, config: {} }),
  });
  ok('identity handle blocks room-handle squatting', clash.status === 409, `status ${clash.status}`);

  // Re-auth of the SAME platform user skips the picker (identity persisted).
  await page.goto('http://localhost:3214/auth/twitch', { waitUntil: 'networkidle2' });
  await sleep(800);
  const backUrl = page.url();
  ok('returning user skips the picker (straight to /join?welcome=)',
    backUrl.includes('/join?welcome=' + MOCK_LOGIN), backUrl);

  // Collision → suffix suggestion: wipe cookies (new browser context) and
  // sign in as a DIFFERENT platform id with the SAME username.
  MOCK_USER.id = 'id2_' + RAND;
  const ctx = await browser.createBrowserContext();
  const p2 = await ctx.newPage();
  await p2.goto('http://localhost:3214/auth/twitch', { waitUntil: 'networkidle2' });
  await p2.waitForSelector('#h', { timeout: 15000 });
  const suggested = await p2.evaluate(() => document.getElementById('h').value);
  ok('collision suggests a suffixed handle',
    suggested.startsWith(MOCK_LOGIN + '_') && /_\d+$/.test(suggested), suggested);
  // picker lets them edit — try to grab the TAKEN name → 409 shown inline
  await p2.evaluate((l) => { document.getElementById('h').value = l; }, MOCK_LOGIN);
  await p2.click('#go');
  await sleep(800);
  const err = await p2.evaluate(() => document.getElementById('err').textContent);
  ok('claiming a taken handle errors inline', /taken/i.test(err), err);
  await p2.click('#go');
  // (second click still taken — now claim the suggestion)
  await p2.evaluate(() => { document.getElementById('h').value = ''; });
  await p2.evaluate((s) => { document.getElementById('h').value = s; }, suggested);
  await p2.click('#go');
  await p2.waitForFunction(() => location.pathname === '/join', { timeout: 15000 });
  ok('suffixed claim lands', true);
  await ctx.close();
  await browser.close();
} finally {
  plain.kill();
  mocked.kill();
  idp.close();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
