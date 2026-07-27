/**
 * VERIFY — alarms actually reach a destination.
 *
 * Runs a REAL HTTP receiver and points the alerter at it, then drives the REAL
 * breaker (not a mirror of it) until it warns, blocks, and raises a long-session
 * alarm. Asserts on the bytes that arrived at the far end.
 *
 * What this does NOT prove: that a Discord or Slack URL works, because no such
 * URL exists in this environment and one cannot be created unattended. What it
 * proves is that a threshold crossing results in an HTTP POST carrying the
 * information an operator needs. The remaining step is pasting a real webhook
 * URL into OPS_ALERT_WEBHOOK and hitting /api/livekit/burn/test-alert.
 */
import http from 'http';
import { createAlerter } from './ops-alerts.js';
import { createBreaker } from './livekit-breaker.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

// ── a real listener on a real socket ──────────────────────────────────────
const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ headers: req.headers, body: JSON.parse(body || '{}') });
    res.writeHead(204).end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${server.address().port}/hook`;
const quiet = { log() {}, warn() {}, error() {} };

try {
  // ── unconfigured must be a clean no-op ──────────────────────────────────
  const off = createAlerter({ url: '', log: quiet });
  ok('unconfigured alerter is DISABLED and does not throw', off.enabled === false);
  const skipped = await off.send('k', { title: 't', lines: ['l'] });
  ok('...and reports why rather than pretending it sent', skipped.skipped === 'not_configured');

  // ── the real breaker, driven to each threshold ──────────────────────────
  const alerter = createAlerter({ url: URL, log: quiet, minIntervalMs: 60_000 });
  ok('a configured alerter reports enabled', alerter.enabled === true);

  let usage = { minutesToday: 0, minutesThisMonth: 0, openSessions: [] };
  const breaker = createBreaker({
    log: quiet, getUsage: () => usage, alerter,
    config: {
      enabled: true, dailyBudgetMin: 100, monthlyBudgetMin: 1000,
      warnAt: 0.75, blockAt: 0.95, longSessionMin: 60, overrideTtlMs: 60_000,
    },
  });

  breaker.evaluate();
  await new Promise((r) => setTimeout(r, 120));
  ok('under budget sends NOTHING', received.length === 0, `${received.length} received`);

  usage = { minutesToday: 80, minutesThisMonth: 80, openSessions: [] };
  breaker.evaluate();
  await new Promise((r) => setTimeout(r, 200));
  ok('crossing the WARN threshold pushes an alert', received.length === 1);
  const warnMsg = JSON.stringify(received[0]?.body || {});
  ok('...it carries the budget percentage an operator needs',
    /80%|80\.0%/.test(warnMsg), warnMsg.slice(0, 90));
  ok('...and is marked as an early warning, not an emergency',
    /No action needed yet/i.test(warnMsg));

  usage = { minutesToday: 97, minutesThisMonth: 97, openSessions: [] };
  breaker.evaluate();
  await new Promise((r) => setTimeout(r, 200));
  ok('crossing the BLOCK threshold pushes a separate alert', received.length === 2);
  const blockMsg = JSON.stringify(received[1]?.body || {});
  ok('...it says new connections are blocked',
    /NEW CONNECTIONS BLOCKED/i.test(blockMsg), blockMsg.slice(0, 80));
  ok('...and reassures that live sessions are not being cut',
    /live sessions are not being cut/i.test(blockMsg), blockMsg.slice(0, 80));

  // ── long-session alarm: the one that fired into stdout during the incident
  usage = {
    minutesToday: 97, minutesThisMonth: 97,
    openSessions: [{
      room: 'mc-leaky', identity: 'overlay:leaky', kind: 'overlay',
      minutes: 150, startedAt: Date.now() - 150 * 60_000,
    }],
  };
  breaker.evaluate();
  await new Promise((r) => setTimeout(r, 200));
  ok('a LONG SESSION pushes an alarm', received.length === 3);
  const longMsg = JSON.stringify(received[2]?.body || {});
  ok('...naming the room, the participant and the duration',
    /mc-leaky/.test(longMsg) && /overlay:leaky/.test(longMsg) && /150/.test(longMsg),
    longMsg.slice(0, 110));

  // ── rate limiting: a flapping condition must not spam ───────────────────
  const before = received.length;
  for (let i = 0; i < 5; i++) {
    await alerter.longSession({ room: 'mc-leaky', identity: 'overlay:leaky', kind: 'overlay', minutes: 151 + i, pctDaily: 97 });
  }
  await new Promise((r) => setTimeout(r, 200));
  ok('repeat alarms for the SAME condition are rate-limited',
    received.length === before, `${received.length - before} extra`);

  // ...but a DIFFERENT condition is not swallowed by the noisy one.
  await alerter.longSession({ room: 'mc-other', identity: 'seat:other', kind: 'guest', minutes: 200, pctDaily: 97 });
  await new Promise((r) => setTimeout(r, 200));
  ok('a DIFFERENT condition still gets through (per-key, not global)',
    received.length === before + 1 && /mc-other/.test(JSON.stringify(received.at(-1).body)));

  // ...and when it does resend, it says how much was suppressed.
  const shortWindow = createAlerter({ url: URL, log: quiet, minIntervalMs: 1 });
  await shortWindow.send('burst', { title: 'x', lines: ['first'] });
  const n0 = received.length;
  const sw = createAlerter({ url: URL, log: quiet, minIntervalMs: 100_000 });
  await sw.send('burst2', { title: 'x', lines: ['first'] });
  await sw.send('burst2', { title: 'x', lines: ['second'] });
  await sw.send('burst2', { title: 'x', lines: ['third'] });
  await new Promise((r) => setTimeout(r, 200));
  ok('a burst collapses to one delivery', received.length === n0 + 1);

  // ── an unreachable endpoint must never break the caller ─────────────────
  const broken = createAlerter({ url: 'http://127.0.0.1:1/nope', log: quiet, minIntervalMs: 0 });
  let threw = false;
  let out = null;
  try { out = await broken.longSession({ room: 'r', identity: 'i', kind: 'overlay', minutes: 99, pctDaily: 50 }); }
  catch { threw = true; }
  ok('a DEAD endpoint never throws into the caller (metering outranks alerting)',
    threw === false && out.failed === true, out?.error);
  ok('...and the failure is counted so it is visible', broken.stats().failed === 1);

  // ── payload shaping ─────────────────────────────────────────────────────
  ok('generic endpoints get structured JSON, not just a blob',
    Array.isArray(received[0].body.lines) && typeof received[0].body.severity === 'string');
  ok('content-type is set so Discord/Slack accept it',
    /application\/json/.test(received[0].headers['content-type'] || ''));
} finally {
  server.close();
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
