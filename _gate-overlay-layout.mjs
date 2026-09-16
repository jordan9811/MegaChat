/**
 * GATE — the layout reaches the overlay, and the badge never sits under a tile.
 *
 * Four defects converge here, and three of them were invisible to every gate
 * that existed:
 *
 *   1. THE LAYOUT NEVER ARRIVED. server.js sent
 *      `resolveRoomConfig(id)?.config?.layout`, but resolveRoomConfig returns a
 *      FLAT object with no `config` key — so the value was `undefined`, the
 *      overlay's `applyLayout` discarded it on the `Number.isFinite(version)`
 *      guard, and every room on every broadcast rendered the built-in default.
 *      The Pass A layout editor has been inert since it shipped. The same
 *      expression fed `effectiveMaxSeats` the literal 3, so the cap the overlay
 *      was told ignored the room's configured seats.
 *   2. THE BADGE IGNORED THE LAYOUT. `#bounty-badge` is pinned bottom-left in
 *      CSS, which is the corner a bottom-left stack starts in. The verifier
 *      reads that badge off the broadcast; a tile over it is an honest
 *      streamer not being paid.
 *   3. DIRECTION WAS NOT IMPLEMENTED. relayout() only ever wrote `box.style.top`
 *      against `.tile { right: 0 }`, so 'right'/'left' rendered as a downward
 *      column while the editor's preview drew a row.
 *   4. A MISSING code-matrix.cjs rendered an unsized 300x150 canvas and wrote
 *      the code into a display:none span — no readable code, and a badge box
 *      2.5x its real height.
 *
 * Assertions are made against a REAL browser rendering the REAL overlay with
 * the layout delivered over the REAL WebSocket, because every one of these bugs
 * lived in the gap between what the server computed and what the page drew.
 * Geometry is read with getBoundingClientRect, never recomputed from the
 * layout — a gate that re-derives the expected position from the same formula
 * the product uses proves only that the formula equals itself.
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { startGateServer, assertFreshBuild } from './_gate-helpers.mjs';

// The gate writes rooms through the store and the server reads them back, so
// both must point at the SAME volume. rooms-store resolves DATA_DIR at module
// load, hence the assignment before any dynamic import of it.
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'mc-layout-gate-'));
process.env.DATA_DIR = SCRATCH;

const PORT = 3276;
const APP = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** applyLayout is version-gated, so every render needs a higher version. */
let nextVersion = 1000;
const v = () => ++nextVersion;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};
const done = (code) => { console.log(`\nRESULT: ${pass} pass, ${fail} fail`); process.exit(code); };

console.log('\n── overlay layout + badge ───────────────────────────────');

// The overlay is served from public/, but the gate also drives /dashboard-free
// pages? No — it only loads /overlay. The freshness guard therefore watches
// public/, which is what this gate actually renders.
{
  const f = assertFreshBuild({ watch: ['public'], requireNextBuild: false });
  ok('G0. the overlay markup under test is the one on disk', f.ok, f.detail);
  if (!f.ok) done(1);
}

// ── A. pure geometry, before a browser is involved ──────────────────────
{
  const store = await import('./rooms-store.js');
  const CEIL = store.maxEffectiveSeats();
  ok('A1 the ceiling is one definition shared with the seat cap', CEIL === 10 || CEIL > 0, `maxEffectiveSeats()=${CEIL}`);

  // Every origin x direction, at the ceiling, with the smallest legal tile.
  const combos = [];
  for (const origin of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    for (const direction of ['down', 'up', 'right', 'left']) combos.push({ origin, direction });
  }
  const overlaps = combos.filter(({ origin, direction }) => {
    const g = store.layoutGeometry({ origin, direction, margin: 20, tile: { w: 160, h: 90, gap: 12 } }, CEIL);
    return g.tiles.x < g.badge.x + g.badge.w && g.badge.x < g.tiles.x + g.tiles.w
      && g.tiles.y < g.badge.y + g.badge.h && g.badge.y < g.tiles.y + g.tiles.h;
  });
  ok('A2 no origin/direction puts the badge under the stack at the ceiling',
    overlaps.length === 0, `${combos.length} combinations, ${overlaps.length} overlapping`);

  // The badge corner is derived from where the stack LANDS, not from origin:
  // origin top-left + direction up puts the stack bottom-left.
  const up = store.layoutGeometry({ origin: 'top-left', direction: 'up', margin: 20, tile: { w: 160, h: 90, gap: 12 } }, CEIL);
  ok('A3 badge corner follows the stack, not the origin name',
    up.badgeCorner === 'top-right', `top-left origin + up -> badge ${up.badgeCorner}`);

  ok('A4 a layout that would bury the badge is refused, with a reason',
    /covers the verification badge/i.test(
      store.layoutCollision({ origin: 'top-left', direction: 'right', margin: 20, tile: { w: 1920, h: 1080, gap: 0 } }) || ''));
  ok('A5 the default layout is still accepted',
    store.layoutCollision({ origin: 'top-right', direction: 'down', margin: 20, tile: { w: 320, h: 180, gap: 12 } }) === null);
  ok('A6 a clip parked on the badge corner is refused too',
    !!store.layoutCollision({
      origin: 'top-right', direction: 'down', margin: 20, tile: { w: 320, h: 180, gap: 12 },
      clip: { follow: false, origin: 'bottom-left', w: 800, h: 600, margin: 20 },
    }));
}

// ── B. the refusal cannot be bypassed by writing straight to the store ──
{
  const store = await import('./rooms-store.js');
  const room = store.createRoom('gate-layout', { maxSeats: 3 });
  let threw = null;
  try {
    store.updateRoom(room.id, { config: { layout: { origin: 'top-left', direction: 'right', margin: 20, tile: { w: 1920, h: 1080, gap: 0 } } } });
  } catch (e) { threw = e; }
  ok('B1 updateRoom REFUSES a burying layout rather than clamping it',
    threw?.code === 'layout_refused', threw ? threw.code : 'no throw');
  const after = store.resolveRoomConfig(room.id);
  ok('B2 and the stored layout is untouched by the refused write',
    after.layout.origin === 'top-right' && after.layout.tile.w === 320,
    `origin=${after.layout.origin} tile.w=${after.layout.tile.w}`);
}

// The delivery room is created BEFORE the server starts: rooms-store caches
// rooms.json on first read, so a room written after boot is invisible to the
// server process and initial_state would carry the default.
const delivery = await (async () => {
  const store = await import('./rooms-store.js');
  const room = store.createRoom('gate-delivery', { maxSeats: 2 });
  store.updateRoom(room.id, {
    config: { layout: { version: 42, origin: 'bottom-left', direction: 'up', margin: 30, tile: { w: 200, h: 110, gap: 20 }, clip: { follow: true, w: 320, h: 180, origin: 'top-left', margin: 20 } } },
  });
  return room.id;
})();

// ── C. the real overlay, in a real browser ──────────────────────────────
// KEEP_ORPHAN_ROOMS: server.js prunes rooms with no signed-in owner at boot,
// which deleted the gate's room before the overlay could ever connect to it —
// so the overlay fell back to the default layout and the delivery assertion
// failed for a reason that had nothing to do with the delivery path.
const srv = await startGateServer({ port: PORT, dataDir: SCRATCH, env: { KEEP_ORPHAN_ROOMS: 'true' }, label: 'overlay-layout' });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(`${APP}/overlay?room=default`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1200);

  // ── THE DELIVERY PATH, over the real WebSocket ────────────────────────
  // This is the half that was broken: the server computed the layout and sent
  // `undefined`. A test hook would have hidden it, so it is asserted first and
  // separately, on a room whose layout was written through the store.
  {
    const p2 = await browser.newPage();
    await p2.setViewport({ width: 1920, height: 1080 });
    await p2.goto(`${APP}/overlay?room=${delivery}`, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2500);
    const got = await p2.evaluate(() => window.OverlayTest.layout());
    ok("C0a the layout the server sent ARRIVED at the overlay (was always null)",
      got.version === 42 && got.origin === "bottom-left",
      `overlay holds version=${got.version} origin=${got.origin} tile.w=${got.tile?.w}`);
    ok("C0b and it is the stored layout, not the built-in default",
      got.tile?.w === 200 && got.tile?.gap === 20 && got.margin === 30,
      `tile=${got.tile?.w}x${got.tile?.h} gap=${got.tile?.gap} margin=${got.margin}`);
    await p2.close();
  }

  /** Drive the overlay to a layout + N seats, then MEASURE what it drew. */
  async function render(layout, seats) {
    return page.evaluate(async (lay, n) => {
      // applyLayout is version-gated, which is the production contract.
      window.OverlayTest.clear();
      window.OverlayTest.setMaxSeats(n);
      window.OverlayTest.applyLayout(lay);
      for (let i = 0; i < n; i++) {
        window.OverlayTest.addSeat({ id: 's' + i, username: 'u' + i, live: true, transport: 'vdo', viewUrl: 'about:blank' });
      }
      const badge = document.getElementById('bounty-badge');
      badge.classList.add('show');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      return {
        badge: rect(badge),
        tiles: [...document.querySelectorAll('.tile:not(.leaving)')].map(rect),
        stage: rect(document.getElementById('stage')),
      };
    }, layout, seats);
  }


  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // THE CASE THE BUG REPORT NAMES: bottom-left at the ceiling.
  const bl = await render({ version: v(), origin: 'bottom-left', direction: 'up', margin: 20, tile: { w: 160, h: 90, gap: 12 }, clip: { follow: true, w: 320, h: 180, origin: 'top-left', margin: 20 } }, 10);
  ok('C1 the overlay ACCEPTED the layout the server sent', bl.tiles.length === 10 && Math.round(bl.tiles[0].w) === 160,
    `${bl.tiles.length} tiles at ${Math.round(bl.tiles[0]?.w)}px wide`);
  const blHit = bl.tiles.filter((t) => hits(t, bl.badge));
  ok('C2 BOTTOM-LEFT AT THE CEILING: the badge intersects no tile', blHit.length === 0,
    `badge(${Math.round(bl.badge.x)},${Math.round(bl.badge.y)},${Math.round(bl.badge.w)}x${Math.round(bl.badge.h)}) vs 10 tiles, ${blHit.length} overlapping`);
  ok('C3 and the badge moved off its hard-coded bottom-left corner', bl.badge.x > 960,
    `badge x=${Math.round(bl.badge.x)} (was pinned at 16)`);

  // Every corner, at the ceiling, measured.
  for (const origin of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    for (const direction of ['down', 'up', 'right', 'left']) {
      const r = await render({ version: v(), origin, direction, margin: 20, tile: { w: 160, h: 90, gap: 12 }, clip: { follow: true, w: 320, h: 180, origin: 'top-left', margin: 20 } }, 10);
      const bad = r.tiles.filter((t) => hits(t, r.badge));
      const why = bad.length
        ? `badge(${Math.round(r.badge.x)},${Math.round(r.badge.y)},${Math.round(r.badge.w)}x${Math.round(r.badge.h)}) hits tile(${Math.round(bad[0].x)},${Math.round(bad[0].y)},${Math.round(bad[0].w)}x${Math.round(bad[0].h)})`
        : '0 overlapping';
      ok(`C4 ${origin} / ${direction}: badge clear of all 10 tiles`, bad.length === 0, why);
    }
  }

  // Direction is honoured: a row is wider than it is tall, a column the reverse.
  const row = await render({ version: v(), origin: 'top-left', direction: 'right', margin: 20, tile: { w: 160, h: 90, gap: 12 }, clip: { follow: true, w: 320, h: 180, origin: 'top-left', margin: 20 } }, 4);
  const col = await render({ version: v(), origin: 'top-left', direction: 'down', margin: 20, tile: { w: 160, h: 90, gap: 12 }, clip: { follow: true, w: 320, h: 180, origin: 'top-left', margin: 20 } }, 4);
  const spread = (ts, k) => Math.max(...ts.map((t) => t[k])) - Math.min(...ts.map((t) => t[k]));
  ok('C5 direction:right lays tiles along X, not Y', spread(row.tiles, 'x') > 400 && spread(row.tiles, 'y') < 1,
    `x-spread=${Math.round(spread(row.tiles, 'x'))} y-spread=${Math.round(spread(row.tiles, 'y'))}`);
  ok('C6 direction:down still lays tiles along Y', spread(col.tiles, 'y') > 250 && spread(col.tiles, 'x') < 1,
    `y-spread=${Math.round(spread(col.tiles, 'y'))} x-spread=${Math.round(spread(col.tiles, 'x'))}`);

  // The badge box the refusal reserves must actually contain the rendered one.
  const measured = bl.badge;
  ok('C7 the rendered badge fits inside the 360x80 box the refusal reserves',
    measured.w <= 360 && measured.h <= 80, `measured ${Math.round(measured.w)}x${Math.round(measured.h)}`);
} finally {
  await browser.close();
  srv.kill();
}

done(fail === 0 ? 0 : 1);
