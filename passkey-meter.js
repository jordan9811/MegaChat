/**
 * Passkey per-second stream meter helpers (Phase 2).
 * Exported for automated gate tests — not used by MetaMask/Gateway seats.
 */

/** Apply one local stream tick (balance tracking). Returns false if out of funds. */
export function applyStreamTick(seat, tickPriceAtomic) {
  if (!seat || tickPriceAtomic <= 0n) return false;
  if (seat.remainingAtomic < tickPriceAtomic) return false;
  seat.remainingAtomic -= tickPriceAtomic;
  seat.spentAtomic = (seat.spentAtomic ?? 0n) + tickPriceAtomic;
  return true;
}

export function streamSecondsLeft(seat, tickPriceAtomic, tickSeconds) {
  if (!seat || tickPriceAtomic <= 0n) return 0;
  const ticks = Number(seat.remainingAtomic / tickPriceAtomic);
  return ticks * tickSeconds;
}

export function streamMeterPayload(seat, tickPriceAtomic, tickSeconds) {
  const secondsLeft = streamSecondsLeft(seat, tickPriceAtomic, tickSeconds);
  return {
    seatId: seat.id,
    remaining: formatAtomic(seat.remainingAtomic),
    spent: formatAtomic(seat.spentAtomic ?? 0n),
    secondsLeft,
    minutesLeft: Math.floor(secondsLeft / 60),
    mode: 'passkey_stream',
  };
}

function formatAtomic(atomic) {
  const v = BigInt(atomic);
  const whole = v / 1000000n;
  const frac = (v % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Dry-run gate: tick until broke, return tick count. */
export function simulateStreamUntilEmpty(sessionCapAtomic, tickPriceAtomic) {
  const seat = {
    id: 'sim',
    remainingAtomic: sessionCapAtomic,
    spentAtomic: 0n,
    paymentMode: 'passkey_stream',
  };
  let ticks = 0;
  while (applyStreamTick(seat, tickPriceAtomic)) ticks++;
  return { ticks, seat, outOfFunds: seat.remainingAtomic < tickPriceAtomic };
}
