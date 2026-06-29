// ─── Optional rewards primitive (isolated — never breaks pay-to-join) ────────
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { creditViewer, parseRewardAmount, formatRewardAmount, getCredit } from './reward-credits.js';
import { toAtomic } from './token-utils.js';

function usdcToAtomic(amountStr) {
  return toAtomic(amountStr, 6);
}
function atomicToUsdc(atomic) {
  return formatRewardAmount(atomic, 6);
}

/**
 * @param {import('ws').WebSocketServer} wss
 * @param {object} opts
 * @param {Function} opts.getRoomConfig — (roomId) => room config or null
 * @param {string} [opts.poolPrivateKey]
 * @param {string} [opts.rpcUrl]
 */
export function attachRewards(wss, opts = {}) {
  const getRoomConfig = opts.getRoomConfig || (() => null);
  const RPC_URL = opts.rpcUrl || 'https://rpc.testnet.arc.network';

  let gatewayClient = null;
  let poolDryRun = true;
  if (opts.poolPrivateKey && /^0x[0-9a-fA-F]{64}$/.test(opts.poolPrivateKey)) {
    try {
      gatewayClient = new GatewayClient({
        chain: 'arcTestnet',
        privateKey: opts.poolPrivateKey,
        rpcUrl: RPC_URL,
      });
      poolDryRun = false;
    } catch (err) {
      console.warn('[rewards] pool client init failed — credits accrue locally only:', err.message);
    }
  } else {
    console.warn('[rewards] REWARD_POOL_PRIVATE_KEY not set — local credit mode (join balance still works).');
  }

  const sessions = new Map();

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

  function earnAtomicForRoom(roomCfg) {
    const rw = roomCfg.rewards;
    const meta = rewardMeta(roomCfg);
    return parseRewardAmount(rw.earnAmount, meta.decimals);
  }

  function capAtomicForRoom(roomCfg) {
    const rw = roomCfg.rewards;
    const meta = rewardMeta(roomCfg);
    return parseRewardAmount(rw.earnCap, meta.decimals);
  }

  async function creditViewerSession(ws, state) {
    if (state.crediting || !state.wallet || !state.roomId) return;
    const roomCfg = getRoomConfig(state.roomId);
    if (!roomCfg?.rewards?.enabled) return;

    const earnAtomic = earnAtomicForRoom(roomCfg);
    const capAtomic = capAtomicForRoom(roomCfg);
    const meta = rewardMeta(roomCfg);

    if (state.sessionEarned >= capAtomic) {
      send(ws, {
        type: 'rewards_earned',
        wallet: state.wallet,
        roomId: state.roomId,
        earnedSession: formatRewardAmount(state.sessionEarned, meta.decimals),
        symbol: meta.symbol,
        capped: true,
        dryRun: poolDryRun,
      });
      return;
    }

    let amountAtomic = earnAtomic;
    if (state.sessionEarned + amountAtomic > capAtomic) {
      amountAtomic = capAtomic - state.sessionEarned;
    }
    if (amountAtomic <= 0n) return;

    state.crediting = true;
    let txHash = null;
    try {
      if (meta.type === 'usdc' && gatewayClient && !poolDryRun) {
        const result = await gatewayClient.depositFor(
          formatRewardAmount(amountAtomic, 6),
          state.wallet
        );
        txHash = result.depositTxHash || null;
      }
      creditViewer(state.roomId, state.wallet, amountAtomic, meta);
      state.sessionEarned += amountAtomic;
      const bal = getCredit(state.roomId, state.wallet);
      send(ws, {
        type: 'rewards_earned',
        wallet: state.wallet,
        roomId: state.roomId,
        credited: formatRewardAmount(amountAtomic, meta.decimals),
        earnedSession: formatRewardAmount(state.sessionEarned, meta.decimals),
        joinBalance: formatRewardAmount(bal.atomic, meta.decimals),
        symbol: meta.symbol,
        txHash,
        capped: state.sessionEarned >= capAtomic,
        dryRun: poolDryRun || meta.type !== 'usdc',
      });
      console.log(
        `[rewards] room ${state.roomId} credited ${formatRewardAmount(amountAtomic, meta.decimals)} ${meta.symbol} → ${state.wallet}`
      );
    } catch (err) {
      creditViewer(state.roomId, state.wallet, amountAtomic, meta);
      state.sessionEarned += amountAtomic;
      send(ws, {
        type: 'rewards_earned',
        wallet: state.wallet,
        roomId: state.roomId,
        credited: formatRewardAmount(amountAtomic, meta.decimals),
        earnedSession: formatRewardAmount(state.sessionEarned, meta.decimals),
        symbol: meta.symbol,
        dryRun: true,
        note: 'local credit (pool payout failed)',
      });
    } finally {
      state.crediting = false;
    }
  }

  const ticker = setInterval(() => {
    for (const [ws, state] of sessions.entries()) {
      if (!state.wallet || !state.visible || !state.roomId) continue;
      const roomCfg = getRoomConfig(state.roomId);
      if (!roomCfg?.rewards?.enabled) continue;
      const intervalSec = roomCfg.rewards.earnInterval || 60;
      state.accruedMs += 1000;
      if (state.accruedMs >= intervalSec * 1000) {
        state.accruedMs -= intervalSec * 1000;
        creditViewerSession(ws, state).catch((e) =>
          console.warn('[rewards] credit error:', e.message)
        );
      }
    }
  }, 1000);
  if (typeof ticker.unref === 'function') ticker.unref();

  wss.on('connection', (ws) => {
    sessions.set(ws, {
      wallet: null,
      roomId: null,
      visible: true,
      accruedMs: 0,
      sessionEarned: 0n,
      crediting: false,
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const state = sessions.get(ws);
      if (!state) return;

      switch (msg.type) {
        case 'rewards_register': {
          if (typeof msg.wallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(msg.wallet)) {
            state.wallet = msg.wallet;
            state.roomId = typeof msg.roomId === 'string' ? msg.roomId : null;
            state.accruedMs = 0;
            state.sessionEarned = 0n;
          }
          const roomCfg = state.roomId ? getRoomConfig(state.roomId) : null;
          const rw = roomCfg?.rewards;
          send(ws, {
            type: 'rewards_config',
            roomId: state.roomId,
            enabled: !!(rw && rw.enabled),
            earnInterval: rw?.earnInterval ?? 60,
            earnAmount: rw?.earnAmount ?? '0.1',
            earnCap: rw?.earnCap ?? '5',
            rewardType: rw?.rewardType ?? 'usdc',
            dryRun: poolDryRun,
          });
          if (state.wallet && state.roomId) {
            const meta = roomCfg ? rewardMeta(roomCfg) : { symbol: 'USDC', decimals: 6 };
            const bal = getCredit(state.roomId, state.wallet);
            send(ws, {
              type: 'rewards_earned',
              wallet: state.wallet,
              roomId: state.roomId,
              earnedSession: formatRewardAmount(bal.atomic, meta.decimals),
              joinBalance: formatRewardAmount(bal.atomic, meta.decimals),
              symbol: meta.symbol,
              dryRun: poolDryRun,
            });
          }
          break;
        }
        case 'rewards_visibility':
          state.visible = !!msg.visible;
          break;
        default:
          break;
      }
    });

    ws.on('close', () => sessions.delete(ws));
  });

  console.log('[rewards] optional per-room rewards attached' + (poolDryRun ? ' [local/dry-run credits]' : ''));
}

export { getCredit, consumeCredit, formatRewardAmount } from './reward-credits.js';
