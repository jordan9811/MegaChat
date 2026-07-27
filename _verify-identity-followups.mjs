/**
 * VERIFY — the three follow-ups from the per-instance identity fix.
 *
 * (a) Duplicate overlays now COEXIST (that was the fix) and therefore bill
 *     twice. Detect and surface it; never evict.
 * (b) The billable-prefix whitelist FAILS OPEN — an identity type we add later
 *     would be silently unmetered. Unknown prefixes must announce themselves.
 * (c) The sessionStorage fallback must stay stable across reloads. A per-load
 *     random id rebuilds the original stacking leak, because the overlay
 *     reloads itself whenever its websocket drops.
 */
import { readFileSync } from 'fs';
import { createWebhookTracker } from './livekit-webhooks.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

const loud = [];
const log = { log() {}, warn: (m) => loud.push(m), error: (m) => loud.push(m) };
const t = createWebhookTracker({ statePath: null, log });
const join = (identity, room, tsSec) => t.handle({
  event: 'participant_joined', id: `${identity}${tsSec}`, createdAt: tsSec,
  room: { name: room }, participant: { identity },
});

// ── (a) duplicate overlays ────────────────────────────────────────────────
join('overlay:r1:aaa', 'mc-r1', Math.floor(Date.now() / 1000) - 600);
let s = t.stats();
ok('a. ONE overlay on a room is not flagged', s.duplicateOverlays.length === 0);

join('overlay:r1:bbb', 'mc-r1', Math.floor(Date.now() / 1000) - 300);
s = t.stats();
const d = s.duplicateOverlays[0];
ok('a. TWO overlays on one room ARE flagged', !!d && d.count === 2, JSON.stringify(d?.identities));
ok('a. it names the avoidable spend, not just the count',
  d.wastedParticipants === 1 && d.extraMinutes > 0, `${d.wastedParticipants} extra, ${d.extraMinutes}min`);
ok('a. BOTH are still connected — detection never evicts',
  s.openSessions.filter((o) => o.identity.startsWith('overlay:r1')).length === 2);
ok('a. both are still BILLED (the cost is real, not hidden)',
  s.openSessions.filter((o) => o.identity.startsWith('overlay:r1') && o.billable).length === 2);

// A second room's single overlay must not be dragged in.
join('overlay:r2:ccc', 'mc-r2', Math.floor(Date.now() / 1000) - 100);
ok('a. an unrelated single overlay is not flagged',
  t.stats().duplicateOverlays.length === 1);

// ── (b) unknown prefixes ──────────────────────────────────────────────────
const before = loud.length;
join('robot:helper', 'mc-r1', Math.floor(Date.now() / 1000));
const shouted = loud.slice(before).join('\n');
ok('b. an unrecognised prefix is logged LOUDLY', /UNRECOGNISED IDENTITY PREFIX/.test(shouted));
ok('b. the message says it is going unmetered', /NOT being counted against the burn budget/i.test(shouted));
ok('b. and says exactly what to do about it',
  /KNOWN_PREFIXES in livekit-webhooks\.js/.test(shouted), shouted.slice(0, 80));
s = t.stats();
ok('b. it is also queryable, not just a log line',
  s.unknownPrefixes.some((u) => u.prefix === 'robot:'), JSON.stringify(s.unknownPrefixes));
ok('b. it stays excluded from billing (we cannot meter what we did not mint)',
  !s.openSessions.find((o) => o.identity === 'robot:helper')?.billable);

const after = loud.length;
join('robot:helper2', 'mc-r1', Math.floor(Date.now() / 1000) + 1);
ok('b. the SAME unknown prefix does not shout twice (counted, not spammed)',
  loud.length === after, `${loud.length - after} extra`);
ok('b. ...but the count still rises',
  t.stats().unknownPrefixes.find((u) => u.prefix === 'robot:').count === 2);

// A known LiveKit dashboard test is explained, not alarming.
const beforeDash = loud.length;
join('John Doe', 'Demo Room', Math.floor(Date.now() / 1000) + 2);
ok('b. a LiveKit dashboard test is recognised and NOT reported as a mystery',
  /dashboard test/i.test(loud.slice(beforeDash).join('\n'))
  && !/UNRECOGNISED/.test(loud.slice(beforeDash).join('\n')));

// ── (c) the sessionStorage fallback ───────────────────────────────────────
const overlay = readFileSync('public/overlay.html', 'utf8');
const fn = overlay.slice(
  overlay.indexOf('function overlayInstanceId'),
  overlay.indexOf('let lkLazy'),
);
ok('c. the fallback uses window.name (survives reload, needs no storage)',
  /window\.name/.test(fn));
ok('c. the LAST resort returns an empty suffix, not a random id',
  /return '';/.test(fn) && !/__mcOverlayInstance/.test(fn),
  /__mcOverlayInstance/.test(fn) ? 'still has the per-load random fallback' : 'ok');
ok('c. it explains why a loud failure beats a silent one',
  /silently bills a new participant on every reload/i.test(fn));

// And the server must turn an empty suffix into the room-scoped identity
// rather than something unique-per-request.
const server = readFileSync('server.js', 'utf8');
// Anchor on the identity construction itself. `role === 'overlay'` also
// appears in the websocket handler, and slicing from the first match tested
// entirely the wrong block.
const identityLine = server.split('\n').find((l) => l.includes('const identity = inst'));
ok('c. an empty instance falls back to the ROOM-scoped identity server-side',
  !!identityLine && identityLine.includes('`overlay:${roomId}`'),
  (identityLine || 'identity construction not found').trim());

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
