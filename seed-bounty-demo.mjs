/**
 * Seed the bounty board with demo pledges.
 *
 *   node seed-bounty-demo.mjs                    # local, http://localhost:3210
 *   BASE=https://megachat.fun node seed-bounty-demo.mjs
 *   node seed-bounty-demo.mjs --clear            # remove every seeded pledge
 *
 * Needs BOUNTY_ADMIN_KEY in the env (the same value the server has).
 *
 * These are REAL rows in the escrow ledger, created through the same path a
 * fan pledge takes — that is the point, so the board behaves normally now and
 * identically once money is real. Every one carries a `seed:` contributor
 * prefix, and --clear removes them in one call. Run --clear before settlement
 * goes live: Run B replays ledger rows, and a surviving seeded row would pay
 * out money nobody put in.
 */

const BASE = (process.env.BASE || 'http://localhost:3210').replace(/\/$/, '');
const KEY = process.env.BOUNTY_ADMIN_KEY || '';

if (!KEY) {
  console.error('BOUNTY_ADMIN_KEY is not set. Export it and re-run.');
  process.exit(1);
}

/** The five names, in the order they were picked. */
const TARGETS = [
  { platform: 'twitch', handle: 'threadguy' },
  { platform: 'kick', handle: 'chessbrah' },
  { platform: 'x', handle: 'martinshkreli' },
  { platform: 'x', handle: 'rasmr' },
  { platform: 'pumpfun', handle: 'GnBQjwQibzB9zFPHEGEhoiASon7JfaRADxQe6C64pump' },
];

const GUARANTEED_EACH = '100';
const CONTESTED_POT = '100';

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bounty-admin-key': KEY },
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep the raw body for the error */ }
  if (!r.ok) throw new Error(`${path} → ${r.status} ${json?.error || text.slice(0, 200)}`);
  return json;
}

if (process.argv.includes('--clear')) {
  const out = await post('/api/bounty/admin/seed-clear');
  console.log(`cleared ${out.cleared} seeded pledge(s)`);
  process.exit(0);
}

// One pledge per streamer: money locked to that name alone.
for (const t of TARGETS) {
  const out = await post('/api/bounty/admin/seed-pledge', {
    targets: [t],
    amount: GUARANTEED_EACH,
    label: 'demo',
  });
  console.log(`locked  ${GUARANTEED_EACH.padStart(4)}  ${t.platform}:${t.handle}  (${out.pledge.id})`);
}

// One pot every name is competing for — this is what draws the hatched half
// of the bar, and what makes realValue and displayedTotal disagree honestly.
const contested = await post('/api/bounty/admin/seed-pledge', {
  targets: TARGETS,
  amount: CONTESTED_POT,
  label: 'demo-contested',
});
console.log(`contest ${CONTESTED_POT.padStart(4)}  across ${TARGETS.length} names  (${contested.pledge.id})`);

const program = await (await fetch(`${BASE}/api/bounty/program`)).json();
console.log(`\npools: ${program.pools.length}`);
console.log(`in escrow:   ${program.totals.realValue} ${program.currency}`);
console.log(`across pools: ${program.totals.displayedTotal} ${program.currency}`);
for (const p of program.pools) {
  console.log(
    `  ${(p.platform + ':' + p.handle).slice(0, 34).padEnd(36)}` +
    `locked ${String(p.guaranteed).padStart(5)}  contested ${String(p.contestedTotal).padStart(5)}` +
    `  avatar ${p.avatarUrl ? 'yes' : 'monogram'}`,
  );
}
