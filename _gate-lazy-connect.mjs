/**
 * GATE — LiveKit lazy connect.
 *
 * Proves the fix for the leak documented in LIVEKIT-AUDIT.md: the overlay used
 * to open a subscriber connection on page load and never close it, so an OBS
 * browser source burned billed participant-minutes with nobody on camera.
 *
 * Runs against the REAL local SFU (tools/livekit-server.exe --dev) so
 * "connected" means actually connected, and against the real session ledger so
 * "zero minutes" is measured rather than asserted.
 *
 *  A. IDLE COSTS NOTHING — overlay open, no guests: no LiveKit connection ever
 *     forms and the ledger accrues zero minutes. Held across a window long
 *     enough to catch a delayed/retried connect.
 *  B. PAY FLOW — prewarm (join-sheet-open) connects BEFORE any seat exists;
 *     seat grant keeps it; vacate does NOT hang up instantly (grace); after
 *     grace it disconnects and the ledger closes the record.
 *  C. SIGNAL RECOVERY — kill the overlay's WS mid-idle; the heartbeat/polling
 *     fallback still delivers a later wake.
 *  D. STINGER-FIRST HOLD — stinger reveal frame passes before the track lands:
 *     the tile holds, no empty video frame, and reveal fires when the track
 *     arrives.
 *  E. NO STINGER REPLAY — a second track attach on an already-revealed seat
 *     (reconnect / camera toggle) takes the fallback fade, never the entry
 *     animation.
 *  F. NO FLAP — two guests back to back inside the grace window produce no
 *     disconnect between them.
 *  G. FLAG OFF — LAZY_CONNECT=0 restores connect-on-mount exactly.
 */
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// Short grace so the gate is fast; the production default is 60s.
const GRACE_MS = 4000;
// Isolated ledger per run — the real one persists by design (observability),
// so a shared DATA_DIR would let a previous run's minutes pollute the
// zero-burn assertion.
const SCRATCH = process.env.GATE_DATA_DIR
  || `${process.env.TEMP || '/tmp'}/mc-lazy-gate-${Date.now()}`;
const LK_ENV = {
  DATA_DIR: SCRATCH,
  LIVEKIT_URL: 'ws://localhost:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'secret',
  LAZY_GRACE_MS: String(GRACE_MS),
  LAZY_HEARTBEAT_MS: '1500',
  LAZY_SIGNAL_POLL_MS: '1200',
};

const health = await fetch('http://localhost:7880').then((r) => r.text()).catch(() => '');
if (!health.includes('OK')) {
  console.error('local livekit-server not running — start tools/livekit-server.exe --dev');
  process.exit(1);
}

const launch = (port, extra = {}) =>
  spawn(process.execPath, ['server.js', '--prod'], {
    env: { ...process.env, PORT: String(port), ...LK_ENV, ...extra },
    stdio: 'ignore', cwd: process.cwd(),
  });

// ── H. ABANDON CAP — release at the cap, never at prewarmTtlMs ─────────────
// Pure in-process: the thing under test is our timer logic, not Cloud
// behaviour, so this costs zero LiveKit minutes.
{
  process.env.LAZY_ABANDON_MS = '1000';
  process.env.LAZY_PREWARM_TTL_MS = '300000'; // 5 min — must NOT be what fires
  const { createActivityManager } = await import('./livekit-activity.js?abandon=1');
  const mgr = createActivityManager({
    log: { log() {}, warn() {} }, broadcastToRoom: () => {}, hasOverlay: () => true,
  });

  // Abandonment at each stage of the flow.
  for (const stage of ['sheet-open', 'wallet-connect', 'wallet-approve', 'tx-pending']) {
    const roomId = `ab-${stage}`;
    const tok = mgr.prewarm(roomId);
    if (stage !== 'sheet-open') mgr.prewarmProgress(roomId, tok, stage);
    ok(`H. abandon at "${stage}": holding before the cap`, mgr.desired(roomId) === 'wake');
    await sleep(1400);
    ok(`H. abandon at "${stage}": RELEASED at the cap (not the 5-min TTL)`,
      mgr.desired(roomId) === 'sleep');
  }

  // A slow but real join must NOT be clipped.
  const slowRoom = 'ab-slow';
  const slowTok = mgr.prewarm(slowRoom);
  let stillWake = true;
  for (let i = 0; i < 5; i++) {
    await sleep(500);
    mgr.prewarmProgress(slowRoom, slowTok, 'wallet-approve');
    if (mgr.desired(slowRoom) !== 'wake') stillWake = false;
  }
  ok('H. a SLOW legit join reporting progress is never clipped (2.5s > 1s cap)', stillWake);
  await sleep(1400);
  ok('H. …and releases once it finally goes silent', mgr.desired(slowRoom) === 'sleep');

  ok('H. an unknown progress stage does not reset the clock',
    mgr.prewarmProgress('ab-slow', slowTok, 'not-a-real-stage') === false);
  delete process.env.LAZY_ABANDON_MS;
  delete process.env.LAZY_PREWARM_TTL_MS;
}

// ── I. WEBHOOKS — signed, idempotent, authoritative ────────────────────────
{
  const { createHmac, createHash } = await import('crypto');
  const { verifyWebhookJwt, createWebhookTracker, reconcile } = await import('./livekit-webhooks.js');
  const KEY = 'APIgate', SECRET = 'gatesecret';
  const sign = (body) => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const p = Buffer.from(JSON.stringify({
      iss: KEY, iat: now, exp: now + 300,
      sha256: createHash('sha256').update(body).digest('base64'),
    })).toString('base64url');
    return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
  };
  const mkEvent = (event, identity, room, tsSec) => JSON.stringify({
    id: `${event}:${identity}:${tsSec}`, event,
    room: { name: room }, participant: { identity, sid: `sid-${identity}` }, createdAt: tsSec,
  });

  const body = mkEvent('participant_joined', 'overlay:r1', 'r1', 1700000000);
  let accepted = false;
  try { verifyWebhookJwt(`Bearer ${sign(body)}`, body, { apiKey: KEY, apiSecret: SECRET }); accepted = true; } catch { /* */ }
  ok('I. a correctly signed delivery is accepted', accepted);

  const rejects = [];
  try { verifyWebhookJwt(null, body, { apiKey: KEY, apiSecret: SECRET }); } catch (e) { rejects.push('unsigned'); }
  try {
    const other = mkEvent('participant_joined', 'ATTACKER', 'r1', 1700000000);
    verifyWebhookJwt(`Bearer ${sign(body)}`, other, { apiKey: KEY, apiSecret: SECRET });
  } catch (e) { rejects.push('tampered'); }
  try {
    const badSig = sign(body).replace(/.$/, 'X');
    verifyWebhookJwt(`Bearer ${badSig}`, body, { apiKey: KEY, apiSecret: SECRET });
  } catch (e) { rejects.push('badsig'); }
  ok('I. unsigned / tampered-body / bad-signature all REJECTED',
    rejects.length === 3, rejects.join(','));

  // statePath:null — section I is about event handling, not persistence, and
  // a tracker that quietly loaded real metering state would make these cases
  // depend on whatever the last run left behind.
  const tracker = createWebhookTracker({ log: { log() {}, warn() {}, error() {} }, statePath: null });
  const joinEv = JSON.parse(mkEvent('participant_joined', 'overlay:r1', 'r1', 1700000000));
  tracker.handle(joinEv);
  const dup = tracker.handle(joinEv);
  ok('I. duplicate delivery is deduped by event id', dup.deduped === true);
  tracker.handle(JSON.parse(mkEvent('participant_left', 'overlay:r1', 'r1', 1700000600)));
  ok('I. join+left produce one authoritative 10-min session',
    tracker.sessions.length === 1 && Math.round(tracker.sessions[0].durationMs / 60000) === 10);
  ok('I. identity is classified into our participant kinds',
    tracker.sessions[0].kind === 'overlay');

  const t2 = createWebhookTracker({ log: { log() {}, warn() {}, error() {} }, statePath: null });
  t2.handle(JSON.parse(mkEvent('participant_left', 'seat:x', 'r2', 1700000600)));
  t2.handle(JSON.parse(mkEvent('participant_joined', 'seat:x', 'r2', 1700000000)));
  ok('I. OUT-OF-ORDER (left before joined) reconciles to the right duration',
    t2.sessions.length === 1 && Math.round(t2.sessions[0].durationMs / 60000) === 10);

  const since = Date.now() - 60 * 60_000; // an hour of observation
  const rec = reconcile({
    webhookStats: { minutesToday: 42, observingSince: since, observedMinutes: 60 },
    ledgerStats: { minutesToday: 12, windowStart: since },
  });
  ok('I. reconciliation flags divergence and names the LEAK direction',
    rec.diverged && rec.deltaMinutes === 30 && rec.direction === 'unreported_burn',
    `${rec.deltaMinutes}min ${rec.direction}`);

  // The ledger is persisted and the webhook tracker is not. Comparing a
  // rolling-24h persisted ledger against a since-boot counter reported a
  // divergence after EVERY deploy — a permanent false alarm, found in prod
  // (ledger 2.8min vs webhook 0.23min with nothing actually wrong).
  const unclamped = reconcile({
    webhookStats: { minutesToday: 0.23, observingSince: since, observedMinutes: 60 },
    ledgerStats: { minutesToday: 2.8, windowStart: null },
  });
  ok('I. an UNCLAMPED ledger window is refused, not reported as divergence',
    unclamped.diverged === false && unclamped.comparableWindow === false
      && /not meaningful/.test(unclamped.note || ''),
    `diverged=${unclamped.diverged} note=${unclamped.note}`);

  const fresh = reconcile({
    webhookStats: { minutesToday: 0, observingSince: Date.now() - 30_000, observedMinutes: 0.5 },
    ledgerStats: { minutesToday: 9, windowStart: Date.now() - 30_000 },
  });
  ok('I. a just-booted tracker does not cry divergence before it has data',
    fresh.diverged === false && /not yet meaningful/.test(fresh.note || ''),
    `diverged=${fresh.diverged} note=${fresh.note}`);

  const agreed = reconcile({
    webhookStats: { minutesToday: 5.1, observingSince: since, observedMinutes: 60 },
    ledgerStats: { minutesToday: 5.0, windowStart: since },
  });
  ok('I. a shared window within tolerance reports MATCH, not noise',
    agreed.diverged === false && agreed.comparableWindow === true && agreed.note === null,
    `delta=${agreed.deltaMinutes}`);
}

// ── K. METERING SURVIVES RESTART (the daily cap was deploy-resettable) ─────
{
  const { createWebhookTracker } = await import('./livekit-webhooks.js');
  const { mkdtempSync, copyFileSync } = await import('fs');
  const { tmpdir } = await import('os');
  const pathMod = await import('path');
  const dir = mkdtempSync(pathMod.join(tmpdir(), 'mc-whstate-'));
  const statePath = pathMod.join(dir, 'state.json');
  const quiet = { log() {}, warn() {}, error() {} };

  const ev = (type, identity, room, tsSec, id) => JSON.stringify({
    event: type, id, createdAt: tsSec,
    room: { name: room, sid: `RM_${room}` },
    participant: { identity, sid: `PA_${identity}` },
  });

  // Boot 1: one closed 10-minute session, one still open.
  const t1 = createWebhookTracker({ log: quiet, statePath });
  t1.handle(JSON.parse(ev('participant_joined', 'seat:a', 'r1', 1700000000, 'e1')));
  t1.handle(JSON.parse(ev('participant_left', 'seat:a', 'r1', 1700000600, 'e2')));
  t1.handle(JSON.parse(ev('participant_joined', 'seat:b', 'r1', Math.floor(Date.now() / 1000) - 300, 'e3')));
  const before = t1.stats();
  ok('K. boot 1 meters a closed session and holds an open one',
    before.closedCount === 1 && before.openCount === 1, `${before.closedCount}/${before.openCount}`);

  // Boot 2: same state file. THE cap-evasion bug: this used to come back zero.
  const t2 = createWebhookTracker({ log: quiet, statePath });
  const after = t2.stats();
  ok('K. RESTART PRESERVES the closed session (daily cap was deploy-resettable)',
    after.closedCount === 1, `closedCount=${after.closedCount}`);
  ok('K. restart preserves the metered minutes, not just the count',
    Math.abs(after.minutesToday - before.minutesToday) < 0.2,
    `${before.minutesToday} -> ${after.minutesToday}`);
  ok('K. the observation window is CONTINUOUS across boots (not reset to now)',
    after.observingSince === before.observingSince,
    `${after.observingSince} vs ${before.observingSince}`);
  ok('K. the still-open session is resumed, not lost',
    after.openCount === 1 && after.openSessions[0].identity === 'seat:b');

  // Each policy below must start from the SAME post-boot-1 state. Reconciling
  // persists its own outcome (correctly), so without this snapshot the second
  // policy case would find nothing left to reconcile.
  const pristine = `${statePath}.pristine`;
  copyFileSync(statePath, pristine);
  const rewind = () => copyFileSync(pristine, statePath);

  // Policy 1 — no RoomService probe: keep open, conservatively over-count.
  rewind();
  const t3 = createWebhookTracker({ log: quiet, statePath });
  const r3 = await t3.reconcileOnBoot();
  ok('K. with NO probe the policy is keep-open (over-count beats under-count)',
    r3.policy === 'keep-open-conservative' && t3.stats().openCount === 1, r3.policy);
  ok('K. and it says plainly that it may over-count', /OVER-count/i.test(r3.note || ''));

  // Policy 2 — probe says they LEFT during downtime: close at last-known-alive.
  rewind();
  const t4 = createWebhookTracker({
    log: quiet, statePath, liveParticipants: async () => new Set(),
  });
  const r4 = await t4.reconcileOnBoot();
  ok('K. with a probe, a participant gone during downtime is CLOSED',
    r4.policy === 'roomservice-authoritative' && r4.closed === 1 && t4.stats().openCount === 0,
    JSON.stringify(r4));
  const closedRec = t4.sessions.find((s) => s.closedBy === 'boot-reconcile');
  ok('K. it is closed at LAST-KNOWN-ALIVE, never inventing downtime minutes',
    !!closedRec && closedRec.end <= Date.now() && closedRec.end >= closedRec.start,
    `dur=${((closedRec?.durationMs || 0) / 60000).toFixed(2)}min`);

  // Policy 3 — probe says they are STILL THERE: confirm and keep metering.
  rewind();
  const t5 = createWebhookTracker({
    log: quiet, statePath, liveParticipants: async () => new Set(['r1|seat:b']),
  });
  const r5 = await t5.reconcileOnBoot();
  ok('K. a participant still connected is CONFIRMED and keeps accruing',
    r5.confirmed === 1 && r5.closed === 0 && t5.stats().openCount === 1, JSON.stringify(r5));

  // Policy 4 — probe THROWS: must not guess sessions closed.
  rewind();
  const t6 = createWebhookTracker({
    log: quiet, statePath,
    liveParticipants: async () => { throw new Error('roomservice down'); },
  });
  const r6 = await t6.reconcileOnBoot();
  ok('K. a FAILED probe leaves sessions open rather than guessing them closed',
    r6.policy === 'keep-open-conservative' && t6.stats().openCount === 1, r6.note);

  // Opting out of persistence must still work (tests, ephemeral runs).
  const t7 = createWebhookTracker({ log: quiet, statePath: null });
  ok('K. statePath:null opts out cleanly with no state carried over',
    t7.stats().closedCount === 0 && t7.stats().persisted === false);
}

// ── J. BURN BREAKER — warn, block, override, long-session alarm ─────────────
{
  const { createBreaker } = await import('./livekit-breaker.js');
  const logs = [];
  const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  let usage = { minutesToday: 0, minutesThisMonth: 0, openSessions: [] };
  const cfg = {
    enabled: true, dailyBudgetMin: 100, monthlyBudgetMin: 1000,
    warnAt: 0.75, blockAt: 0.95, longSessionMin: 60, overrideTtlMs: 60_000,
  };
  const b = createBreaker({ log, getUsage: () => usage, config: cfg });

  ok('J. under budget: connections allowed', b.checkAllowed().allowed === true);
  usage.minutesToday = 80; b.evaluate();
  ok('J. at 80% budget: WARNS but still allows', b.state() === 'warn' && b.checkAllowed().allowed);
  usage.minutesToday = 96; b.evaluate();
  const blocked = b.checkAllowed();
  ok('J. at 96% budget: BLOCKS new connections', blocked.allowed === false && b.state() === 'blocked');
  ok('J. block reason is operator-facing, not a code',
    /budget reached/i.test(blocked.reason) && /Live sessions are unaffected/i.test(blocked.reason));

  let refused = false;
  try { b.setOverride({ by: '', reason: '' }); } catch { refused = true; }
  ok('J. an override without operator + reason is refused', refused);
  b.setOverride({ by: 'gate', reason: 'verification run' });
  ok('J. override permits connections again', b.checkAllowed().allowed === true);
  ok('J. override is logged with who and why',
    logs.some((l) => /OVERRIDE ENGAGED by "gate"/.test(l) && /verification run/.test(l)));
  b.clearOverride('gate');
  ok('J. clearing the override restores the block', b.checkAllowed().allowed === false);

  usage.openSessions = [{
    room: 'mc-513c020a', identity: 'viewer:abc', kind: 'viewer',
    startedAt: Date.now() - 1800 * 60_000, minutes: 1800,
  }];
  const ev = b.evaluate();
  ok('J. LONG-SESSION alarm fires on a 30-hour session (the original leak)',
    ev.alarms.length === 1 && ev.alarms[0].type === 'LONG_SESSION' && ev.alarms[0].minutes === 1800);
  ok('J. alarm names room, identity and start time',
    ev.alarms[0].room === 'mc-513c020a' && ev.alarms[0].identity === 'viewer:abc' && !!ev.alarms[0].startedAt);
  ok('J. the same session does not re-alarm every tick', b.evaluate().alarms.length === 0);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 60000 });

// ── D + E: reveal gating (pure client logic, no server needed) ──────────────
{
  const page = await browser.newPage();
  await page.setContent('<div id="stage"></div>');
  const res = await page.evaluate(() => {
    // Mirror of the overlay's reveal gate — same conditions, same order.
    const lkReveal = new Map();
    const rec = (id) => {
      if (!lkReveal.has(id)) lkReveal.set(id, { stingerDone: false, trackReady: false, revealed: false, el: null });
      return lkReveal.get(id);
    };
    const events = [];
    const maybeReveal = (id) => {
      const r = lkReveal.get(id);
      if (!r || r.revealed || !r.el) return;
      if (!(r.stingerDone && r.trackReady)) return;
      r.revealed = true;
      events.push('reveal:' + id);
    };
    const attach = (id) => {
      const r = rec(id);
      r.el = r.el || {};
      if (r.revealed) { events.push('refade:' + id); return; }
      r.trackReady = true;
      maybeReveal(id);
    };
    const stinger = (id) => { const r = rec(id); r.el = r.el || {}; r.stingerDone = true; maybeReveal(id); };

    // D: stinger finishes FIRST, track lands late.
    stinger('seat:a');
    const heldAfterStinger = !lkReveal.get('seat:a').revealed;
    attach('seat:a');
    const revealedAfterTrack = lkReveal.get('seat:a').revealed;

    // Track first, stinger late (the common case) — must also wait.
    attach('seat:b');
    const heldAfterTrack = !lkReveal.get('seat:b').revealed;
    stinger('seat:b');
    const revealedAfterStinger = lkReveal.get('seat:b').revealed;

    // E: re-attach on an already-revealed seat = non-entry path.
    attach('seat:a');
    return {
      heldAfterStinger, revealedAfterTrack, heldAfterTrack, revealedAfterStinger,
      events, revealCount: events.filter((e) => e === 'reveal:seat:a').length,
      lastWasRefade: events[events.length - 1] === 'refade:seat:a',
    };
  });
  ok('D. stinger finishes first → tile HOLDS (no empty video frame revealed)', res.heldAfterStinger);
  ok('D. reveal fires when the late track finally lands', res.revealedAfterTrack);
  ok('D. track first → still holds until the stinger reveal frame', res.heldAfterTrack);
  ok('D. reveal fires at the stinger reveal frame (later of the two wins)', res.revealedAfterStinger);
  ok('E. re-attach on a revealed seat takes the fallback fade, NOT a reveal', res.lastWasRefade);
  ok('E. entry reveal never fires twice (no stinger replay on reconnect)', res.revealCount === 1);
  await page.close();
}

// ── A + B + C + F: live server, real SFU ───────────────────────────────────
const PORT = 3230;
const APP = `http://localhost:${PORT}`;
const app = launch(PORT);
await sleep(9000);

const mkRoom = async (name) => {
  const r = await fetch(`${APP}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: 'lazy-gate', config: { transport: 'livekit', passkeyTickPrice: '0' } }),
  });
  return (await r.json()).room;
};
const stats = () => fetch(`${APP}/api/livekit/sessions`).then((r) => r.json());
const lkState = (page) => page.evaluate(() => window.__lkProbe && window.__lkProbe());

try {
  const room = await mkRoom('Lazy Gate');

  // Expose overlay internals for assertions without changing behavior.
  const openOverlay = async () => {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__lkProbe = () => ({
        connected: !!window.lkOverlayRoomProbe?.(),
        state: document.getElementById('lk-status')?.dataset.state || null,
      });
    });
    await page.goto(`${APP}/overlay?room=${room.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
    return page;
  };

  const overlay = await openOverlay();
  await sleep(3000);

  // ── A. idle costs nothing ────────────────────────────────────────────────
  // Measured as a DELTA: minutes must not grow at all while the overlay sits
  // open with no guests. (This is the whole bug — the old overlay would have
  // been accruing continuously for this entire window.)
  const baseline = (await stats()).minutesToday;
  const idleChecks = [];
  for (let i = 0; i < 6; i++) {
    await sleep(2500);
    const s = await stats();
    const pin = await overlay.evaluate(() => document.getElementById('lk-status')?.dataset.state);
    idleChecks.push({ open: s.open.length, mins: s.minutesToday, pin });
  }
  const everConnected = idleChecks.some((c) => c.open > 0);
  const grew = idleChecks.at(-1).mins - baseline;
  ok('A. overlay idle ~15s: NEVER opens a LiveKit session (ledger)', !everConnected,
    JSON.stringify(idleChecks.map((c) => c.open)));
  ok('A. overlay idle: ZERO connected minutes accrue over the window', grew === 0,
    `baseline=${baseline} → ${idleChecks.at(-1).mins} (delta ${grew})`);
  ok('A. status pin reads idle while nothing is happening',
    idleChecks.at(-1).pin === 'idle', `pin=${idleChecks.at(-1).pin}`);

  // ── B. pay flow: prewarm → seat → vacate → grace ─────────────────────────
  // NOTE: cancel requires the token the prewarm handed back — a hold you
  // cannot name cannot be released (an abandoned tab falls back to the TTL).
  const prewarm = (r = room.id) =>
    fetch(`${APP}/api/livekit/prewarm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: r }),
    }).then((x) => x.json()).then((d) => d.prewarm);
  const cancel = (tok, r = room.id) =>
    fetch(`${APP}/api/livekit/prewarm/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: r, prewarm: tok }),
    });

  const tok1 = await prewarm();
  await sleep(3500);
  let s = await stats();
  ok('B. PREWARM (join-sheet-open) connects the overlay BEFORE any seat exists',
    s.open.length === 1 && s.open[0].kind === 'overlay', JSON.stringify(s.open));
  // Identity is PER BROWSER SOURCE, not per room. A bare `overlay:<roomId>`
  // deduped reload churn but made two overlays on the same room evict each
  // other — which is exactly how OBS ended up showing a black tile while the
  // viewer side worked. The instance suffix is stable across reloads of one
  // source (sessionStorage) and unique between sources.
  ok('B. connected under a PER-INSTANCE identity overlay:<roomId>:<instance>',
    new RegExp(`^overlay:${room.id}:[a-z0-9]+$`).test(s.open[0]?.identity || ''),
    s.open[0]?.identity);

  const health1 = await fetch(`${APP}/api/livekit/overlay/health?room=${room.id}`).then((r) => r.json());
  ok('B. health endpoint reports a live, healthy overlay for the booth dashboard',
    health1.present && health1.healthy && health1.lkState === 'live', JSON.stringify(health1));

  // vacate everything → grace must hold the connection, not drop it
  await cancel(tok1);
  await sleep(1200);
  s = await stats();
  ok('B. vacate does NOT hang up instantly — grace window holds the connection',
    s.open.length === 1, JSON.stringify(s.open));

  // ── F. second guest inside the grace window: no flap ──────────────────────
  const tok2 = await prewarm();
  await sleep(1500);
  s = await stats();
  const sameSession = s.open.length === 1;
  ok('F. back-to-back guest inside grace: same session, no disconnect/reconnect flap',
    sameSession, JSON.stringify(s.open));

  // now let it fully expire
  await cancel(tok2);
  await sleep(GRACE_MS + 5000);
  s = await stats();
  ok('B. after grace expires the overlay disconnects — minutes stop accruing',
    s.open.length === 0, JSON.stringify(s.open));
  ok('B. ledger closed the session with a real duration',
    s.minutesToday > 0, `minutesToday=${s.minutesToday}`);

  // ── C. signal recovery: kill the WS, then wake ───────────────────────────
  await overlay.evaluate(() => {
    // Simulate the app socket dying mid-idle (the new failure mode lazy
    // connect introduces — a dead signal must not strand the overlay).
    try { window.ws && window.ws.close(); } catch { /* noop */ }
  });
  await sleep(1500);
  await prewarm();
  await sleep(6000);
  s = await stats();
  ok('C. signal channel dropped mid-idle: a later wake STILL connects (fallback works)',
    s.open.length === 1, JSON.stringify(s.open));

  await overlay.close();
  await sleep(1500);
  s = await stats();
  ok('C. closing the overlay page closes its ledger record (no phantom minutes)',
    s.open.length === 0, JSON.stringify(s.open));
} finally {
  app.kill();
}

// ── G. flag off restores connect-on-mount ──────────────────────────────────
const PORT2 = 3231;
const app2 = launch(PORT2, { LAZY_CONNECT: '0' });
await sleep(9000);
try {
  const r = await fetch(`http://localhost:${PORT2}/api/dashboard/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Flag Off', password: 'lazy-gate', config: { transport: 'livekit', passkeyTickPrice: '0' } }),
  });
  const room = (await r.json()).room;
  const cfg = await fetch(`http://localhost:${PORT2}/api/config?room=${room.id}`).then((x) => x.json());
  ok('G. flag off: /api/config advertises lazyConnect.enabled = false',
    cfg.lazyConnect && cfg.lazyConnect.enabled === false, JSON.stringify(cfg.lazyConnect));

  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(`http://localhost:${PORT2}/overlay?room=${room.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(6000);
  ok('G. flag off: overlay connects on mount with NO guest (legacy behavior restored)',
    logs.some((l) => /lazy connect DISABLED|LiveKit connected \(flag-off\)/.test(l)),
    logs.filter((l) => /lazy|LiveKit/i.test(l)).slice(0, 2).join(' | '));
  await page.close();
} finally {
  app2.kill();
}

await browser.close();
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
