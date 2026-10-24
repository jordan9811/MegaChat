/**
 * GATE — rooms-store.js: the room store keeps what it is given (stores-1, 2,
 * 7, 10, 11, 13, 14, 15).
 *
 * WHAT IT PROVES, each case in a fresh process on its own scratch DATA_DIR
 *   T  A torn rooms.json survives the boot path. The old loader read it as
 *      empty and the default-room password migration saved that over every
 *      room before anyone could look. Now the store refuses writes and the
 *      bytes on disk are untouched.
 *   P  A refused layout changes nothing. updateRoom used to apply the name and
 *      `active` first, and the next unrelated write persisted them.
 *   A  applyRoomUpdate (the dashboard's save) is all or nothing: a refused
 *      layout or a taken handle leaves the password and handle as they were.
 *   S  A long stream title is cut by character, never leaving a lone surrogate.
 *   D  With ROOM_DEFAULT_PASSWORD unset, the default room does NOT unlock with
 *      'changeme'. Set, it does.
 *   O  The boot pruner (DECISIONS D1): a password-only room — what the create
 *      page offers a signed-out streamer — survives the next deploy; a room
 *      with neither owner nor password is removed; the password migration no
 *      longer gives every owner-less room a shared password first.
 *   B  Importing the module writes nothing (the boot marker used to land in
 *      whatever DATA_DIR was set at import); recordBoot() writes it, and the
 *      next boot sees it.
 *   C  roomCount() agrees with listRooms().
 *   L  LiveKit keys that arrive AFTER the import (server.js imports this
 *      module, then loadEnvFile()s .env) still make LiveKit the default
 *      transport. The transport used to be decided by a constant computed at
 *      import, so a .env-only LIVEKIT_URL left every local room on vdo
 *      (audit harness-10).
 *
 * Spends nothing, starts no server, writes only under the OS temp dir.
 *
 *   node _gate-rooms-store.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const mod = (f) => import(pathToFileURL(path.join(HERE, f)).href);
const rooms = () => mod('rooms-store.js');
const DATA = process.env.DATA_DIR;
const disk = () => JSON.parse(fs.readFileSync(path.join(DATA, 'rooms.json'), 'utf8'));
// Tiles this big reach the badge at any corner: the layout check must refuse it.
const BAD_LAYOUT = { origin: 'top-right', direction: 'down', tile: { w: 1920, h: 1080, gap: 0 } };
const tryCode = async (fn) => { try { await fn(); return null; } catch (e) { return e.code || e.name || e.message; } };

const CASES = {
  async torn() {
    const r = await rooms();
    await r.migrateLegacyRoomPasswords(); // the boot path that used to save over it
    const createErr = await tryCode(() => r.createRoom('after the tear'));
    return { createErr, listed: r.listRooms().map((x) => x.id), refusal: typeof r.roomsRefusal === 'function' ? r.roomsRefusal() : null };
  },

  async partial() {
    const r = await rooms();
    const { id } = r.createRoom('Original name');
    const refused = await tryCode(() => r.updateRoom(id, { name: 'Name from the refused request', active: false, config: { layout: BAD_LAYOUT } }));
    const served = r.getRoomRecord(id);
    r.setRoomOwner(id, 'acct_unrelated'); // the next, unrelated write
    const onDisk = disk().rooms[id];
    return { refused, servedName: served.name, servedActive: served.active, diskName: onDisk.name, diskActive: onDisk.active };
  },

  async apply() {
    const r = await rooms();
    const room = await r.createRoomWithPassword('Apply room', {}, 'pw-original');
    const other = r.createRoom('Other room');
    r.setRoomHandle(other.id, 'takenhandle');
    const out = {};
    out.layoutRefused = await tryCode(() => r.applyRoomUpdate(room.id, { password: 'pw-new-1234', handle: 'freshhandle', patch: { name: 'Refused', config: { layout: BAD_LAYOUT } } }));
    out.afterLayout = {
      oldPw: await r.verifyRoomPassword(room.id, 'pw-original'),
      newPw: await r.verifyRoomPassword(room.id, 'pw-new-1234'),
      handle: disk().rooms[room.id].handle ?? null,
      name: disk().rooms[room.id].name,
    };
    out.handleTaken = await tryCode(() => r.applyRoomUpdate(room.id, { password: 'pw-new-1234', handle: 'takenhandle', patch: { name: 'Also refused' } }));
    out.afterTaken = { oldPw: await r.verifyRoomPassword(room.id, 'pw-original'), name: disk().rooms[room.id].name };
    const saved = await r.applyRoomUpdate(room.id, { password: 'pw-new-1234', handle: 'freshhandle', patch: { name: 'Saved' } });
    out.saved = {
      handle: saved?.handle, name: disk().rooms[room.id].name,
      newPw: await r.verifyRoomPassword(room.id, 'pw-new-1234'), oldPw: await r.verifyRoomPassword(room.id, 'pw-original'),
    };
    return out;
  },

  async surrogate() {
    const r = await rooms();
    const { id } = r.createRoom('x');
    const title = 'a'.repeat(63) + '\u{1F600}' + ' and then some more words';
    r.updateRoom(id, { name: title });
    const stored = r.getRoomRecord(id).name;
    const last = stored.charCodeAt(stored.length - 1);
    return {
      titleUnits: title.length,
      storedChars: Array.from(stored).length,
      loneSurrogate: last >= 0xd800 && last <= 0xdbff,
      clampAgrees: typeof r.clampRoomName === 'function' ? r.clampRoomName(title) === stored : null,
    };
  },

  async defaultPassword() {
    const r = await rooms();
    await r.migrateLegacyRoomPasswords();
    return {
      changeme: await r.verifyRoomPassword('default', 'changeme'),
      envPassword: process.env.ROOM_DEFAULT_PASSWORD ? await r.verifyRoomPassword('default', process.env.ROOM_DEFAULT_PASSWORD) : null,
    };
  },

  async prune() {
    const r = await rooms();
    const nobody = r.createRoom('nobody can manage this');
    const pwOnly = await r.createRoomWithPassword('signed-out streamer', {}, 'gate-pass-1');
    const owned = r.createRoom('owned');
    r.setRoomOwner(owned.id, 'acct_owner');
    const demo = r.createRoom('demo');
    r.setRoomHandle(demo.id, 'demo');
    await r.migrateLegacyRoomPasswords();
    const nobodyHashed = !!r.getRoomRecord(nobody.id).passwordHash;
    const removed = r.pruneOrphanRooms({ protectHandles: ['demo'] });
    const still = (id) => !!r.getRoomRecord(id);
    return {
      ids: { nobody: nobody.id, pwOnly: pwOnly.id, owned: owned.id, demo: demo.id },
      nobodyHashed, removed,
      kept: { pwOnly: still(pwOnly.id), owned: still(owned.id), demo: still(demo.id), default: still('default') },
      pwStillUnlocks: await r.verifyRoomPassword(pwOnly.id, 'gate-pass-1'),
      onDisk: Object.keys(disk().rooms).sort(),
    };
  },

  async predicate() {
    const r = await rooms();
    const P = (rec) => r.isOrphanRoom(rec, { protectHandles: ['demo'] });
    return {
      default: P({ id: 'default' }),
      demo: P({ id: 'd1', handle: 'demo' }),
      owned: P({ id: 'o1', ownerKey: 'acct_x' }),
      password: P({ id: 'p1', passwordHash: 'scrypt:abc' }),
      neither: P({ id: 'n1' }),
      handleOnly: P({ id: 'h1', handle: 'someone' }),
    };
  },

  async bootMarker() {
    const marker = path.join(DATA, 'boot-marker.json');
    const r = await rooms();
    const out = { writtenAtImport: fs.existsSync(marker) };
    try {
      r.recordBoot();
      out.writtenByRecordBoot = fs.existsSync(marker);
      out.info = r.dataDirInfo().evidence;
    } catch (e) { out.error = e.message; }
    return out;
  },

  async count() {
    const r = await rooms();
    r.createRoom('one'); r.createRoom('two');
    return { count: typeof r.roomCount === 'function' ? r.roomCount() : null, listed: r.listRooms().length };
  },

  async livekitLazy() {
    // The order server.js has: import the store with no LiveKit names in the
    // environment, THEN load the .env that holds them.
    for (const k of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) delete process.env[k];
    const r = await rooms();
    const before = r.resolveRoomConfig(r.createRoom('before the env file').id).transport;
    process.loadEnvFile(process.env.GATE_LK_ENV_FILE);
    const after = r.resolveRoomConfig(r.createRoom('after the env file').id).transport;
    const vdo = r.resolveRoomConfig(r.createRoom('chose vdo', { transport: 'vdo' }).id).transport;
    return { before, after, vdo };
  },

  async envDefaults() {
    const r = await rooms();
    const d = r.getEnvDefaults();
    const room = r.resolveRoomConfig(r.createRoom('env room').id);
    return { maxSeats: d.maxSeats, tickSeconds: d.tickSeconds, earnInterval: d.rewards.earnInterval, roomMaxSeats: room.maxSeats, ceiling: r.maxEffectiveSeats() };
  },
};

if (process.argv[2] === '--case') {
  const out = await CASES[process.argv[3]]();
  process.stdout.write(`@@RESULT ${JSON.stringify(out)}\n`);
  process.exit(0);
}

// ── parent ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const scratch = [];
function run(name, { env = {}, dir = null, seed = null } = {}) {
  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), `mc-rooms-${name}-`));
  if (!dir) scratch.push(dataDir);
  if (seed) seed(dataDir);
  const base = { ...process.env };
  for (const k of ['ROOM_DEFAULT_PASSWORD', 'KEEP_ORPHAN_ROOMS', 'DEMO_ROOM_PASSWORD']) delete base[k];
  const r = spawnSync(process.execPath, [SELF, '--case', name], { env: { ...base, DATA_DIR: dataDir, ...env }, encoding: 'utf8', timeout: 120_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@RESULT '));
  return { dataDir, out: line ? JSON.parse(line.slice(9)) : null, err: (r.stderr || '').slice(-600) };
}

console.log('\n── rooms-store ──────────────────────────────────────────');
try {
  // T
  {
    const full = JSON.stringify({ rooms: Object.fromEntries(['default', 'r1', 'r2', 'r3', 'r4'].map((id) => [id, { id, name: `room ${id}`, active: true, config: {} }])) }, null, 2);
    let file = null, before = null;
    const { out, err } = run('torn', {
      env: { ROOM_DEFAULT_PASSWORD: 'gate-default-pw' },
      seed: (d) => { file = path.join(d, 'rooms.json'); fs.writeFileSync(file, full.slice(0, Math.floor(full.length / 2))); before = sha(file); },
    });
    ok('T1 a torn rooms.json is NOT overwritten by the boot path (password migration) or a create', !!out && sha(file) === before, out ? '' : err);
    ok('T2 ...the create is refused with store_refused, not silently accepted', out?.createErr === 'store_refused', String(out?.createErr));
    ok('T3 ...and reads still work, serving only the default room', JSON.stringify(out?.listed) === '["default"]', JSON.stringify(out?.listed));
    ok('T4 ...and roomsRefusal() says so, so a sweep keyed on "rooms that exist" can stand down',
      out?.refusal?.state === 'corrupt' && !!out.refusal.file, JSON.stringify(out?.refusal));
  }
  // P
  {
    const { out, err } = run('partial');
    ok('P1 the bad layout is refused', out?.refused === 'layout_refused', out ? String(out.refused) : err);
    ok('P2 ...and the refused name and active flag are NOT served', out?.servedName === 'Original name' && out?.servedActive === true, JSON.stringify(out && [out.servedName, out.servedActive]));
    ok('P3 ...nor persisted by the next unrelated write', out?.diskName === 'Original name' && out?.diskActive === true, JSON.stringify(out && [out.diskName, out.diskActive]));
  }
  // A
  {
    const { out, err } = run('apply');
    ok('A1 applyRoomUpdate refuses a bad layout', out?.layoutRefused === 'layout_refused', out ? String(out.layoutRefused) : err);
    ok('A2 ...with the password, handle and name all unchanged',
      out?.afterLayout?.oldPw === true && out.afterLayout.newPw === false && out.afterLayout.handle === null && out.afterLayout.name === 'Apply room', JSON.stringify(out?.afterLayout));
    ok('A3 a taken handle is refused the same way, changing nothing', out?.handleTaken === 'handle_taken' && out.afterTaken.oldPw === true && out.afterTaken.name === 'Apply room', JSON.stringify(out && [out.handleTaken, out.afterTaken]));
    ok('A4 a valid update applies all three in one write', out?.saved?.handle === 'freshhandle' && out.saved.name === 'Saved' && out.saved.newPw === true && out.saved.oldPw === false, JSON.stringify(out?.saved));
  }
  // S
  {
    const { out, err } = run('surrogate');
    ok('S1 a title with an emoji astride the 64th character is stored as 64 characters, no lone surrogate', out && out.loneSurrogate === false && out.storedChars === 64, out ? JSON.stringify(out) : err);
    ok('S2 clampRoomName is the cut the store makes (the follow loop compares through it)', out?.clampAgrees === true);
  }
  // D
  {
    const unset = run('defaultPassword');
    ok('D1 ROOM_DEFAULT_PASSWORD unset: the default room does NOT unlock with "changeme"', unset.out?.changeme === false, unset.out ? JSON.stringify(unset.out) : unset.err);
    const set = run('defaultPassword', { env: { ROOM_DEFAULT_PASSWORD: 'gate-default-pw' } });
    ok('D2 set: the default room takes it', set.out?.envPassword === true && set.out?.changeme === false, JSON.stringify(set.out));
  }
  // O
  {
    const { out, err } = run('prune', { env: { ROOM_DEFAULT_PASSWORD: 'gate-default-pw' } });
    ok('O1 the password migration no longer hands an owner-less room a shared password', out?.nobodyHashed === false, out ? '' : err);
    ok('O2 the pruner removes exactly the room nobody can manage', JSON.stringify(out?.removed) === JSON.stringify([out?.ids?.nobody]), JSON.stringify(out?.removed));
    ok('O3 a password-only room survives the boot prune (stores-1), and its password still unlocks it', out?.kept?.pwOnly === true && out.pwStillUnlocks === true);
    ok('O4 owned, demo and default rooms survive', out?.kept?.owned && out.kept.demo && out.kept.default);
    ok('O5 ...and the disk agrees', out && JSON.stringify(out.onDisk) === JSON.stringify(['default', out.ids.pwOnly, out.ids.owned, out.ids.demo].sort()));
    const p = run('predicate').out;
    ok('O6 isOrphanRoom: only "no owner and no password" is an orphan',
      p && p.neither === true && p.handleOnly === true && !p.default && !p.demo && !p.owned && !p.password, JSON.stringify(p));
  }
  // B
  {
    const first = run('bootMarker');
    ok('B1 importing rooms-store writes no boot marker', first.out?.writtenAtImport === false, first.out ? '' : first.err);
    ok('B2 recordBoot() writes it', first.out?.writtenByRecordBoot === true, first.out?.error || '');
    const second = run('bootMarker', { dir: first.dataDir });
    ok('B3 the next boot sees the previous one: persistence "proven"', second.out?.info?.status === 'proven' && second.out.info.priorBoots === 1, JSON.stringify(second.out?.info));
  }
  // C
  {
    const { out } = run('count');
    ok('C1 roomCount() counts without resolving, and agrees with listRooms()', out?.count === 3 && out.listed === 3, JSON.stringify(out));
  }
  // V
  {
    const { out, err } = run('envDefaults', { env: { MAX_SEATS: 'three', TICK_SECONDS: '', EARN_INTERVAL: '60s', MEGACHAT_MAX_SEATS: ' ' } });
    ok('V1 a malformed MAX_SEATS reads as the default 3, not NaN in every room\'s config', out?.maxSeats === 3 && out.roomMaxSeats === 3, out ? JSON.stringify(out) : err);
    ok('V2 empty or malformed numbers read as their defaults (env-num.js)', out?.tickSeconds === 10 && out.earnInterval === 60 && out.ceiling === 10, JSON.stringify(out));
  }
  // L
  {
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rooms-lkenv-'));
    scratch.push(envDir);
    const envFile = path.join(envDir, '.env');
    // Fake values on a closed port: nothing here talks to any SFU.
    fs.writeFileSync(envFile, 'LIVEKIT_URL=ws://127.0.0.1:9\nLIVEKIT_API_KEY=gate-key\nLIVEKIT_API_SECRET=gate-secret-not-a-real-one\n');
    const { out, err } = run('livekitLazy', { env: { GATE_LK_ENV_FILE: envFile } });
    ok('L1 with no LiveKit names in the environment a new room is on vdo', out?.before === 'vdo', out ? JSON.stringify(out) : err);
    ok('L2 LiveKit names loaded from a .env AFTER the import make LiveKit the default (it stayed vdo)', out?.after === 'livekit', JSON.stringify(out));
    ok('L3 ...and a room that chose vdo keeps it', out?.vdo === 'vdo');
  }
} catch (e) {
  ok(`unexpected: ${e.stack || e.message}`, false);
} finally {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
