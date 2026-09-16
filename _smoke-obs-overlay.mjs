/**
 * SMOKE TEST — can we see the MegaChat overlay inside a real OBS?
 *
 * Groundwork for the Pass C visibility check, and deliberately nothing more:
 * it asks OBS four questions once and prints the answers. There is no polling
 * loop here and nothing in verification calls it. When the visibility check is
 * built, THIS is the shape of the read it will do.
 *
 *   node _smoke-obs-overlay.mjs [--url ws://127.0.0.1:4455] [--password xxx]
 *
 * Also honours OBS_WS_URL and OBS_WS_PASSWORD so a password never has to sit
 * in shell history.
 *
 * WHY IT PRINTS RATHER THAN ASSERTS: the three interesting outcomes — OBS not
 * running, wrong password, overlay not in the scene — are all NORMAL states of
 * a streamer's machine, not test failures. Each one gets a sentence saying
 * what to do about it. A stack trace would be the wrong answer to "OBS isn't
 * open yet".
 *
 * Exit codes are for scripting, not judgement: 0 found it, 1 could not look
 * (OBS down, auth refused), 2 looked and it is not there.
 */
import { ObsClient, ObsError, OBS_ERRORS } from './web/lib/obs-client.mjs';
import { OVERLAY_INPUT_NAME } from './web/lib/obs-oneclick.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const url = arg('url', process.env.OBS_WS_URL || 'ws://127.0.0.1:4455');
const password = arg('password', process.env.OBS_WS_PASSWORD || '');
const wanted = arg('source', OVERLAY_INPUT_NAME);

const say = (...a) => console.log(...a);
const bail = (code, headline, ...detail) => {
  say(`\n  ${headline}`);
  detail.forEach((d) => say(`  ${d}`));
  say('');
  process.exit(code);
};

say(`\n── OBS overlay smoke test ─────────────────────────────────────`);
say(`  target   ${url}`);
say(`  looking for a source named ${JSON.stringify(wanted)}`);

const client = new ObsClient({ url, password });

try {
  await client.connect();
  say(`  connected, rpc v${client.rpcVersion}`);
} catch (e) {
  // The three ways connecting fails are three different problems with three
  // different remedies, and the client already distinguishes them — so say
  // which one it was rather than printing whatever bubbled up.
  if (e instanceof ObsError && e.kind === OBS_ERRORS.NOT_REACHABLE) {
    bail(1, 'OBS is not answering.',
      'Open OBS, then Tools → WebSocket Server Settings → Enable WebSocket server.',
      `Checked ${url}. If the port there is not 4455, pass --url.`);
  }
  if (e instanceof ObsError && e.kind === OBS_ERRORS.AUTH_FAILED) {
    bail(1, 'OBS refused the password.',
      'Tools → WebSocket Server Settings → Show Connect Info has the current one.',
      'Pass it with --password, or set OBS_WS_PASSWORD.');
  }
  bail(1, 'Could not complete the OBS handshake.',
    `${e instanceof ObsError ? e.kind : 'ERROR'}: ${e.message}`);
}

try {
  // The PROGRAM scene, not the preview one: what is on air is the only scene
  // whose contents say anything about whether viewers can see the overlay.
  const { currentProgramSceneName: scene } = await client.request('GetCurrentProgramScene');
  say(`  program scene: ${JSON.stringify(scene)}`);

  const { sceneItems } = await client.request('GetSceneItemList', { sceneName: scene });
  say(`  ${sceneItems.length} source(s) in it`);

  const item = sceneItems.find((i) => i.sourceName === wanted);
  if (!item) {
    const names = sceneItems.map((i) => `    · ${i.sourceName}`).join('\n');
    await client.close?.();
    bail(2, `No source named ${JSON.stringify(wanted)} in the program scene.`,
      'It may be in another scene, or renamed, or never added.',
      'The dashboard\'s "Add to OBS" button creates it with the right settings.',
      `\n  What IS in ${JSON.stringify(scene)}:\n${names}`);
  }

  const { sceneItemEnabled } = await client.request('GetSceneItemEnabled', {
    sceneName: scene, sceneItemId: item.sceneItemId,
  });
  const { sceneItemTransform: t } = await client.request('GetSceneItemTransform', {
    sceneName: scene, sceneItemId: item.sceneItemId,
  });

  say(`\n  FOUND — sceneItemId ${item.sceneItemId}`);
  say(`    enabled        ${sceneItemEnabled}`);
  say(`    position       ${Math.round(t.positionX)}, ${Math.round(t.positionY)}`);
  say(`    source size    ${Math.round(t.sourceWidth)} x ${Math.round(t.sourceHeight)}`);
  say(`    on canvas      ${Math.round(t.width)} x ${Math.round(t.height)}`);
  say(`    scale          ${t.scaleX.toFixed(3)} x ${t.scaleY.toFixed(3)}`);
  say(`    crop           l${t.cropLeft} r${t.cropRight} t${t.cropTop} b${t.cropBottom}`);

  // Two things a Pass C visibility check will have to decide, surfaced now so
  // the shape of the eventual judgement is visible rather than guessed at.
  if (!sceneItemEnabled) {
    say(`\n  NOTE: the source is in the scene but its eye is OFF — viewers see nothing.`);
  }
  if (t.scaleX < 0.999 || t.scaleY < 0.999) {
    say(`\n  NOTE: scaled DOWN to ${(t.scaleX * 100).toFixed(1)}% — the bounty badge`);
    say(`  shrinks with it, and below the verifier's pixel floor a clip that`);
    say(`  genuinely aired reads as unverifiable.`);
  }
  say('');
  await client.close?.();
  process.exit(0);
} catch (e) {
  await client.close?.();
  bail(1, 'OBS answered the handshake but not the questions.',
    `${e instanceof ObsError ? e.kind : 'ERROR'}: ${e.message}`,
    'This usually means an obs-websocket older than v5.');
}
