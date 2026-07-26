/**
 * CREATOR BOUNTY — settlement interface.
 *
 * ⚠⚠ RUN A SHIPS ONLY THE STUB. NO FUNDS MOVE. ⚠⚠
 *
 * MegaChat is live on Tempo mainnet. A stray settlement path is the single
 * worst thing this feature could ship, so real settlement is deliberately
 * ABSENT rather than written-but-disabled: there is no signer, no contract
 * call, no transfer, and no code path that could become one by flipping a
 * boolean. Run B implements `RealSettlement` against this interface.
 *
 * The stub's job is to record INTENT precisely enough that Run B can replay
 * it: who would have been paid, how much, from which bucket, against which
 * ledger row.
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

/**
 * The contract Run B must satisfy.
 * TODO(run-b): implement RealSettlement — needs a funded operator wallet,
 * the escrow contract address, and an idempotent on-chain submit path keyed
 * off the ledger row id so a retry cannot double-pay.
 */
export class SettlementInterface {
  /** @param {{to:string|null, amount:string, bucket:string, ref:string}} _ */
  release(_) { throw new Error('not implemented'); }
  /** @param {{to:string, amount:string, ref:string}} _ */
  refund(_) { throw new Error('not implemented'); }
}

/**
 * Records intent, moves nothing, always succeeds. This is the ONLY
 * implementation that exists in Run A.
 */
export class StubSettlement extends SettlementInterface {
  constructor({ log = console } = {}) {
    super();
    /** @type {SettlementIntent[]} */
    this.intents = [];
    this.log = log;
  }

  release({ to, amount, bucket, ref }) {
    // TODO(run-b): real transfer. Intentionally does nothing on chain.
    const intent = { kind: 'release', to: to || null, amount: String(amount), bucket, ref, at: Date.now() };
    this.intents.push(intent);
    this.log.log(`[bounty-settlement] STUB release intent — ${amount} (${bucket}) → ${to || 'unassigned'} [ref ${ref}] — NO FUNDS MOVED`);
    return { ok: true, stubbed: true, intent };
  }

  refund({ to, amount, ref }) {
    // TODO(run-b): real refund. Intentionally does nothing on chain.
    const intent = { kind: 'refund', to, amount: String(amount), bucket: 'contributor', ref, at: Date.now() };
    this.intents.push(intent);
    this.log.log(`[bounty-settlement] STUB refund intent — ${amount} → ${to} [ref ${ref}] — NO FUNDS MOVED`);
    return { ok: true, stubbed: true, intent };
  }

  /** Everything that would have been paid, for the admin view and Run B. */
  pending() {
    return [...this.intents];
  }
}

export const settlement = new StubSettlement();
export default settlement;
