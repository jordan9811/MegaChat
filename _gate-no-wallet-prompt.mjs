/**
 * GATE — opening a room never pops a wallet chooser, and sign-in still works.
 *
 * The owner, 2026-09-25: clicking a card on the board opened the room and
 * Phantom popped "Which extension do you want to connect with?". With MetaMask
 * AND Phantom installed, window.ethereum is Phantom's proxy, and any call on it
 * shows that chooser. The join page asked window.ethereum for accounts the
 * moment it loaded (web/lib/join-page.ts). Wallets also announce their OWN
 * providers through EIP-6963; calls on those never involve the chooser.
 *
 * The fake here is that setup: window.ethereum is the chooser (every call on it
 * recorded as a popup), and MetaMask and Phantom each announce a provider.
 *
 *   W1  a room page, by handle and by id, never calls window.ethereum on load
 *   W2  the board never does either
 *   W3  a returning MetaMask viewer is still recognised silently, through
 *       MetaMask's own provider (their watch time counts from page load)
 *   W4  sign-in is not broken: Privy becomes ready (window.MegaWallet.ready) —
 *       the check that catches Privy's disableAllExternalWallets, which looked
 *       like a fix for this and stops every new sign-in instead
 *   W0  the recorder does see a call (so the zeros mean something)
 *
 * `--base https://megachat.fun` checks a deployed build: the build before this
 * fix fails W1 there (eth_accounts on the chooser at load).
 */
import puppeteer from 'puppeteer-core';
import { assertFreshBuild, startGateServer } from './_gate-helpers.mjs';

const bi = process.argv.indexOf('--base');
const REMOTE = bi > 0 ? process.argv[bi + 1].replace(/\/$/, '') : null;
const PORT = 3295;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
};

const FAKE_WALLETS = () => {
  window.__chooser = []; // calls on window.ethereum — each one is Phantom's popup
  window.__mm = [];
  window.__ph = [];
  const make = (log, accounts) => ({
    request: async (args) => { log.push(`request:${args && args.method}`); return args && args.method === 'eth_accounts' ? accounts : null; },
    on: (event) => { log.push(`on:${event}`); },
    removeListener: () => {},
  });
  const chooser = { ...make(window.__chooser, []), isMetaMask: true, isPhantom: true };
  Object.defineProperty(window, 'ethereum', { value: chooser, configurable: true });
  const mm = make(window.__mm, ['0x1111111111111111111111111111111111111111']);
  const ph = make(window.__ph, []);
  const announce = () => {
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'mm-uuid', name: 'MetaMask', icon: 'data:,', rdns: 'io.metamask' }, provider: mm }) }));
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'ph-uuid', name: 'Phantom', icon: 'data:,', rdns: 'app.phantom' }, provider: ph }) }));
  };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
};

console.log(`\n── opening a room never pops a wallet chooser (${REMOTE || 'local'}) ──`);
let srv = null;
let APP = REMOTE;
if (!REMOTE) {
  const fresh = assertFreshBuild();
  ok('G0. the build under test is newer than the source it renders', fresh.ok, fresh.detail);
  if (!fresh.ok) { console.log(`\nRESULT: ${pass} pass, ${fail} fail`); process.exit(1); }
  // Privy only mounts with an app id; use the one production serves to every
  // browser (public, read at run time, never written down) unless one is set.
  let privyId = process.env.PRIVY_APP_ID || process.env.NEXT_PUBLIC_PRIVY_APP_ID || null;
  if (!privyId) {
    privyId = await fetch('https://megachat.fun/api/config?room=default').then((r) => r.json()).then((j) => j?.privy?.appId || null).catch(() => null);
  }
  ok('G1. Privy mounts in this run (else W2 and W4 would test nothing)', !!privyId);
  srv = await startGateServer({ port: PORT, label: 'no-wallet-prompt', env: privyId ? { PRIVY_APP_ID: privyId } : {} });
  APP = `http://localhost:${PORT}`;
}
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const pages = REMOTE
    ? [['room by handle', '/jordandotfun'], ['room by id', '/join?room=default'], ['board', '/app']]
    : [['room by id', '/join?room=default'], ['demo room by handle', '/demo'], ['board', '/app']];
  for (const [label, url] of pages) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(FAKE_WALLETS);
    // What the page sends over its sockets: a silent registration is a
    // rewards_register frame carrying the MetaMask address.
    const frames = [];
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameSent', (e) => frames.push(String(e.response?.payloadData || '')));
    await page.goto(`${APP}${url}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(6000); // everything the page does on its own, it has done by now
    const got = await page.evaluate(() => ({ chooser: window.__chooser, mm: window.__mm, ready: !!(window.MegaWallet && window.MegaWallet.ready) }));
    const board = label === 'board';
    ok(`${board ? 'W2' : 'W1'} ${label} (${url}) never calls window.ethereum on load (no chooser)`, got.chooser.length === 0, JSON.stringify(got.chooser));
    if (!board) {
      const registered = frames.some((f) => f.includes('rewards_register') && f.includes('0x1111111111111111111111111111111111111111'));
      ok(`W3 ${label}: a returning MetaMask viewer is registered silently (watch time from page load), through MetaMask's own provider`,
        registered, `${frames.filter((f) => f.includes('rewards_register')).length} rewards_register frame(s)`);
    }
    if (board && !REMOTE) {
      // Privy only answers the origins its app allows, so from localhost it
      // never becomes ready whatever this code does. Said, not skipped quietly.
      console.log('  NOTE  W4 runs against the deployed site only (--base): Privy refuses localhost');
    }
    if (board && REMOTE) {
      const ready = got.ready || await page.waitForFunction(() => !!(window.MegaWallet && window.MegaWallet.ready), { timeout: 15000 }).then(() => true).catch(() => false);
      ok('W4 sign-in is not broken: Privy becomes ready (window.MegaWallet.ready)', ready);
    }
    if (label === 'room by id') {
      await page.evaluate(() => window.ethereum.request({ method: 'eth_chainId' }));
      const after = await page.evaluate(() => window.__chooser);
      ok('W0 the recorder does see a call (so the zeros mean something)', after.includes('request:eth_chainId'), JSON.stringify(after));
    }
    await page.close();
  }
} catch (e) {
  fail++;
  console.log(`  FAIL  harness threw: ${e.message}`);
} finally {
  await browser.close().catch(() => {});
  if (srv) srv.kill();
  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
