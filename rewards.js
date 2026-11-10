// ─── Watch-to-earn (isolated — never breaks pay-to-join) ─────────────────────
//
// WHO IS PAID, AND WITH WHAT (money-1, DECISIONS 2026-10-24). A room's reward
// is ONE of three things, never two:
//   cash    a USDC transfer from the reward pool (REWARD_POOL_PRIVATE_KEY),
//           recorded as a door intent. Only in an OWNED room whose creator's
//           account id is on REWARDS_CASH_ALLOWLIST (`*` = every owned room;
//           unset or empty = cash off). Never in a password-only room. Only
//           while the door holds a pool signer: no liability is recorded
//           that nothing can pay. Paid to the SIGNED-IN account's payout
//           wallet, never to a wallet the client names.
//   credit  off-chain seat credit in the room (rewards.payout 'credit', and
//           every 'token' reward: no token reward has a cash path). Also
//           signed-in, also to the account's payout wallet.
//   points  the room's own currency: no sign-in, the client's wallet.
// Watching never needs sign-in (the no-login-wall decision); earning cash or
// credit does, because a per-wallet cap is no cap when a wallet costs nothing.
//
// BOUNDS, server-side, whatever the room stored: an earn interval of at least
// REWARDS_MIN_INTERVAL_S, at most REWARDS_MAX_EARN per earn and REWARDS_MAX_CAP
// per wallet and per account in a room, in the reward's own units. The cap is
// LIFETIME per room and lives in data/rewards-ledger.jsonl, so neither a new
// socket, a re-register nor a restart resets it (it used to be a per-socket
// counter that re-registering zeroed: 5x the cap in four seconds). Points are
// not money: no bounds beyond the room's own, and their cap is per wallet in
// memory. One earning socket per account (or points wallet) per room; a newer
// register supersedes the older.
//
// THE DEMO ROOM (demo-money.js) is the one exception to the bounds above: its
// reward is DEMO MONEY, seat credit that is never real, so it earns on its own
// terms (every 1 s at the fastest, its own amount and cap), credit only, never
// cash, and only while the house budget (DEMO_CREDIT_HOURLY / _DAILY, across
// all users) has room. It is held by a placeholder wallet per account
// (demoWalletFor), not the payout wallet, and the account page never lists it.
import path from 'path';
import { fileURLToPath } from 'url';
import { createLedger } from './bounty-ledger.js';
import { creditViewer, parseRewardAmount, formatRewardAmount, getCredit } from './reward-credits.js';
import { toAtomic, isEvmAddress } from './token-utils.js';
import { isDemoRoom, demoWalletFor, createDemoBudget } from './demo-money.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A viewer's demo-money cap counts one visit: it starts again when they leave
// the demo and come back (owner, 2026-11-10: "reset the counter when you leave
// the demo and let it re-accrue"). Away less than this is a refresh, not a
// leave. The house budget (demo-money.js) still bounds every visit together.
const DEMO_VISIT_GRACE_MS = Number(process.env.DEMO_VISIT_GRACE_MS) || 30_000;
const posInt = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/** The operator's bounds, read when the rewards attach (after server.js loads .env). Env names only. */
export function rewardBounds(env = process.env) {
  const list = String(env.REWARDS_CASH_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    cashAllowAll: list.includes('*'),
    cashAllow: new Set(list.filter((s) => s !== '*')),
    minIntervalS: posInt(env.REWARDS_MIN_INTERVAL_S, 60),
    maxEarn: String(env.REWARDS_MAX_EARN || '0.01'),
    maxCap: String(env.REWARDS_MAX_CAP || '0.1'),
  };
}

/**
 * @param {import('ws').WebSocketServer} wss
 * @param {object} opts
 * @param {Function} opts.getRoomConfig — (roomId) => room config or null
 * @param {object}   [opts.settlement]   — the settlement door
 * @param {string}   [opts.usdcAddress]
 * @param {Function} [opts.identityFor]  — (req) => the signed-in identity on the socket's upgrade, or null
 * @param {Function} [opts.payoutWalletFor] — (accountId) => that account's payout wallet, or null
 * @param {Function} [opts.roomOwnerFor] — (roomId) => the owning account id, or null (a password-only room)
 * @param {boolean}  [opts.ownListener]  — false when the server parses messages and calls handleMessage
 */
export function attachRewards(wss, opts = {}) {
  const getRoomConfig = opts.getRoomConfig || (() => null);
  // A cash reward is a plain TIP-20 transfer from the pool wallet, recorded
  // as an INTENT with the settlement door, which is the only place a key
  // signs anything (settlement.js), from its `rewardPool` slot.
  const usdcAddress = opts.usdcAddress || null;
  const settlement = opts.settlement || null;
  const identityFor = opts.identityFor || (() => null);
  const payoutWalletFor = opts.payoutWalletFor || (() => null);
  const roomOwnerFor = opts.roomOwnerFor || (() => null);
  const bounds = rewardBounds(opts.env || process.env);
  const poolReady = () => !!(settlement && usdcAddress && settlement.hasSigner('rewardPool'));
  if (!poolReady()) console.warn('[rewards] no reward-pool signer at the settlement door — cash rewards are OFF (credit and points still work).');

  // The persisted earn record: one EARN row per reward issued, cash or credit.
  const ledger = createLedger({ filePath: path.join(opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'), 'rewards-ledger.jsonl'), kind: 'rewards' });
  const earned = new Map(); // `${roomId}|w:${wallet}` and `${roomId}|a:${accountId}` → atomic earned, lifetime
  const addEarned = (k, a) => earned.set(k, (earned.get(k) || 0n) + a);
  const walletKey = (roomId, w) => `${roomId}|w:${String(w).toLowerCase()}`;
  const acctKey = (roomId, a) => `${roomId}|a:${a}`;
  let earnedReady = false;
  function loadEarned() {
    if (earnedReady) return;
    for (const r of ledger.all()) {
      if (r.type !== 'EARN') continue;
      addEarned(walletKey(r.roomId, r.payee), BigInt(r.amountAtomic));
      if (r.accountId) addEarned(acctKey(r.roomId, r.accountId), BigInt(r.amountAtomic));
    }
    earnedReady = true;
  }
  const pointsEarned = new Map(); // points are not money: per (room, wallet), in memory
  // The house budget over every demo grant, folded from this ledger.
  const demoBudget = createDemoBudget({ rows: () => ledger.all(), env: opts.env || process.env });
  // A cash EARN row is written before its door intent, and its ref is the
  // row's seq, so a crash between the two leaves an EARN with no intent:
  // record the missing intents now (idempotent on ref), if a pool signer exists.
  try {
    loadEarned();
    if (poolReady()) {
      for (const r of ledger.all()) {
        if (r.type === 'EARN' && r.mode === 'cash' && !settlement.status(intentRefOf(r))) recordIntent(r);
      }
    }
  } catch (e) { console.error(`[rewards] the rewards ledger cannot be read — rewards are OFF: ${e.message}`); }

  function intentRefOf(row) { return `reward:${row.roomId}:${row.seq}`; }
  function recordIntent(row) {
    return settlement.release({
      signer: 'rewardPool', to: row.payee, amountAtomic: row.amountAtomic,
      token: { address: usdcAddress, decimals: 6, symbol: 'USDC' }, bucket: 'reward',
      ref: intentRefOf(row), meta: { roomId: row.roomId, accountId: row.accountId || null },
    });
  }

  const sessions = new Map();
  const holders = new Map(); // `${roomId}|${who}` → the one ws earning for it
  // Demo visits per holder key: { start, left } (ms). In memory: a deploy starts everyone a fresh visit.
  const demoVisits = new Map();

  function send(ws, msg) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  function rewardMeta(roomCfg) {
    const rw = roomCfg?.rewards || {};
    if (rw.rewardType === 'points') {
      return { type: 'points', symbol: 'PTS', decimals: 0 };
    }
    if (rw.rewardType === 'token' && rw.rewardTokenAddress) {
      return {
        type: 'token',
        symbol: rw.rewardTokenSymbol || roomCfg.paymentTokenSymbol || 'TOKEN',
        decimals: rw.rewardTokenDecimals ?? roomCfg.paymentTokenDecimals ?? 6,
      };
    }
    return { type: 'usdc', symbol: 'USDC', decimals: 6 };
  }

  const min = (a, b) => (a < b ? a : b);

  /**
   * What THIS socket may earn in this room right now: the payout mode, the
   * payee, the bounded interval / amount / cap — or why not (`reason`, which
   * the client shows). Decided on the server from the room, the operator's
   * bounds and the signed-in identity; nothing the client sends but the room
   * id and, for points only, a wallet.
   */
  function policyFor(state) {
    const cfg = state.roomId ? getRoomConfig(state.roomId) : null;
    const rw = cfg?.rewards;
    if (!rw?.enabled) return { enabled: false, reason: 'rewards_off' };
    const meta = rewardMeta(cfg);
    const mode = meta.type === 'points' ? 'points' : meta.type === 'token' || rw.payout === 'credit' ? 'credit' : 'cash';
    // The demo's reward is demo money, which is credit and never cash.
    const demo = isDemoRoom(cfg) && mode !== 'points';
    const base = { mode, meta, rw, demo };
    if (demo && mode === 'cash') return { ...base, enabled: false, reason: 'demo_money_only' };
    let interval, earn, cap;
    try {
      interval = Number(rw.earnInterval) > 0 ? Number(rw.earnInterval) : 60;
      earn = parseRewardAmount(rw.earnAmount, meta.decimals);
      cap = parseRewardAmount(rw.earnCap, meta.decimals);
      if (demo) {
        // Demo money: the room's own terms, every second at the fastest; the
        // house budget is what bounds it (demoBudget, below and in earnOnce).
        interval = Math.max(1, Math.round(interval));
      } else if (mode !== 'points') {
        interval = Math.max(interval, bounds.minIntervalS);
        earn = min(earn, toAtomic(bounds.maxEarn, meta.decimals));
        cap = min(cap, toAtomic(bounds.maxCap, meta.decimals));
      }
    } catch { return { ...base, enabled: false, reason: 'bad_config' }; }
    if (earn <= 0n || cap <= 0n) return { ...base, enabled: false, reason: 'bad_config' };
    const limits = { interval, earn, cap };
    // After the bounds, so a paused room's page still shows the real terms.
    if (cfg.active === false) return { ...base, ...limits, enabled: false, reason: 'room_not_live' };
    if (mode === 'points') {
      if (!state.wallet) return { ...base, ...limits, enabled: false, reason: 'wallet_required' };
      return { ...base, ...limits, enabled: true, payee: state.wallet, holder: `w:${state.wallet.toLowerCase()}` };
    }
    if (mode === 'cash') {
      const owner = roomOwnerFor(state.roomId);
      if (!owner) return { ...base, ...limits, enabled: false, reason: 'password_room' };
      if (!bounds.cashAllowAll && !bounds.cashAllow.size) return { ...base, ...limits, enabled: false, reason: 'cash_rewards_off' };
      if (!bounds.cashAllowAll && !bounds.cashAllow.has(owner)) return { ...base, ...limits, enabled: false, reason: 'cash_not_allowed' };
      if (!poolReady()) return { ...base, ...limits, enabled: false, reason: 'no_pool_signer' };
    }
    if (ledger.corrupt) return { ...base, ...limits, enabled: false, reason: 'ledger_corrupt' };
    if (demo) {
      const spent = demoBudget.state().blocked;
      if (spent) return { ...base, ...limits, enabled: false, reason: spent };
    }
    if (!state.identity?.accountId) return { ...base, ...limits, enabled: false, reason: 'sign_in_required' };
    if (demo) {
      // Demo money is paid to no one: its placeholder wallet, never the payout wallet.
      const payee = demoWalletFor(state.identity.accountId);
      return { ...base, ...limits, enabled: true, payee, accountId: state.identity.accountId, holder: `a:${state.identity.accountId}` };
    }
    const payee = payoutWalletFor(state.identity.accountId);
    if (!isEvmAddress(payee)) return { ...base, ...limits, enabled: false, reason: 'payout_wallet_required' };
    return { ...base, ...limits, enabled: true, payee, accountId: state.identity.accountId, holder: `a:${state.identity.accountId}` };
  }

  /** Lifetime earned in this room by this payee, and by this account: the larger counts against the cap. */
  function earnedSoFar(roomId, p) {
    if (p.mode === 'points') return pointsEarned.get(walletKey(roomId, p.payee)) || 0n;
    // Demo money counts this visit's grants (from the ledger), not a lifetime
    // total: leave and come back, and it starts at $0 again. Counting what is
    // in hand instead let a viewer keep earning while their money sat in a
    // running Call in, which drained the house budget: within a visit the
    // count only goes up, spent or not.
    if (p.demo) {
      const since = demoVisits.get(`${roomId}|${p.holder}`)?.start ?? Date.now();
      let sum = 0n;
      for (const r of ledger.all()) {
        if (r.type === 'EARN' && r.house === 'demo' && r.roomId === roomId && r.at > since
          && ((p.accountId && r.accountId === p.accountId) || String(r.payee).toLowerCase() === String(p.payee).toLowerCase())) sum += BigInt(r.amountAtomic);
      }
      return sum;
    }
    loadEarned();
    const byWallet = earned.get(walletKey(roomId, p.payee)) || 0n;
    const byAccount = p.accountId ? earned.get(acctKey(roomId, p.accountId)) || 0n : 0n;
    return byWallet > byAccount ? byWallet : byAccount;
  }

  // What this viewer already earned here, for a socket that is not earning
  // (paused, taken over by another tab, a payout wallet missing): the page
  // keeps showing it instead of dropping the balance from view. Only where the
  // server knows whose it is: the signed-in account, or for points the wallet
  // the page named.
  function keptFor(state, p) {
    if (!state.roomId || !p.meta) return {};
    let atomic = null;
    if (p.mode === 'points') {
      if (state.wallet) atomic = pointsEarned.get(walletKey(state.roomId, state.wallet)) || 0n;
    } else if (state.identity?.accountId) {
      loadEarned();
      atomic = earned.get(acctKey(state.roomId, state.identity.accountId)) || 0n;
    }
    return atomic == null ? {} : { earned: formatRewardAmount(atomic, p.meta.decimals) };
  }

  // The demo page needs the spendable demo money and the wallet that holds it
  // whatever the earning state (paused by the house budget, maxed), because
  // spending it on a Call in or a Holler does not depend on earning more.
  function demoExtras(state, p) {
    if (!p.demo) return {};
    const holder = state.identity?.accountId ? demoWalletFor(state.identity.accountId) : null;
    return {
      demo: true,
      ...(holder ? { payee: holder, joinBalance: formatRewardAmount(getCredit(state.roomId, holder).atomic, p.meta.decimals) } : {}),
    };
  }

  function configMessage(state, p) {
    return {
      type: 'rewards_config',
      roomId: state.roomId,
      enabled: !!p.enabled,
      ...(p.enabled ? {} : { reason: p.reason }),
      payout: p.mode || null,
      earnInterval: p.interval ?? p.rw?.earnInterval ?? 60,
      earnAmount: p.earn != null ? formatRewardAmount(p.earn, p.meta.decimals) : p.rw?.earnAmount ?? '0',
      earnCap: p.cap != null ? formatRewardAmount(p.cap, p.meta.decimals) : p.rw?.earnCap ?? '0',
      rewardType: p.rw?.rewardType ?? 'usdc',
      symbol: p.meta?.symbol || 'USDC',
      // dryRun: true when nothing on chain moves for this reward.
      dryRun: p.mode !== 'cash',
      ...(p.enabled ? { payee: p.payee, earned: formatRewardAmount(earnedSoFar(state.roomId, p), p.meta.decimals) } : keptFor(state, p)),
      ...demoExtras(state, p),
    };
  }

  function earnOnce(ws, state) {
    const p = policyFor(state);
    if (!p.enabled || holders.get(`${state.roomId}|${p.holder}`) !== ws) return;
    const so = earnedSoFar(state.roomId, p);
    let amountAtomic = min(p.earn, p.cap - so);
    // Never past the house budget: a grant is cut to what is left of it, and
    // none is made once it is spent (the ticker then pushes the paused state).
    if (p.demo && amountAtomic > 0n) {
      const left = demoBudget.state().left;
      if (left <= 0n) return;
      amountAtomic = min(amountAtomic, left);
    }
    if (amountAtomic <= 0n) {
      send(ws, { type: 'rewards_earned', roomId: state.roomId, payout: p.mode, earned: formatRewardAmount(so, p.meta.decimals), symbol: p.meta.symbol, capped: true, dryRun: p.mode !== 'cash', ...(p.demo ? { demo: true } : {}) });
      return;
    }
    let intentRef = null;
    if (p.mode === 'points') {
      pointsEarned.set(walletKey(state.roomId, p.payee), so + amountAtomic);
      creditViewer(state.roomId, p.payee, amountAtomic, p.meta);
    } else {
      // The EARN row first: it is what the cap counts, and a cash intent's ref
      // is its seq. Then ONE of: the cash intent, or the seat credit.
      const at = Date.now();
      const row = ledger.append({ type: 'EARN', roomId: state.roomId, accountId: p.accountId, payee: p.payee, mode: p.mode, amountAtomic: amountAtomic.toString(), decimals: p.meta.decimals, symbol: p.meta.symbol, at, ...(p.demo ? { house: 'demo' } : {}) });
      if (p.demo) demoBudget.note(amountAtomic, at);
      addEarned(walletKey(state.roomId, p.payee), amountAtomic);
      addEarned(acctKey(state.roomId, p.accountId), amountAtomic);
      if (p.mode === 'cash') intentRef = recordIntent(row).row.ref;
      else creditViewer(state.roomId, p.payee, amountAtomic, p.meta);
    }
    const total = so + amountAtomic;
    send(ws, {
      type: 'rewards_earned',
      roomId: state.roomId,
      payout: p.mode,
      credited: formatRewardAmount(amountAtomic, p.meta.decimals),
      earned: formatRewardAmount(total, p.meta.decimals),
      // The spendable seat balance, where the reward IS seat balance.
      ...(p.mode === 'cash' ? {} : { joinBalance: formatRewardAmount(getCredit(state.roomId, p.payee).atomic, p.meta.decimals) }),
      symbol: p.meta.symbol,
      ...(intentRef ? { intentRef } : {}),
      ...(p.demo ? { demo: true } : {}),
      capped: total >= p.cap,
      dryRun: p.mode !== 'cash',
    });
    console.log(`[rewards] room ${state.roomId} ${p.mode} ${formatRewardAmount(amountAtomic, p.meta.decimals)} ${p.meta.symbol} → ${p.payee}`);
  }

  // Cumulative watch-time per (room, wallet) — feeds the per-feature
  // reputation gates (min watch time). Counts in EVERY room, rewards on or
  // off. In-memory: resets on server restart (documented).
  const watchSeconds = new Map();

  // Pause and resume reach the open pages (rw-pause-silent). The policy has
  // always stopped paying while a room is paused, but said nothing, so a page
  // kept promising earning that was not happening. A registered socket whose
  // room flips between live and paused registers again, which re-reads the
  // policy and pushes the new state (with the balance kept). A socket another
  // tab took over stays as it is: resuming must not take the earning back.
  function syncLive(ws, state) {
    const live = getRoomConfig(state.roomId)?.active !== false;
    if (state.live === live) return;
    state.live = live;
    if (!state.superseded) register(ws, state);
  }

  // The house budget reaches the open demo pages the same way: a demo socket
  // whose budget state flips (spent, or freed as the window rolls) registers
  // again, which pushes the paused or earning state in words.
  function syncBudget(ws, state, blocked) {
    if (state.budgetBlocked === blocked) return;
    state.budgetBlocked = blocked;
    if (!state.superseded) register(ws, state);
  }

  const ticker = setInterval(() => {
    let budgetBlocked;
    for (const [ws, state] of sessions.entries()) {
      if (state.roomId) syncLive(ws, state);
      if (state.demo) {
        if (budgetBlocked === undefined) budgetBlocked = demoBudget.state().blocked;
        syncBudget(ws, state, budgetBlocked);
      }
      if (!state.visible || !state.roomId) continue;
      const watcher = state.wallet || state.payee;
      if (watcher) {
        const wk = `${state.roomId}:${watcher.toLowerCase()}`;
        watchSeconds.set(wk, (watchSeconds.get(wk) || 0) + 1);
      }
      if (!state.interval) continue;
      state.accruedMs += 1000;
      if (state.accruedMs >= state.interval * 1000) {
        state.accruedMs -= state.interval * 1000;
        try { earnOnce(ws, state); } catch (e) { console.warn('[rewards] earn error:', e.message); }
      }
    }
  }, 1000);
  if (typeof ticker.unref === 'function') ticker.unref();

  function release(ws, state) {
    if (state.holderKey && state.demo) { const v = demoVisits.get(state.holderKey); if (v) v.left = Date.now(); }
    if (state.holderKey && holders.get(state.holderKey) === ws) holders.delete(state.holderKey);
    state.holderKey = null;
  }

  // (Re)read this socket's policy for its room and tell the page: on the
  // page's register, and on the room's pause or resume (syncLive).
  function register(ws, state) {
    release(ws, state);
    state.accruedMs = 0;
    state.superseded = false;
    state.live = state.roomId ? getRoomConfig(state.roomId)?.active !== false : true;
    const p = policyFor(state);
    state.interval = p.enabled ? p.interval : 0;
    state.payee = p.enabled ? p.payee : null;
    state.demo = !!p.demo;
    if (p.demo) state.budgetBlocked = demoBudget.state().blocked;
    if (p.enabled) {
      // One earning socket per account (points: per wallet) per room.
      state.holderKey = `${state.roomId}|${p.holder}`;
      const prev = holders.get(state.holderKey);
      if (prev && prev !== ws) {
        const ps = sessions.get(prev);
        if (ps) { ps.interval = 0; ps.holderKey = null; ps.superseded = true; }
        send(prev, { ...configMessage(ps || state, { ...p, enabled: false, reason: 'superseded' }) });
      }
      holders.set(state.holderKey, ws);
      if (p.demo) {
        // A new visit when nobody was here for this account past the grace.
        const v = demoVisits.get(state.holderKey);
        const now = Date.now();
        if (!v || (!prev && v.left != null && now - v.left > DEMO_VISIT_GRACE_MS)) demoVisits.set(state.holderKey, { start: now, left: null });
        else v.left = null;
      }
    }
    send(ws, configMessage(state, p));
    if (p.enabled && p.mode !== 'cash') {
      send(ws, { type: 'rewards_earned', roomId: state.roomId, payout: p.mode, earned: formatRewardAmount(earnedSoFar(state.roomId, p), p.meta.decimals), joinBalance: formatRewardAmount(getCredit(state.roomId, p.payee).atomic, p.meta.decimals), symbol: p.meta.symbol, dryRun: true, ...(p.demo ? { demo: true } : {}) });
    }
  }

  /** One parsed message from a socket. Exported for a server that parses once. */
  function handleMessage(ws, msg) {
    const state = sessions.get(ws);
    if (!state || !msg) return;
    switch (msg.type) {
      case 'rewards_register': {
        state.roomId = typeof msg.roomId === 'string' ? msg.roomId : null;
        // A wallet the client names is used only for points and watch time.
        state.wallet = isEvmAddress(msg.wallet) ? msg.wallet : null;
        register(ws, state);
        break;
      }
      case 'rewards_visibility':
        state.visible = !!msg.visible;
        break;
      default:
        break;
    }
  }

  wss.on('connection', (ws, req) => {
    // The sealed identity cookie rides the same-origin upgrade; this is the
    // only place a socket learns who it is. Signing in later needs a new
    // socket (the client reconnects after sign-in).
    let identity = null;
    try { identity = req ? identityFor(req) : null; } catch { identity = null; }
    sessions.set(ws, { identity, wallet: null, payee: null, roomId: null, visible: true, accruedMs: 0, interval: 0, holderKey: null });

    if (opts.ownListener !== false) {
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        handleMessage(ws, msg);
      });
    }

    ws.on('close', () => {
      const state = sessions.get(ws);
      if (state) release(ws, state);
      sessions.delete(ws);
    });
  });

  console.log(`[rewards] per-room rewards attached — cash ${poolReady() ? (bounds.cashAllowAll ? 'on for every owned room' : bounds.cashAllow.size ? `on for ${bounds.cashAllow.size} allowlisted creator(s)` : 'off (REWARDS_CASH_ALLOWLIST unset)') : 'off (no reward-pool signer)'}`);

  /**
   * What one signed-in account has earned, room by room (rw-no-trail, the
   * account page's Rewards section). Read-only: the EARN rows the cap counts
   * (data/rewards-ledger.jsonl, which survives a restart), the seat credit
   * still spendable (reward-credits.js, in memory: a restart empties it while
   * the rows remain, which is why both are shown), the room's cap as it
   * stands now, and every Cash transfer with its door status and hash.
   * Points are not here: they belong to a wallet, not an account.
   */
  function summaryFor(accountId) {
    if (!accountId) return { rooms: [] };
    loadEarned();
    const byRoom = new Map();
    for (const r of ledger.all()) {
      if (r.type !== 'EARN' || r.accountId !== accountId) continue;
      // Demo money is never real: the account's Rewards section never lists it.
      if (r.house === 'demo' || isDemoRoom(getRoomConfig(r.roomId))) continue;
      let room = byRoom.get(r.roomId);
      if (!room) byRoom.set(r.roomId, (room = { roomId: r.roomId, decimals: Number(r.decimals ?? 6), symbol: r.symbol || 'USDC', earned: 0n, cash: 0n, credit: 0n, payees: new Set(), transfers: [], lastAt: 0 }));
      const amt = BigInt(r.amountAtomic || 0);
      room.earned += amt;
      if (r.mode === 'cash') room.cash += amt; else room.credit += amt;
      if (r.payee) room.payees.add(String(r.payee).toLowerCase());
      room.lastAt = Math.max(room.lastAt, Number(r.at) || 0);
      if (r.mode === 'cash') {
        const ref = intentRefOf(r);
        const door = settlement?.status ? settlement.status(ref) : null;
        room.transfers.push({ ref, at: r.at || null, amount: formatRewardAmount(amt, room.decimals), to: r.payee || null, status: door?.status || null, txHash: door?.txHash || null });
      }
    }
    const rooms = [...byRoom.values()].sort((a, b) => b.lastAt - a.lastAt).map((room) => {
      const cfg = getRoomConfig(room.roomId);
      let spendable = 0n;
      for (const w of room.payees) spendable += getCredit(room.roomId, w).atomic;
      // The cap as the room is set now, bounded as policyFor bounds it.
      let cap = null;
      try {
        const rw = cfg?.rewards;
        if (rw?.enabled && rw.earnCap != null) {
          const c = parseRewardAmount(rw.earnCap, room.decimals);
          const bound = toAtomic(bounds.maxCap, room.decimals);
          cap = c < bound ? c : bound;
        }
      } catch { cap = null; }
      const counted = earned.get(acctKey(room.roomId, accountId)) || room.earned;
      return {
        roomId: room.roomId,
        name: cfg?.name || null,
        handle: cfg?.handle || null,
        symbol: room.symbol,
        earned: formatRewardAmount(room.earned, room.decimals),
        cash: formatRewardAmount(room.cash, room.decimals),
        credit: formatRewardAmount(room.credit, room.decimals),
        spendableCredit: formatRewardAmount(spendable, room.decimals),
        cap: cap != null && cap > 0n ? formatRewardAmount(cap, room.decimals) : null,
        capReached: cap != null && cap > 0n ? counted >= cap : false,
        transfers: room.transfers.reverse(),
      };
    });
    return { rooms };
  }

  /**
   * The spendable seat balance changed outside watching (a Call in took it, a
   * seat or a Holler gave some back): tell the open pages that hold it, so the
   * page shows the server's balance. Read-only; moves nothing.
   */
  function pushBalance(roomId, wallet) {
    if (!roomId || !wallet) return;
    const w = String(wallet).toLowerCase();
    for (const [ws, state] of sessions.entries()) {
      if (state.roomId !== roomId) continue;
      const accountId = state.identity?.accountId || null;
      const holder = state.payee || (accountId ? (state.demo ? demoWalletFor(accountId) : payoutWalletFor(accountId)) : null);
      if (!holder || String(holder).toLowerCase() !== w) continue;
      const c = getCredit(roomId, holder);
      send(ws, { type: 'rewards_balance', roomId, joinBalance: formatRewardAmount(c.atomic, c.decimals ?? 6), ...(state.demo ? { demo: true } : {}) });
    }
  }

  return {
    summaryFor,
    pushBalance,
    /** Seconds this wallet has watched this room (visible tab + registered). */
    getWatchSeconds(roomId, wallet) {
      if (!roomId || !wallet) return 0;
      return watchSeconds.get(`${roomId}:${String(wallet).toLowerCase()}`) || 0;
    },
    handleMessage,
  };
}

