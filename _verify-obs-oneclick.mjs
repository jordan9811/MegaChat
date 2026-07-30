/**
 * OWNER'S WALKER — the real-OBS five-minute checklist, as assertions.
 *
 * This is the half CI cannot do: real OBS, real CEF, real mixer, the owner's
 * machine. It connects to the REAL obs-websocket (127.0.0.1:4455) using the
 * SAME client module the UI ships, performs the automatable checks itself,
 * and prompts y/n for the ones that need human eyes and ears. A failure
 * prints the checklist row it corresponds to.
 *
 * Usage:
 *   node _verify-obs-oneclick.mjs                # prompts for the password
 *   OBS_WS_PASSWORD=... node _verify-obs-oneclick.mjs
 *
 * The password is read from env or prompt and used ONLY for the local
 * handshake — exactly like the browser, it never leaves this machine.
 */
import readline from 'node:readline/promises';
import { ObsClient, OBS_ERRORS } from './web/lib/obs-client.mjs';
import { addOverlayToObs, verifyOverlayInObs, OVERLAY_INPUT_NAME } from './web/lib/obs-oneclick.mjs';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};
const human = async (row, question) => {
  const a = (await rl.question(`  [row ${row}] ${question} (y/n) `)).trim().toLowerCase();
  ok(`row ${row}: ${question}`, a === 'y' || a === 'yes');
};

const OVERLAY_URL = process.env.OVERLAY_URL
  || 'https://megachat.fun/overlay?room=default';

console.log('── OBS one-click — real-OBS walker (docs/obs-oneclick-checklist.md) ──\n');
console.log('Make sure OBS is running with the WebSocket server enabled');
console.log('(Tools → WebSocket Server Settings → Enable → Show Connect Info).\n');

const password = process.env.OBS_WS_PASSWORD
  || await rl.question('OBS WebSocket password (stays on this machine): ');

// ── row 3: wrong password is a NAMED failure ───────────────────────────────
{
  const bad = new ObsClient({ password: password + '-wrong' });
  let err = null;
  try { await bad.connect({ timeoutMs: 5000 }); } catch (e) { err = e; }
  ok('row 3: a wrong password is rejected as AUTH_FAILED by real OBS',
    err?.kind === OBS_ERRORS.AUTH_FAILED, `${err?.kind} code=${err?.closeCode}`);
}

// ── rows 4-8: connect, add, verify — the automatable spine ────────────────
const client = new ObsClient({ password });
try {
  await client.connect({ timeoutMs: 6000 });
  const v = await client.request('GetVersion');
  ok('row 4: connected to real OBS', !!v.obsVersion,
    `OBS ${v.obsVersion}, obs-websocket ${v.obsWebSocketVersion}`);

  const added = await addOverlayToObs(client, { overlayUrl: OVERLAY_URL });
  ok('row 5/6: overlay source created in the program scene at canvas size',
    added.baseWidth > 0 && added.sceneItemId != null,
    `${added.sceneName} @ ${added.baseWidth}x${added.baseHeight}`);

  const verify = await verifyOverlayInObs(client, { overlayUrl: OVERLAY_URL });
  for (const c of verify.checks) ok(`row 5-7 verify: ${c.name}`, c.ok, `got ${c.got}`);

  await human(8, `Does "${OVERLAY_INPUT_NAME}" appear as its OWN channel in the OBS mixer, with a meter?`);
  await human(9, 'Trigger a join/stinger (or replay a MegaChat) — do you HEAR it, and does the meter move?');
  await human(10, 'Switch scenes away and back — did the overlay stay loaded (no reload flash)?');
  await human(11, 'Toggle "hear overlay sounds" OFF in MegaChat — did your monitoring go silent while the mixer still shows level?');

  // ── row 12: the repair path against real OBS ────────────────────────────
  console.log('\n  [row 12] In OBS, hand-shrink/move the MegaChat Overlay source now.');
  await rl.question('  Press Enter when done…');
  await addOverlayToObs(client, { overlayUrl: OVERLAY_URL });
  const repaired = await verifyOverlayInObs(client, { overlayUrl: OVERLAY_URL });
  ok('row 12: one more Add to OBS repairs a hand-mangled source', repaired.ok,
    repaired.checks.filter((c) => !c.ok).map((c) => c.name).join(',') || 'all green');

  await human(13, 'Start OBS Virtual Camera; does the booth picker list it, show the no-audio note, and look 1080p?');
} catch (e) {
  ok('rows 4-12: real-OBS session', false, `${e.kind || e.name}: ${e.message}`);
} finally {
  client.close();
}

// ── row 14 is destructive (quit OBS) — describe rather than automate ──────
console.log('\n  [row 14] Optional: quit OBS entirely, click Test connection in the UI,');
console.log('  and confirm the "Could not reach OBS" copy + manual fallback render.');

rl.close();
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
