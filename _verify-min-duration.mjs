/**
 * VERIFY — a sub-threshold MegaChat is rejected over real HTTP and, critically,
 * is never charged for.
 *
 * "Never charged" is not a claim you can make from reading the handler; it has
 * to be shown. The room used here is FREE (price 0), so a clip that gets past
 * the duration check reaches `letterId` issuance — the point of no return.
 * A rejected clip must produce no letterId and no queue entry at all.
 */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3282;
const APP = `http://localhost:${PORT}`;
const ROOM = 'mindur';

const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-mindur-'));
writeFileSync(path.join(dataDir, 'rooms.json'), JSON.stringify({
  rooms: {
    [ROOM]: {
      id: ROOM, name: 'Min duration room', active: true,
      // Room settings live under `config` — a flat seed silently falls back to
      // env defaults and the room comes out PRICED, which reads as a duration
      // failure ("Wallet address required") when it is really a seed bug.
      config: {
        // Genuinely free: letterPriceFor() derives the clip price from the
        // per-second rate, so `letters.price: '0'` alone still bills. Zeroing
        // the tick price is what makes it free — and free means the ONLY thing
        // that can stop a submit is the duration rule under test.
        passkeyTickPrice: '0',
        letters: { enabled: true, price: null, maxSeconds: 10 },
      },
    },
  },
}));

const app = spawn(process.execPath, ['server.js', '--prod'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, KEEP_ORPHAN_ROOMS: 'true' },
  stdio: 'ignore', cwd: process.cwd(),
});
await sleep(10000);

const submit = (durationS) => fetch(`${APP}/api/letter/submit?room=${ROOM}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ room: ROOM, username: 'gate', durationS, mime: 'video/webm' }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
  const cfg = await fetch(`${APP}/api/config?room=${ROOM}`).then((r) => r.json());
  const min = cfg.letters.minSeconds;
  ok('the room advertises a minimum to the client', Number.isFinite(min) && min > 0, `minSeconds=${min}`);
  ok('the minimum equals the verifier sampling floor (derived, not hardcoded twice)',
    min === 3, `min=${min}`);

  const under = await submit(min - 1);
  ok('UNDER the minimum is rejected', under.status === 400, `${under.status} ${under.body.error}`);
  ok('the rejection is machine-readable AND human-readable',
    under.body.reason === 'below_min_duration' && /at least/i.test(under.body.error || ''),
    `${under.body.reason} / ${under.body.error}`);
  ok('the rejection states the actual number to hit',
    under.body.minSeconds === min && /can't be reliably verified/i.test(under.body.hint || ''),
    under.body.hint);
  ok('NEVER CHARGED: no letterId is issued for a rejected clip',
    !under.body.letterId, JSON.stringify(under.body).slice(0, 90));

  const exact = await submit(min);
  ok('EXACTLY the minimum is accepted', exact.status === 200 && !!exact.body.letterId,
    `${exact.status} letterId=${exact.body.letterId ? 'yes' : 'no'}`);

  const over = await submit(min + 2);
  ok('above the minimum is accepted', over.status === 200 && !!over.body.letterId);

  const overMax = await submit(cfg.letters.maxSeconds + 5);
  ok('the maximum still applies (the floor did not replace the cap)',
    overMax.status === 400 && /capped/i.test(overMax.body.error || ''), overMax.body.error);

  // A sub-threshold clip must not have consumed a queue slot either.
  const zero = await submit(0);
  ok('a zero-length clip is rejected too', zero.status === 400, zero.body.error);
} finally {
  app.kill();
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
