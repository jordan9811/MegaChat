/**
 * money-routes.js — the door's intents, for the person who holds the keys.
 *
 * Admin only (the site owner's account, or BOUNTY_ADMIN_KEY — the same two
 * credentials every other admin surface takes). Three routes, no money moved
 * by any of them:
 *
 *   GET  /api/money/intents?status=PENDING   every intent on the door, with
 *        what it is for. For a seat refund (`seat:<id>:buried:…`) the seat's
 *        own figures ride along — what it accrued, what every refund so far
 *        asks for — so the pre-round buried refunds (OPEN-ISSUES U2,
 *        launch-readiness row 63) can be judged before PLATFORM_SETTLEMENT_KEY
 *        lands and the first flush pays them blind.
 *   POST /api/money/intents/:ref/void {why}  withdraw ONE PENDING intent: a
 *        VOID row, terminal, never sent (settlement.js void). Only PENDING.
 *   GET  /api/money/summary                  counts by status, which signers
 *        are configured, whether the door is halted.
 */
import { readIdentityFromRequest } from './auth.js';
import { isSiteAdmin } from './site-settings.js';
import { adminKeyMatches } from './bounty-auth.js';
import { fromAtomic } from './token-utils.js';

const big = (v) => BigInt(v ?? 0);

function requireAdmin(req, res, next) {
  const identity = readIdentityFromRequest(req);
  if (isSiteAdmin(identity) || adminKeyMatches(req)) return next();
  return res.status(identity ? 403 : 401).json({ error: 'Admin only', reason: identity ? 'not_admin' : 'auth_required' });
}

/** The seat behind a `seat:<id>:…` ref, as the seat ledger folds it, or null. */
function seatContext(seatEscrow, rec) {
  const m = /^seat:([^:]+):/.exec(rec.ref || '');
  const seatId = m?.[1] || rec.meta?.seatId || null;
  if (!seatId || typeof seatEscrow?.seatRecord !== 'function') return null;
  let s = null;
  try { s = seatEscrow.seatRecord(seatId); } catch { return null; }
  if (!s) return { seatId, known: false };
  const dec = s.token?.decimals ?? 6;
  const buried = (s.history || []).filter((h) => h.type === 'SEAT_REFUND_BURIED').length;
  return {
    seatId, known: true, mode: s.mode, state: s.state, roomId: s.roomId,
    viewer: s.viewer, streamer: s.streamer,
    accrued: fromAtomic(big(s.accrued), dec),
    refundedFromStreamer: fromAtomic(big(s.refundedFromStreamer), dec),
    refundedFromPlatform: fromAtomic(big(s.refundedFromPlatform), dec),
    released: fromAtomic(big(s.released), dec),
    buriedRefundRows: buried,
    ticks: Array.isArray(s.ticks) ? s.ticks.length : null,
    flags: (s.flags || []).map((f) => f.cause),
  };
}

export function attachMoneyRoutes(app, { settlement, seatEscrow = null }) {
  if (!settlement) throw new Error('attachMoneyRoutes needs the settlement door');

  app.get('/api/money/summary', requireAdmin, (_req, res) => {
    res.json({ ok: true, ...settlement.summary() });
  });

  app.get('/api/money/intents', requireAdmin, (req, res) => {
    const want = String(req.query.status || 'PENDING').toUpperCase();
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : null;
    const all = settlement.all();
    const rows = all
      .filter((r) => (want === 'ALL' || r.status === want) && (!prefix || String(r.ref).startsWith(prefix)))
      .sort((a, b) => (a.intendedAt || 0) - (b.intendedAt || 0))
      .map((r) => ({
        ref: r.ref, status: r.status, kind: r.kind, signer: r.signer, to: r.to,
        amountAtomic: r.amountAtomic ?? null,
        amount: r.amountAtomic != null && r.token ? fromAtomic(big(r.amountAtomic), r.token.decimals ?? 6) : null,
        token: r.token?.symbol || null, intendedAt: r.intendedAt || null, txHash: r.txHash || null,
        meta: r.meta || null,
        ...(r.status === 'VOIDED' ? { voidedBy: r.voidedBy, voidWhy: r.voidWhy, voidedAt: r.voidedAt } : {}),
        seat: seatContext(seatEscrow, r),
      }));
    // Per seat, every PENDING refund asks for how much in all — the figure a
    // person compares with what the seat paid (row 63).
    const perSeat = {};
    for (const r of rows) {
      if (r.status !== 'PENDING' || !r.seat?.seatId) continue;
      const k = r.seat.seatId;
      perSeat[k] = perSeat[k] || { seatId: k, pendingRefunds: 0, pendingAtomic: 0n, accrued: r.seat.accrued ?? null };
      perSeat[k].pendingRefunds += 1;
      perSeat[k].pendingAtomic += big(r.amountAtomic);
    }
    const seats = Object.values(perSeat).map((x) => ({
      ...x, pendingAtomic: x.pendingAtomic.toString(), pendingAmount: fromAtomic(x.pendingAtomic, 6),
      exceedsAccrued: x.accrued != null && Number(fromAtomic(x.pendingAtomic, 6)) > Number(x.accrued),
    }));
    res.json({ ok: true, status: want, count: rows.length, intents: rows, seats, summary: settlement.summary() });
  });

  app.post('/api/money/intents/:ref/void', requireAdmin, (req, res) => {
    const identity = readIdentityFromRequest(req);
    const by = identity?.accountId ? `account:${identity.accountId}` : 'admin-key';
    const why = String(req.body?.why || '').trim();
    if (!why) return res.status(400).json({ error: 'why is required: a void with no reason is a hole in the record', reason: 'why_required' });
    try {
      const r = settlement.void(String(req.params.ref), { by, why });
      res.json({ ok: true, ref: req.params.ref, status: r.status, row: r.row });
    } catch (e) {
      const status = e.code === 'not_found' ? 404 : e.code === 'not_pending' ? 409 : 400;
      res.status(status).json({ error: e.message, reason: e.code || null, ...(e.status ? { intentStatus: e.status } : {}) });
    }
  });

  console.log('[money] admin routes attached — /api/money/intents (list, void), /api/money/summary');
}
