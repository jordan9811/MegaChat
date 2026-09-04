import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const bundled = await build({
  stdin: {
    contents: "export * from './web/lib/display-format.ts'; export * from './web/lib/bounty-examples.ts'; export * from './web/lib/room-browse.ts';",
    resolveDir: root,
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { formatDollars, guestName, withBountyExamples, exampleTotals, roomPresentation } =
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
check('Dollar formatting keeps whole dollars, cents, and sub-cent prices', () => {
  for (const [n, expected] of [[0, '$0'], [1, '$1'], [.1, '$0.10'], [.001, '$0.001'], [.000001, '$0.000001'], [1234.56, '$1,234.56']]) assert.equal(formatDollars(n), expected);
});
check('Guest names are valid, editable room handles too', () => {
  for (let i = 0; i < 100; i++) assert.match(guestName().toLowerCase(), /^[a-z0-9_]{3,20}$/);
});
const examples = withBountyExamples([]);
check('All five requested examples exist without fake ledger contributions', () => {
  assert.equal(examples.length, 5);
  for (const p of examples) { assert.equal(p.remaining, 200); assert.equal(p.guaranteed, 100); assert.equal(p.contestedTotal, 100); assert.equal(p.totalContributed, 0); assert.equal(p.contributionCount, 0); assert.equal(p.displayOnly, true); }
  assert.deepEqual(exampleTotals(examples), { unique: 600, visible: 1000, count: 5 });
});
check('One shared contested pledge, not five separate hundreds', () => {
  assert.equal(new Set(examples.flatMap((p) => p.contested.map((c) => c.pledgeId))).size, 1);
});
check('Funded and expired real pools replace examples without mutations', () => {
  const real = { ...examples[0], displayOnly: false, totalContributed: 100, remaining: 0, refunded: 100, guaranteed: 0, contestedTotal: 0, contested: [] };
  assert.equal(withBountyExamples([real]).find((p) => p.handleKey === real.handleKey), real);
  assert.equal(real.remaining, 0);
});
check('Existing claim status is preserved even on an unfunded example', () => {
  const claimed = { ...examples[0], displayOnly: false, remaining: 0, guaranteed: 0, contestedTotal: 0, claimed: true, status: 'CLAIMED' };
  assert.equal(withBountyExamples([claimed]).find((p) => p.handleKey === claimed.handleKey).claimed, true);
});
check('Example merge is idempotent and preserves pump.fun address case', () => {
  assert.deepEqual(withBountyExamples(examples), examples);
  assert.equal(examples.find((p) => p.platform === 'pumpfun').handle, 'GnBQjwQibzB9zFPHEGEhoiASon7JfaRADxQe6C64pump');
});
const room = { id: 'gate', live: 0, twitchLive: false, maxSeats: 3, passkeyTickPrice: '0.001', passkeyTickSeconds: 1, rewardsEnabled: false, letters: { enabled: true, price: '0.01', maxSeconds: 10 }, joinStream: { enabled: false } };
check('Offline recording-only rooms never advertise open live seats', () => {
  const view = roomPresentation(room);
  assert.equal(view.state, 'No live signal'); assert.equal(view.action, 'Record a MegaChat'); assert.equal(view.rate, '$0.001 /second'); assert.equal(view.capabilities, 'MegaChats');
});
check('Live seat, full queue, and demo actions follow capabilities', () => {
  const live = { ...room, live: 1, letters: { enabled: false }, joinStream: { enabled: true } };
  assert.equal(roomPresentation(live).action, 'Take a seat');
  assert.equal(roomPresentation({ ...live, live: 3 }).action, 'Join queue');
  assert.equal(roomPresentation({ ...room, isDemo: true }).action, 'Try demo');
  assert.equal(roomPresentation({ ...room, letters: undefined, joinStream: undefined }).action, 'Open room');
});

if (process.argv.includes('--server')) {
  const base = new URL(process.env.GATE_BASE_URL || 'http://localhost:3210');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'This gate refuses non-local servers');
  for (const path of ['/?stay=1', '/app', '/dashboard?new=1', '/account', '/how-it-works', '/bounty', '/bounty/s/twitch/threadguy']) {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(45000) });
    check(`Local route ${path}`, () => assert.equal(response.status, 200));
    const html = await response.text();
    if (path === '/?stay=1') check('Landing retains all three cards and removes only the rejected heading', () => {
      assert.equal((html.match(/class="mcl-entry-card(?:\s|")/g) || []).length, 3);
      assert.ok(!html.includes('Choose how you'));
      assert.ok(html.includes('COMPATIBLE WITH') || html.includes('Compatible with'));
    });
  }
  const program = await fetch(new URL('/api/bounty/program', base)).then((r) => r.json());
  check('Example amounts never reach the real program endpoint', () => assert.ok(program.pools.every((p) => !p.displayOnly)));
}
console.log(`${passed} checks passed. No funding, claims, or production requests were made.`);
