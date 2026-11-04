/**
 * CREATOR BOUNTY — the settlement facade.
 *
 * Every bounty module that owes someone money calls `settlement.release` or
 * `settlement.refund` on the object exported here. What answers depends on
 * the server's mode, and this file holds no key in either:
 *
 *   ledger-only (BOUNTY_FUNDING unset — what shipped before 2026-11-04):
 *     StubSettlement. Records the intent in memory, moves nothing, always
 *     succeeds. Every amount on /bounty is a ledger figure that pays nobody.
 *
 *   real money (BOUNTY_FUNDING=1): bounty-money.js, installed at boot with
 *     setBountySettlement. It resolves who gets paid (the fan's funding
 *     wallet for a refund, the verified owner's payout wallet for a release),
 *     converts the ledger's dollar figure to atomic units, and records an
 *     INTENT on the app's one money door (settlement.js), which pays it with
 *     PLATFORM_SETTLEMENT_KEY. The pull that funds a pledge goes through the
 *     same door's `pull` by the dedicated bounty spender.
 *
 * Gate H (LEGACY) and _gate-bounty-claim.mjs (H) both read this file: it
 * must keep naming the stub and the setter, and must import no signer.
 */

/**
 * @typedef {Object} SettlementIntent
 * @property {'release'|'refund'} kind
 * @property {string|null} to        recipient (claimant or contributor)
 * @property {string} amount
 * @property {string} bucket         'contributor' | 'platform_match'
 * @property {string} ref            originating ledger row id
 * @property {number} at
 */

/** The contract both implementations satisfy. */
export class SettlementInterface {
  /** @param {{to:string|null, amount:string, bucket:string, ref:string}} _ */
  release(_) { throw new Error('not implemented'); }
  /** @param {{to:string, amount:string, ref:string}} _ */
  refund(_) { throw new Error('not implemented'); }
  /** Everything owed and not yet paid, for the admin view. */
  pending() { return []; }
  get mode() { return 'unknown'; }
}

/**
 * Records intent, moves nothing, always succeeds. The ledger-only
 * implementation, and the only one when BOUNTY_FUNDING is unset.
 */
export class StubSettlement extends SettlementInterface {
  constructor({ log = console } = {}) {
    super();
    /** @type {SettlementIntent[]} */
    this.intents = [];
    this.log = log;
  }

  get mode() { return 'ledger-only'; }

  release({ to, amount, bucket, ref }) {
    const intent = { kind: 'release', to: to || null, amount: String(amount), bucket, ref, at: Date.now() };
    this.intents.push(intent);
    this.log.log(`[bounty-settlement] STUB release intent — ${amount} (${bucket}) → ${to || 'unassigned'} [ref ${ref}] — NO FUNDS MOVED`);
    return { ok: true, stubbed: true, intent };
  }

  refund({ to, amount, ref }) {
    const intent = { kind: 'refund', to, amount: String(amount), bucket: 'contributor', ref, at: Date.now() };
    this.intents.push(intent);
    this.log.log(`[bounty-settlement] STUB refund intent — ${amount} → ${to} [ref ${ref}] — NO FUNDS MOVED`);
    return { ok: true, stubbed: true, intent };
  }

  /** Everything that would have been paid, for the admin view. */
  pending() {
    return [...this.intents];
  }
}

/**
 * The one object every call site holds. Delegates to the installed
 * implementation, so swapping the stub for the door adapter at boot changes
 * no caller.
 */
class SettlementFacade extends SettlementInterface {
  constructor() {
    super();
    this.impl = new StubSettlement();
  }
  get mode() { return this.impl.mode; }
  release(args) { return this.impl.release(args); }
  refund(args) { return this.impl.refund(args); }
  pending() { return this.impl.pending(); }
}

export const settlement = new SettlementFacade();

/**
 * Install the real implementation (bounty-money.js) — or, with null, go back
 * to the stub. server.js calls this once at boot when BOUNTY_FUNDING=1.
 */
export function setBountySettlement(impl) {
  settlement.impl = impl || new StubSettlement();
  return settlement;
}

export default settlement;
