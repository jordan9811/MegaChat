/**
 * Per-room viewer reward credits — isolated from pay-to-join core.
 * Earned balance credits the same pool the join meter draws from.
 */
import { toAtomic, fromAtomic } from './token-utils.js';

const store = new Map();

function key(roomId, wallet) {
  return `${roomId}:${wallet.toLowerCase()}`;
}

/** @returns {{ atomic: bigint, type: string, symbol: string, decimals: number }} */
export function getCredit(roomId, wallet) {
  if (!roomId || !wallet) return { atomic: 0n, type: 'usdc', symbol: 'USDC', decimals: 6 };
  const rec = store.get(key(roomId, wallet));
  if (!rec) return { atomic: 0n, type: 'usdc', symbol: 'USDC', decimals: 6 };
  return rec;
}

export function creditViewer(roomId, wallet, amountAtomic, meta = {}) {
  if (!roomId || !wallet || amountAtomic <= 0n) return getCredit(roomId, wallet);
  const k = key(roomId, wallet);
  const prev = store.get(k) || {
    atomic: 0n,
    type: meta.type || 'usdc',
    symbol: meta.symbol || 'USDC',
    decimals: meta.decimals ?? 6,
  };
  prev.atomic += BigInt(amountAtomic);
  prev.type = meta.type || prev.type;
  prev.symbol = meta.symbol || prev.symbol;
  prev.decimals = meta.decimals ?? prev.decimals;
  store.set(k, prev);
  console.log(
    `[rewards:credit] room ${roomId} ${wallet.slice(0, 8)}… +${fromAtomic(amountAtomic, prev.decimals)} ${prev.symbol}`
  );
  return prev;
}

export function consumeCredit(roomId, wallet, amountAtomic) {
  const k = key(roomId, wallet);
  const rec = store.get(k);
  if (!rec || amountAtomic <= 0n) return 0n;
  const use = rec.atomic >= amountAtomic ? amountAtomic : rec.atomic;
  rec.atomic -= use;
  if (rec.atomic <= 0n) store.delete(k);
  else store.set(k, rec);
  return use;
}

export function parseRewardAmount(amountStr, decimals) {
  return toAtomic(amountStr, decimals);
}

export function formatRewardAmount(atomic, decimals) {
  return fromAtomic(atomic, decimals);
}

export function _resetCreditsForTests() {
  store.clear();
}
