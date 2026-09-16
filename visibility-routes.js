/**
 * OVERLAY VISIBILITY ROUTES — the streamer's browser telling us what their own
 * OBS says about their own overlay, for any live room.
 *
 * NOT under /api/bounty. Three reasons, and each one is load-bearing:
 *   - the bounty routes mount only when BOUNTY_CLAIM=1, and a streamer running
 *     a plain MegaChat room deserves to be told their overlay is hidden;
 *   - they are keyed to an AIR SESSION, which only a bounty claimant has;
 *   - `recordObsSceneSample` rebuilds its record from a fixed list of keys, so
 *     a new field posted into it is silently dropped. That exact whitelist ate
 *     six fields once already (OPEN-ISSUES A3 / the recordVerification
 *     regression), and a signal Part 3 never sees would read as "the overlay
 *     was never hidden" — the expensive direction.
 *
 * WHO MAY POST. The room's owner, by the sealed identity cookie, or the room
 * password — the same `verifyRoomAccess` the dashboard uses. This is telemetry
 * about the poster's own room; it is not accepted from anyone else, and it is
 * never accepted for a room that does not exist.
 *
 * THE FLOOR IS DERIVED HERE, NOT THERE. The client posts what it MEASURED —
 * the rendered rect, the effective scale, the source size. Whether that puts
 * the badge under the verifier's pixel floor is decided server-side against
 * `minCodePixelHeight`, because that number is what a payout turns on and the
 * client is deliberately never told it (bounty-claim.config.js keeps it out of
 * bountyClientConfig). A client that could name its own floor could name a
 * convenient one.
 */
import { verifyRoomAccess } from './auth.js';
import { normalizeRoomId, resolveRoomConfig } from './rooms-store.js';
import { recordSignal, signalsFor, latestFor, hiddenWindows } from './overlay-visibility.js';
import { bountyConfig } from './bounty-claim.config.js';
import * as seatEscrow from './seat-escrow.js';

/**
 * PASS C PART 3 — a visibility TRANSITION is what the money layers react to.
 * The bank (bounty clips) is wired by the server only when BOUNTY_CLAIM is
 * on; the seat escrow is always wired, because a plain room's guest seats are
 * metered whether or not the bounty program exists. Both are accounting
 * with stub settlement — nothing here moves funds.
 */
let onTransition = null;
export function setVisibilityTransitionHook(fn) { onTransition = fn; }

/**
 * The badge's glyph height in the overlay page's own CSS pixels.
 *
 * public/overlay.html draws the matrix at dot = 4 and a glyph is 7 dots tall,
 * so the code stands 28 CSS px high before OBS scales anything. The same
 * number is used by verifyOverlayInObs (web/lib/obs-oneclick.mjs) — if the
 * overlay's dot size ever changes, both move together or neither is right.
 */
const BADGE_GLYPH_CSS_PX = 28;

export function attachVisibilityRoutes(app, { log = console } = {}) {
  async function requireRoom(req, res, next) {
    const id = normalizeRoomId(req.params.roomId);
    if (!id) return res.status(400).json({ error: 'Invalid room id' });
    if (!resolveRoomConfig(id)) return res.status(404).json({ error: 'Room not found' });
    const access = await verifyRoomAccess(req, id);
    if (!access.ok) {
      return res.status(401).json({
        error: 'Unauthorized',
        hint: 'Sign in as the room owner, or provide the room password.',
      });
    }
    req.roomId = id;
    next();
  }

  /**
   * One observation from the streamer's browser.
   *
   * The body is what web/lib/obs-visibility.mjs measured. The SIGNAL is
   * re-derived here rather than taken on trust for the one case that touches
   * money — a badge scaled under the floor — so the client cannot post a
   * convenient verdict. Everything else it reports (which scene, which item
   * covers it) is diagnosis, not a decision, and is stored as given.
   */
  app.post('/api/rooms/:roomId/overlay-visibility', requireRoom, (req, res) => {
    const body = req.body || {};
    const { signal, reason = null, detail = null, scale = null, rect = null, occlusion = null, sessionKey = null } = body;
    if (typeof signal !== 'string') {
      return res.status(400).json({ error: 'signal is required' });
    }

    // Derive the badge's rendered height from the measurement. `scaleY` is the
    // EFFECTIVE scale (rendered height / source height), so the badge's height
    // on the broadcast canvas is the CSS height times that — independent of
    // the browser source's own page size.
    const scaleY = Number(scale?.scaleY);
    const badgePx = Number.isFinite(scaleY) && scaleY > 0 ? BADGE_GLYPH_CSS_PX * scaleY : null;
    const floor = bountyConfig.minCodePixelHeight;
    const belowFloor = badgePx != null && badgePx < floor;

    // A visible overlay whose badge is under the floor is its OWN signal. The
    // spec is explicit that this differs from hidden and that Part 3 treats
    // them differently: the overlay IS on screen, the streamer has done
    // nothing wrong, and the clip still cannot be verified.
    const effective = signal === 'overlay_visible' && belowFloor ? 'overlay_scaled_below_floor' : signal;
    const effectiveReason = effective === 'overlay_hidden' ? reason : null;

    let result;
    try {
      result = recordSignal(req.roomId, {
        signal: effective,
        reason: effectiveReason,
        at: Date.now(),
        detail: effective === 'overlay_scaled_below_floor'
          ? `badge renders at ${badgePx.toFixed(1)}px against a ${floor}px floor`
          : detail,
        sessionKey,
        measurement: { rect, scale, occlusion, badgePx, floor },
      });
    } catch (err) {
      return res.status(400).json({ error: 'Invalid signal', hint: err.message });
    }

    if (result.appended) {
      log.log?.(`[visibility] room ${req.roomId}: ${effective}${effectiveReason ? ' (' + effectiveReason + ')' : ''}`);
      // The seat escrow pauses, resumes, refunds and sweeps on transitions —
      // never on repeats, which is why this sits inside `appended`.
      try {
        const seatOut = seatEscrow.onVisibility(req.roomId, effective, { at: result.row.at, reason: effectiveReason });
        if (seatOut.paused.length || seatOut.resumed.length) {
          log.log?.(`[seat-escrow] room ${req.roomId}: paused ${seatOut.paused.length}, resumed ${seatOut.resumed.length}, refunds ${seatOut.refunds.length}, sweeps ${seatOut.sweeps.length}`);
        }
      } catch (e) {
        log.warn?.(`[seat-escrow] visibility hook failed: ${e?.message}`);
      }
      if (onTransition) {
        try { onTransition(req.roomId, effective, { at: result.row.at, reason: effectiveReason }); }
        catch (e) { log.warn?.(`[visibility] transition hook failed: ${e?.message}`); }
      }
    }
    res.json({
      ok: true,
      recorded: result.appended,
      signal: effective,
      reason: effectiveReason,
      belowFloor,
      badgePx,
    });
  });

  /** What the dashboard renders, and what a human reviewing a dispute reads. */
  app.get('/api/rooms/:roomId/overlay-visibility', requireRoom, (req, res) => {
    const sessionKey = req.query.sessionKey || null;
    const latest = latestFor(req.roomId, sessionKey);
    res.json({
      current: latest
        ? { signal: latest.signal, reason: latest.reason, at: latest.at, detail: latest.detail }
        : null,
      windows: hiddenWindows(req.roomId, { sessionKey }),
      count: signalsFor(req.roomId, { sessionKey }).length,
    });
  });

  /**
   * What the streamer sees about their guest-seat money: pending, released,
   * held back, and — for a manual-paste room — why it holds longer and until
   * when. Owner-authorized like the rest of this file.
   */
  app.get('/api/rooms/:roomId/seat-escrow', requireRoom, (req, res) => {
    res.json({ ok: true, ...seatEscrow.summaryFor(req.roomId) });
  });

  log.log?.('[visibility] overlay visibility routes ready');
  return { mounted: true };
}
