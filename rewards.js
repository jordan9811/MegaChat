// ─── Pass C: Watch-to-earn (fully isolated module) ───────────────────────────
//
// Viewers earn testnet USDC for time spent CONNECTED + FOCUSED on this site
// (measured purely by the WebSocket session + Page Visibility API, so it works
// even when the actual stream is on Twitch/Kick/Zora). Earnings are credited
// straight into the viewer's Circle Gateway balance from a pre-funded pool
// wallet via `GatewayClient.depositFor(amount, viewer)`, which makes them
// immediately spendable through the Pass B meter.
//
// EVERYTHING watch-to-earn lives in this module. It attaches its own WebSocket
// listeners and never touches the Pass A / Pass B code paths, so if rewards
// fail to initialise (e.g. no pool key) the core app keeps working untouched.

import { GatewayClient } from '@circle-fin/x402-batching/client';

function usdcToAtomic(amountStr) {
  const [whole, frac = ''] = String(amountStr).split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  return BigInt(whole || '0') * 1000000n + BigInt(fracPadded || '0');
}
function atomicToUsdc(atomic) {
  const v = BigInt(atomic);
  const whole = v / 1000000n;
  const frac = (v % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Attach watch-to-earn rewards to an existing WebSocketServer.
 *
 * @param {import('ws').WebSocketServer} wss
 * @param {object} opts
 * @param {number} [opts.earnInterval=60]  seconds of focused time per credit
 * @param {string} [opts.earnAmount="0.1"] USDC credited each interval
 * @param {string} [opts.earnCap="5"]      max USDC per wallet per session
 * @param {string} [opts.poolWallet]       reward pool wallet address (display)
 * @param {string} [opts.poolPrivateKey]   reward pool private key (payouts)
 * @param {string} [opts.rpcUrl]           Arc RPC url
 */
export function attachRewards(wss, opts = {}) {
  const EARN_INTERVAL = Number(opts.earnInterval || 60);
  const EARN_AMOUNT = String(opts.earnAmount || '0.1');
  const EARN_CAP = String(opts.earnCap || '5');
  const EARN_AMOUNT_ATOMIC = usdcToAtomic(EARN_AMOUNT);
  const EARN_CAP_ATOMIC = usdcToAtomic(EARN_CAP);
  const RPC_URL = opts.rpcUrl || 'https://rpc.testnet.arc.network';

  // Build the payout client only if a pool key is configured. Without it we run
  // in "dry-run" mode: the earn loop still runs and the UI still ticks up so the
  // loop is demonstrable, but no on-chain deposit is made.
  let gatewayClient = null;
  let dryRun = true;
  if (opts.poolPrivateKey && /^0x[0-9a-fA-F]{64}$/.test(opts.poolPrivateKey)) {
    try {
      gatewayClient = new GatewayClient({
        chain: 'arcTestnet',
        privateKey: opts.poolPrivateKey,
        rpcUrl: RPC_URL
      });
      dryRun = false;
    } catch (err) {
      console.warn('[rewards] payout client init failed, running dry-run:', err.message);
      gatewayClient = null;
      dryRun = true;
    }
  } else {
    console.warn('[rewards] REWARD_POOL_PRIVATE_KEY not set — running in dry-run mode (no on-chain payouts).');
  }

  // Per-connection session state.
  const sessions = new Map(); // ws -> { wallet, visible, accruedMs, earnedAtomic, crediting }

  function send(ws, msg) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  async function creditViewer(ws, state) {
    if (state.crediting) return;
    if (!state.wallet) return;
    if (state.earnedAtomic >= EARN_CAP_ATOMIC) {
      send(ws, {
        type: 'rewards_earned',
        wallet: state.wallet,
        earnedSession: atomicToUsdc(state.earnedAtomic),
        capped: true,
        dryRun
      });
      return;
    }

    // Clamp the credit so we never exceed the per-session cap.
    let amountAtomic = EARN_AMOUNT_ATOMIC;
    if (state.earnedAtomic + amountAtomic > EARN_CAP_ATOMIC) {
      amountAtomic = EARN_CAP_ATOMIC - state.earnedAtomic;
    }
    if (amountAtomic <= 0n) return;
    const amountStr = atomicToUsdc(amountAtomic);

    state.crediting = true;
    let txHash = null;
    try {
      if (gatewayClient) {
        const result = await gatewayClient.depositFor(amountStr, state.wallet);
        txHash = result.depositTxHash || null;
      }
      state.earnedAtomic += amountAtomic;
      send(ws, {
        type: 'rewards_earned',
        wallet: state.wallet,
        credited: amountStr,
        earnedSession: atomicToUsdc(state.earnedAtomic),
        txHash,
        capped: state.earnedAtomic >= EARN_CAP_ATOMIC,
        dryRun
      });
      console.log(`[rewards] credited ${amountStr} USDC to ${state.wallet}` +
        (txHash ? ` (tx ${txHash})` : ' (dry-run)'));
    } catch (err) {
      console.warn(`[rewards] payout to ${state.wallet} failed:`, err.message);
      send(ws, { type: 'rewards_error', wallet: state.wallet, message: err.message });
    } finally {
      state.crediting = false;
    }
  }

  // One shared 1s ticker accrues focused time and triggers credits.
  const ticker = setInterval(() => {
    for (const [ws, state] of sessions.entries()) {
      if (!state.wallet || !state.visible) continue;
      state.accruedMs += 1000;
      if (state.accruedMs >= EARN_INTERVAL * 1000) {
        state.accruedMs -= EARN_INTERVAL * 1000;
        // Fire and forget; creditViewer guards against overlap.
        creditViewer(ws, state);
      }
    }
  }, 1000);
  if (typeof ticker.unref === 'function') ticker.unref();

  // Attach our OWN connection listener (additive — does not affect A/B).
  wss.on('connection', (ws) => {
    sessions.set(ws, {
      wallet: null,
      visible: true,
      accruedMs: 0,
      earnedAtomic: 0n,
      crediting: false
    });

    send(ws, {
      type: 'rewards_config',
      earnInterval: EARN_INTERVAL,
      earnAmount: EARN_AMOUNT,
      earnCap: EARN_CAP,
      poolWallet: opts.poolWallet || null,
      dryRun
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const state = sessions.get(ws);
      if (!state) return;

      switch (msg.type) {
        case 'rewards_register':
          if (typeof msg.wallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(msg.wallet)) {
            state.wallet = msg.wallet;
            state.accruedMs = 0;
            send(ws, {
              type: 'rewards_earned',
              wallet: state.wallet,
              earnedSession: atomicToUsdc(state.earnedAtomic),
              dryRun
            });
          }
          break;
        case 'rewards_visibility':
          state.visible = !!msg.visible;
          break;
        default:
          break; // ignore A/B messages
      }
    });

    ws.on('close', () => {
      sessions.delete(ws);
    });
  });

  console.log(`[rewards] watch-to-earn active: ${EARN_AMOUNT} USDC / ${EARN_INTERVAL}s ` +
    `(cap ${EARN_CAP} USDC/session)` + (dryRun ? ' [DRY-RUN]' : ''));
}
