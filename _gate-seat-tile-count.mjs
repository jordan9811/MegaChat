/**
 * GATE — ONE TILE COUNT (ov-seat-dropped, 2026-11-09). Money-adjacent.
 *
 * The defect: a Holler on screen took the last tile, the server still admitted
 * a Call in (admission counted paying seats only), the overlay had no tile to
 * draw the guest in, and the guest was billed by the second for a broadcast
 * that never showed them. The other half: a seat still waiting to go live did
 * not hold its tile, so a Holler aired into it.
 *
 * The fix, asserted here against the REAL server over HTTP and the socket:
 *   A. a Call in pressed while the last tile is a Holler is refused (409,
 *      hint says nothing was charged), and /api/seats says 0 available
 *   B. a seat waiting to go live holds its tile: a queued Holler does not air
 *   C. control: with a tile actually free, the waiting seat and the Holler
 *      both get one (the fix does not over-block)
 *   D. on a PAID room the refusal comes at the door, before the session terms
 *      read the wallet's balance (the old code went to the chain first)
 *
 * DISCRIMINATES: the same steps run against a copy of the tree with the old
 * counts put back (the mutations below). Every A/B/D assertion must
 * come out the other way there, or the test proves nothing.
 *
 * Zero spend: free rooms and free Hollers; D's paid room is refused before any
 * payment step on the new code; on the old code its balance read goes to a
 * dead local RPC port. Nothing leaves the machine.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync,
  symlinkSync, lstatSync, rmdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startGateServer } from './_gate-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT_NEW = 3471;
const PORT_OLD = 3472;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The MPP meter (and so the Holler submit route) needs a seller signer. The
// dummy key other gates use (_gate-guest-whitelist.mjs): it holds nothing, and
// the RPC points at a dead local port, so not even a read leaves the machine.
const ENV = {
  KEEP_ORPHAN_ROOMS: 'true',
  SELLER_PRIVATE_KEY: '0x' + '11'.repeat(32),
  TEMPO_RPC_URL: 'http://127.0.0.1:9',
  LAZY_CONNECT: '0',
  BOUNTY_CLAIM: '0',
};

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

// ── the OLD behaviour, as a mutated copy ──────────────────────────────────
// Same construction as _gate-auth-secret.mjs: tracked source plus untracked
// root scripts, the heavy dirs as junctions, and each junction removed on its
// own before the copy is deleted.
const JUNCTIONS = ['node_modules', 'web/node_modules', 'web/.next'];
function removeCopy(dir) {
  for (const j of JUNCTIONS) {
    const p = path.join(dir, j);
    try { if (lstatSync(p).isSymbolicLink()) rmdirSync(p); } catch { /* absent */ }
  }
  if (JUNCTIONS.some((j) => { try { lstatSync(path.join(dir, j)); return true; } catch { return false; } })) {
    console.log(`\n  (old copy LEFT at ${dir}: a junction could not be removed — remove the junctions before the folder)`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}
function oldCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mc-tiles-old-'));
  const media = /\.(png|jpe?g|gif|webp|mp4|webm|mov|wav|mp3|ogg|ttf|woff2?|psd|zip|pdf)$/i;
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: HERE }).toString().split('\0');
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: HERE }).toString().split('\0')
    .filter((f) => /\.(m?js|cjs)$/.test(f) && !f.includes('/'));
  for (const f of [...tracked, ...untracked]) {
    if (!f || f.startsWith('design-assets/') || f.startsWith('docs/') || media.test(f)) continue;
    const src = path.join(HERE, f);
    if (!existsSync(src)) continue;
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    copyFileSync(src, path.join(dir, f));
  }
  for (const j of JUNCTIONS) symlinkSync(path.join(HERE, j), path.join(dir, j), 'junction');
  const swap = (file, from, to) => {
    const p = path.join(dir, file), src = readFileSync(p, 'utf8');
    if (!src.includes(from)) throw new Error(`mutation pattern not found in ${file}: ${from.slice(0, 60)}`);
    writeFileSync(p, src.replace(from, to));
  };
  // 1. admission counted paying seats only
  swap('server.js', 'if (!meta.pinned && paidTilesHeld(streamRoomId) >= roomCfg.maxSeats) {',
    'if (!meta.pinned && payingSeatCount(streamRoomId) >= roomCfg.maxSeats) {');
  // 1b. /api/seats `available` counted paying seats only
  swap('server.js', 'available: Math.max(0, configured - paidTilesHeld(roomId)),',
    'available: Math.max(0, configured - payingSeatCount(roomId)),');
  // 2. no refusal at the door of the paid routes
  swap('server.js', 'function callInTileRefusal(roomId, cfg) {', 'function callInTileRefusal(roomId, cfg) { return null;');
  // 3. the Holler scheduler counted LIVE seats against the configured cap
  swap('letters.js', 'const hollerTileFree = (roomId, cfg) => seatTileCount(roomId) < tileCap(roomId, cfg);',
    'const hollerTileFree = (roomId, cfg) => [...activeSeats.values()].filter((s) => s.streamRoomId === roomId && s.live).length < cfg.maxSeats;');
  return dir;
}

// ── one run of the scenario against a server ──────────────────────────────
async function scenario(base) {
  const out = {};
  const wsUrl = base.replace(/^http/, 'ws');
  const json = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(json);
  const mkRoom = async (name, maxSeats, extra = {}) => {
    const r = await post('/api/dashboard/create', {
      name, password: 'tile-gate',
      config: {
        passkeyTickPrice: '0', maxSeats, transport: 'vdo',
        joinStream: { enabled: true },
        letters: { enabled: true, maxSeconds: 6, price: '0', moderation: 'auto' },
        ...extra,
      },
    });
    if (r.status !== 201) throw new Error(`create ${name}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.room.id;
  };
  const overlay = (room) => new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const msgs = [];
    ws.on('message', (d) => { try { msgs.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'subscribe_room', room, role: 'overlay' })); setTimeout(() => resolve({ ws, msgs }), 400); });
    ws.on('error', reject);
  });
  const sendHoller = async (room, who) => {
    const s = await post('/api/letter/submit', { room, username: who, durationS: 5, mime: 'video/webm' });
    if (s.status !== 200 || !s.body.uploadUrl) throw new Error(`submit: ${s.status} ${JSON.stringify(s.body)}`);
    const u = await fetch(base + s.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: Buffer.alloc(4096, 7) }).then(json);
    if (u.status !== 200) throw new Error(`upload: ${u.status} ${JSON.stringify(u.body)}`);
    return s.body.letterId;
  };
  const waitPlay = async (msgs, letterId, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (msgs.some((m) => m.type === 'letter_play' && m.letter?.id === letterId)) return true;
      await sleep(200);
    }
    return false;
  };
  const join = (room, who) => post('/api/join/mpp', { username: who, room });

  // A. last tile is a Holler → Call in pressed
  {
    const room = await mkRoom('Tiles A', 1);
    const ov = await overlay(room);
    const id = await sendHoller(room, 'holler-a');
    out.aPlayed = await waitPlay(ov.msgs, id, 8000);
    const seats = await fetch(`${base}/api/seats?room=${room}`).then(json);
    out.aAvailable = seats.body.available;
    const j = await join(room, 'caller-a');
    out.aJoin = { status: j.status, reason: j.body.reason, hint: j.body.hint || null, holler: j.body.hollerOnScreen ?? null };
    ov.ws.close();
  }
  // B. a seat waiting to go live → a Holler is queued
  {
    const room = await mkRoom('Tiles B', 1);
    const ov = await overlay(room);
    const j = await join(room, 'caller-b');
    out.bJoin = j.status;
    const id = await sendHoller(room, 'holler-b');
    out.bPlayed = await waitPlay(ov.msgs, id, 6000);
    ov.ws.close();
  }
  // C. control: a tile actually free
  {
    const room = await mkRoom('Tiles C', 2);
    const ov = await overlay(room);
    const j = await join(room, 'caller-c');
    out.cJoin = j.status;
    const id = await sendHoller(room, 'holler-c');
    out.cPlayed = await waitPlay(ov.msgs, id, 8000);
    ov.ws.close();
  }
  // D. a PAID room, the last tile a (free) Holler: the session-terms request
  {
    const room = await mkRoom('Tiles D', 1, { passkeyTickPrice: '0.001' });
    const ov = await overlay(room);
    const id = await sendHoller(room, 'holler-d');
    out.dPlayed = await waitPlay(ov.msgs, id, 8000);
    const t0 = Date.now();
    const j = await post('/api/join/passkey', { username: 'caller-d', address: '0x000000000000000000000000000000000000dEaD', room });
    out.dTerms = { status: j.status, reason: j.body.reason || null, ms: Date.now() - t0 };
    ov.ws.close();
  }
  return out;
}

let oldDir = null;
let srvNew = null, srvOld = null;
try {
  console.log('\n— NEW (working tree) —');
  srvNew = await startGateServer({ port: PORT_NEW, label: 'tiles-new', env: ENV });
  const n = await scenario(`http://localhost:${PORT_NEW}`);
  console.log('  ', JSON.stringify(n));
  ok('A. the Holler took the last tile (letter_play reached the overlay)', n.aPlayed);
  ok('A. /api/seats counts the Holler: 0 available', n.aAvailable === 0, `available ${n.aAvailable}`);
  ok('A. a Call in pressed then is refused (409 no_seats_available, Holler named)', n.aJoin.status === 409 && n.aJoin.reason === 'no_seats_available' && n.aJoin.holler === true, JSON.stringify(n.aJoin));
  ok('A. ...and the refusal says nothing was charged', /Nothing was charged/.test(n.aJoin.hint || ''), n.aJoin.hint);
  ok('B. a seat waiting to go live is admitted', n.bJoin === 200);
  ok('B. ...and holds its tile: the queued Holler does NOT air into it', n.bPlayed === false);
  ok('C. control: with a tile free, the waiting seat is admitted', n.cJoin === 200);
  ok('C. control: ...and the Holler airs in the other tile', n.cPlayed === true);
  ok('D. paid room: the Holler took the last tile', n.dPlayed);
  ok('D. paid room: the session-terms request is refused at the door (409), before any balance read or allowance', n.dTerms.status === 409 && n.dTerms.reason === 'no_seats_available', JSON.stringify(n.dTerms));
  srvNew.kill(); srvNew = null;

  console.log('\n— OLD (counts put back) —');
  oldDir = oldCopy();
  srvOld = await startGateServer({ port: PORT_OLD, label: 'tiles-old', args: [path.join(oldDir, 'server.js'), '--prod'], env: ENV });
  const o = await scenario(`http://localhost:${PORT_OLD}`);
  console.log('  ', JSON.stringify(o));
  ok('DISCRIMINATES A: the old count ADMITS the Call in behind a Holler (the billed, never-drawn guest)', o.aPlayed && o.aJoin.status === 200, JSON.stringify(o.aJoin));
  ok('DISCRIMINATES A: the old /api/seats says a seat is free', o.aAvailable === 1, `available ${o.aAvailable}`);
  ok('DISCRIMINATES B: the old scheduler airs the Holler into the waiting seat\'s tile', o.bJoin === 200 && o.bPlayed === true);
  ok('DISCRIMINATES D: the old paid route goes to the wallet first (not a 409 at the door)', o.dPlayed && o.dTerms.status !== 409, JSON.stringify(o.dTerms));
  ok('control agrees on both: C airs the Holler with a tile free', o.cPlayed === true && n.cPlayed === true);
} catch (e) {
  ok(`run completed — ${e.message}`, false);
} finally {
  srvNew?.kill();
  srvOld?.kill();
  if (oldDir) { await sleep(800); removeCopy(oldDir); }
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
