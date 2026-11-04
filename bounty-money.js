/**
 * CREATOR BOUNTY — real money (2026-11-04, BOUNTY_FUNDING=1).
 *
 * The bounty feature's one connection to the chain, and it holds no key: every
 * write below is a call on the app's money door (settlement.js) — `pull` to
 * fund a pledge, `release` and `refund` to record what is owed — and Gate H
 * (LEGACY) proves this file names no signing primitive. It is the campaign
 * money pattern (campaign-engine.js) applied to pledges:
 *
 *   fund    A pledge is UNFUNDED until the fan's wallet (1) approves exactly
 *           the pledge amount to the DEDICATED bounty spender
 *           (BOUNTY_SPENDER_KEY, door slot `bountyPull`, never the seat or
 *           campaign spender) and (2) signs an EIP-712 Pledge message naming
 *           this pledge, this wallet, the token and the amount, with a
 *           deadline under ten minutes. Then door.pull moves the amount into
 *           the platform wallet. ONLY a SUCCESS receipt whose own Transfer
 *           logs show the amount arrive makes the pledge OPEN
 *           (bounty-escrow.js markPledgeFunded); until then it counts in no
 *           pool and can take no clip. A pull that threw before anything was
 *           signed puts the pledge back to unfunded (the fan retries); one
 *           that may have reached the node leaves it `funding_pending` for
 *           the receipt, never re-sent, never charged twice.
 *   release A RELEASE row on the bounty ledger (verified airtime) becomes a
 *           door intent to the verified owner's PAYOUT WALLET (accounts.js,
 *           the same wallet campaigns pay). No wallet yet → the row is OWED
 *           and paid the moment one is set (payOwed / payAccount). The
 *           contributor bucket is capped by what was actually funded for the
 *           handle, read from the door, however the pool arithmetic came out.
 *   refund  A REFUND row becomes a door intent back to the wallet that FUNDED
 *           the contribution. Money that never came in (a ledger-only or
 *           seeded contribution) has no funding wallet and pays nobody.
 *
 * Amounts: the bounty ledger keeps dollars at six places; the door takes
 * atomic units of the bounty token (USDC, 6 decimals). Refs on the door:
 * `bounty:fund:<pledgeId>:<attempt>`, `bounty:release:<ledgerRowId>`,
 * `bounty:refund:<contributionId>` — idempotent there, so every retry here is
 * at most one transfer.
 */
import { hashTypedData, verifyTypedData as verifyTypedDataEoa } from 'viem';
import { bountyConfig } from './bounty-claim.config.js';
import * as store from './bounty-store.js';
import * as escrow from './bounty-escrow.js';
import * as clips from './bounty-clips.js';
import { SettlementInterface } from './bounty-settlement.js';
import { getAccount } from './accounts.js';
import { transferredInReceipt, provablyPreSend } from './campaign-engine.js';
import { toAtomic, fromAtomic, sameAddress as sameAddr, isEvmAddress as isAddr, isTxHash } from './token-utils.js';

export const PLEDGE_SIGNATURE_MAX_SECS = 600;
/** A funding attempt with no transaction on record is resolved after this long (sweep or admin). */
export const STUCK_FUNDING_MS = 30 * 60_000;
export const PLEDGE_TYPES = {
  Pledge: [
    { name: 'pledgeId', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amountAtomic', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};
const pledgeDomain = (chainId) => ({ name: 'Holler Bounties', version: '1', chainId: Number(chainId) });
export function pledgeTypedData({ chainId, pledgeId, wallet, token, amountAtomic, deadline }) {
  return {
    domain: pledgeDomain(chainId),
    types: PLEDGE_TYPES, primaryType: 'Pledge',
    message: { pledgeId: String(pledgeId), wallet, token, amountAtomic: BigInt(amountAtomic), deadline: BigInt(deadline) },
  };
}
export const PAID_OFF_MSG = 'Paid pledges aren’t open on this server yet. Nothing was charged.';

const big = (v) => BigInt(v ?? 0);
const sameHash = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
function fail(code, message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { code, status, ...extra });
}

export function bountyFundingEnabled() { return bountyConfig.fundingEnabled; }

/**
 * @param {object} o
 * @param {object} o.door             settlement.js createSettlement(): pull / release / refund / status / intentsFor / hasSigner
 * @param {object} o.token            the bounty token {address, decimals, symbol}
 * @param {string} o.platformAddress  the platform wallet pledges are pulled INTO (pays releases and refunds)
 * @param {string|null} o.spender     the bounty spender's address (what a fan approves), null when unset
 */
export function createBountyMoney({
  door,
  token,
  platformAddress,
  spender = null,
  pullSigner = 'bountyPull',
  chainId = 4217,
  readAllowance = async () => 0n,
  readApproval = async () => null,
  confirmTx = async () => null,
  verifyPledgeSignature = (args) => verifyTypedDataEoa(args),
  findFundingTransfer = null,
  readSpenderNonce = null,
  txKnown = null,
  payoutWalletFor = (accountId) => (accountId ? getAccount(accountId)?.payoutWallet || null : null),
  now = () => Date.now(),
  log = console,
} = {}) {
  if (!door) throw new Error('createBountyMoney needs the settlement door');
  if (!token?.address || token.decimals == null) throw new Error('createBountyMoney needs the bounty token');
  if (!isAddr(platformAddress)) throw new Error('createBountyMoney needs the platform wallet address');

  const funding = new Set();      // in-process lock: a fund() is between its first and last await
  const reconciling = new Set();  // a sync-started reconcile is awaiting a receipt
  const atomicOf = (amount) => toAtomic(String(amount), token.decimals);
  const fundRef = (pledgeId, attempt) => `bounty:fund:${pledgeId}:${attempt}`;
  const releaseRef = (rowId) => `bounty:release:${rowId}`;
  const refundRef = (contributionId) => `bounty:refund:${contributionId}`;

  // ── who gets paid ─────────────────────────────────────────────────────────
  /** The wallet that FUNDED a contribution (its pledge's confirmed pull), walking a forfeit back to its origin. */
  function fundingWalletFor(contributionId, depth = 0) {
    const c = store.getContribution(contributionId);
    if (!c || depth > 3) return null;
    if (c.pledgeId) {
      const p = store.getPledge(c.pledgeId);
      if (p?.funding?.state === 'confirmed' && isAddr(p.funding.wallet)) return p.funding.wallet;
    }
    if (c.forfeitOfClip) {
      const clip = clips.getClipRecord(c.forfeitOfClip);
      if (clip?.contributionId && clip.contributionId !== contributionId) return fundingWalletFor(clip.contributionId, depth + 1);
    }
    return null;
  }
  /** What was CONFIRMED funded for a handle, in atomic units: the cap on everything the pool pays out. */
  function fundedAtomicFor(handleKey) {
    let sum = 0n;
    for (const c of store.listContributions(handleKey)) {
      if (c.forfeitOfClip || !store.moneyCameIn(c)) continue;
      if (!fundingWalletFor(c.id)) continue; // ledger-only or seeded: nothing came in
      sum += atomicOf(c.amount);
    }
    return sum;
  }
  /** Σ of the door's bounty intents for a handle under a ref prefix (first row's amount, so RETAINED rows count too). */
  function doorSum(handleKey, prefix, { ledgerBucket = null } = {}) {
    let sum = 0n;
    for (const rec of door.intentsFor(prefix)) {
      const row = rec.rows?.[0] || rec;
      if (row.meta?.handleKey !== handleKey) continue;
      // The bounty ledger's bucket rides as meta.ledgerBucket: the door writes
      // its own `bucket` into meta, so the name must differ.
      if (ledgerBucket && row.meta?.ledgerBucket !== ledgerBucket) continue;
      sum += big(row.amountAtomic);
    }
    return sum;
  }

  // ── the SettlementInterface: what bounty-escrow.js calls ──────────────────
  function release({ amount, bucket = 'contributor', ref, ledgerRowId = null, handleKey = null, claimId = null, airSessionId = null, payeeAccount = null, to = null, tier = 'green' }) {
    const rowId = ledgerRowId || ref;
    const amountAtomic = atomicOf(amount);
    const doorRef = releaseRef(rowId);
    const already = door.status(doorRef);
    if (already) return { ok: true, deduped: true, ref: doorRef, status: already.status };
    if (bucket === 'contributor' && handleKey) {
      // Belt and braces over the pool arithmetic: contributor money out
      // (releases + refunds already on the door) never exceeds what was
      // confirmed in. The platform match is platform money, not pool money.
      const out = doorSum(handleKey, 'bounty:release:', { ledgerBucket: 'contributor' }) + doorSum(handleKey, 'bounty:refund:');
      const funded = fundedAtomicFor(handleKey);
      if (out + amountAtomic > funded) {
        log.error?.(`[bounty-money] REFUSED release ${doorRef} for ${handleKey}: ${fromAtomic(out + amountAtomic, token.decimals)} out would exceed ${fromAtomic(funded, token.decimals)} funded — a person looks`);
        return { ok: false, refused: 'exceeds_funded', ref: doorRef };
      }
    }
    const wallet = payoutWalletFor(payeeAccount);
    if (!isAddr(wallet)) {
      // OWED: the RELEASE row on the bounty ledger stands; payOwed records the
      // intent the moment the owner sets a payout wallet (account page).
      log.log?.(`[bounty-money] release ${doorRef}: ${amount} ${token.symbol} owed to ${payeeAccount || to || 'the claimant'} — no payout wallet yet`);
      return { ok: true, owed: true, ref: doorRef };
    }
    const r = door.release({ signer: 'platform', to: wallet, token, amountAtomic: amountAtomic.toString(), bucket: bucket === 'platform_match' ? 'bounty-match' : 'bounty', ref: doorRef, meta: { handleKey, claimId, airSessionId, rowId, payeeAccount, ledgerBucket: bucket, tier } });
    log.log?.(`[bounty-money] release intent ${doorRef}: ${amount} ${token.symbol} (${bucket}) → ${wallet} [${r.status}]`);
    return { ok: true, ref: doorRef, status: r.status, deduped: !!r.deduped, retained: !!r.retained };
  }

  function refund({ amount, ref, contributionId = null, pledgeId = null, handleKey = null, reason = null, ledgerRowId = null }) {
    const cid = contributionId || ref;
    const doorRef = refundRef(cid);
    const already = door.status(doorRef);
    if (already) return { ok: true, deduped: true, ref: doorRef, status: already.status };
    const wallet = fundingWalletFor(cid);
    if (!isAddr(wallet)) {
      // Nothing came in for this contribution (ledger-only or seeded money):
      // there is nothing to send back, and nobody to send it to.
      log.warn?.(`[bounty-money] refund ${doorRef}: contribution ${cid} has no funding wallet (ledger-only money) — nothing to pay`);
      return { ok: false, retained: true, why: 'no funding wallet', ref: doorRef };
    }
    const amountAtomic = atomicOf(amount);
    const r = door.refund({ signer: 'platform', to: wallet, token, amountAtomic: amountAtomic.toString(), ref: doorRef, meta: { handleKey, contributionId: cid, pledgeId, reason, rowId: ledgerRowId } });
    log.log?.(`[bounty-money] refund intent ${doorRef}: ${amount} ${token.symbol} → ${wallet} (${reason || 'refund'}) [${r.status}]`);
    return { ok: true, ref: doorRef, status: r.status, deduped: !!r.deduped, retained: !!r.retained };
  }

  /** Every bounty intent the door still holds unpaid, in the stub's shape (the admin view). */
  function pending() {
    return door.intentsFor('bounty:').filter((r) => r.status === 'PENDING').map((r) => ({
      kind: r.kind, to: r.to, amount: fromAtomic(big(r.amountAtomic), token.decimals), bucket: r.meta?.bucket || null, ref: r.ref, at: r.intendedAt,
    }));
  }

  /**
   * RELEASE rows with no door intent yet (the owner had no payout wallet when
   * airtime verified): record the intent now for every handle whose owner
   * has one. Idempotent on the door's ref.
   */
  function payOwed({ accountId = null } = {}) {
    let n = 0;
    for (const rec of store.listReservedHandles()) {
      if (!rec.claimedByAccount) continue;
      if (accountId && rec.claimedByAccount !== accountId) continue;
      const wallet = payoutWalletFor(rec.claimedByAccount);
      if (!isAddr(wallet)) continue;
      for (const row of store.listLedger({ handleKey: rec.key, type: 'RELEASE' })) {
        if (door.status(releaseRef(row.id))) continue;
        const r = release({ amount: row.amount, bucket: row.bucket, ref: row.id, ledgerRowId: row.id, handleKey: rec.key, claimId: row.claimId, airSessionId: row.airSessionId, payeeAccount: rec.claimedByAccount, tier: row.meta?.tier || 'green' });
        if (r.ok && !r.owed) n += 1;
      }
    }
    return n;
  }
  const payAccount = (accountId) => (accountId ? payOwed({ accountId }) : 0);

  // ── funding: the fan's allowance, pulled through the door ─────────────────
  function fundTerms(pledgeId, { accountId, isAdmin = false } = {}) {
    const p = store.getPledge(pledgeId);
    if (!p) throw fail('not_found', 'No such pledge.', 404);
    if (!isAdmin && p.contributor !== accountId) throw fail('forbidden', 'This is not your pledge.', 403);
    const amountAtomic = atomicOf(p.amount).toString();
    return {
      spender, token, amountAtomic, amount: p.amount, holder: platformAddress,
      fundingEnabled: bountyFundingEnabled(), pullSigner: !!spender && !!door.hasSigner?.(pullSigner),
      status: p.status, funding: p.funding || null,
      sign: { domain: pledgeDomain(chainId), types: PLEDGE_TYPES, primaryType: 'Pledge', message: { pledgeId: p.id, token: token.address, amountAtomic }, maxSeconds: PLEDGE_SIGNATURE_MAX_SECS },
    };
  }

  /** The funding ask a client answers with an approve and a signature (the pledge route's shape). */
  function needsApproval(pledgeId, who, extra = {}) {
    const t = fundTerms(pledgeId, who);
    return { token: { address: token.address, symbol: token.symbol, decimals: token.decimals }, spender: t.spender, holder: t.holder, amountAtomic: t.amountAtomic, sign: t.sign, holds: true, ...extra };
  }

  function anchorOf(p) { return p.targets?.[0] || store.getContribution(p.contributionId)?.handleKey || null; }
  const fundingBusy = (p) => funding.has(p.id) || (p.funding && (p.funding.state === 'pulling' || p.funding.state === 'pending'));
  /** Audit rows for funding live on the bounty ledger (amount 0: pool folds ignore them), append-only, never trimmed. */
  function audit(p, event, extra = {}) {
    store.appendLedger({ handleKey: anchorOf(p), type: 'FUNDING', amount: '0', bucket: 'contributor', actor: 'bounty-money', reason: event, meta: { pledgeId: p.id, contributionId: p.contributionId, event, ...extra } });
  }
  function fundingRows() { return store.listLedger({ type: 'FUNDING' }); }
  /** One approve funds one pledge; retrying the SAME pledge with it is fine (the signature is the one-time consent). */
  function approveTxUsedElsewhere(hash, pledgeId) {
    const h = String(hash).toLowerCase();
    if (fundingRows().some((r) => r.meta?.event === 'started' && r.meta?.pledgeId !== pledgeId && String(r.meta?.approveTx || '').toLowerCase() === h)) return true;
    return store.listPledges().some((x) => x.id !== pledgeId && (String(x.funding?.approveTx || '').toLowerCase() === h || (x.fundingFailures || []).some((f) => String(f.approveTx || '').toLowerCase() === h)));
  }
  /** One signed message funds at most one attempt, on any pledge. */
  function pledgeSigUsed(hash) {
    const h = String(hash).toLowerCase();
    if (fundingRows().some((r) => r.meta?.event === 'started' && String(r.meta?.fundSigHash || '').toLowerCase() === h)) return true;
    return store.listPledges().some((x) => String(x.funding?.fundSigHash || '').toLowerCase() === h || (x.fundingFailures || []).some((f) => String(f.fundSigHash || '').toLowerCase() === h));
  }

  /** Why an approve transaction does not prove this wallet funds this pledge, or null. */
  function approvalProblem(ap, { wallet, atomic, after }) {
    if (!ap) return 'it was not found on chain (or is not mined yet)';
    if (ap.status !== 'success') return 'it did not succeed on chain';
    if (!sameAddr(ap.from, wallet)) return 'it was not sent from the funding wallet';
    const toToken = sameAddr(ap.to, token.address) || (Array.isArray(ap.calls) && ap.calls.some((x) => sameAddr(x?.to, token.address)));
    if (!toToken) return 'it was not sent to the bounty token contract';
    if (!(Math.floor(Number(ap.timestampMs) / 1000) >= Math.floor(after / 1000))) return 'it was made before this pledge existed';
    const ok = (ap.approvals || []).some((l) => sameAddr(l.token, token.address) && sameAddr(l.owner, wallet) && sameAddr(l.spender, spender) && String(l.value) === String(atomic));
    if (!ok) return 'it does not approve exactly the pledge amount to the bounty spender from this wallet';
    return null;
  }

  /** Why `signature` is not this wallet's consent to fund THIS pledge, or {hash} when it is. */
  async function signatureProblem({ p, wallet, atomic, signature, typedData }) {
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(signature)) {
      return { problem: 'Sign the pledge message in your wallet after the approval: it shows this wallet means to fund this pledge. Nothing was charged.', code: 'signature_required', status: 402 };
    }
    const m = typedData?.message || {};
    const invalid = (problem) => ({ problem, code: 'signature_invalid', status: 403 });
    if (String(m.pledgeId ?? '') !== p.id) return invalid('it names a different pledge');
    if (!sameAddr(m.wallet, wallet)) return invalid('it names a different wallet');
    if (!sameAddr(m.token, token.address)) return invalid('it names a different token');
    if (String(m.amountAtomic ?? '') !== String(atomic)) return invalid('it names a different amount');
    const deadline = Number(m.deadline);
    const nowS = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(deadline) || deadline < nowS) return { ...invalid('it has expired; sign again'), code: 'signature_expired' };
    if (deadline > nowS + PLEDGE_SIGNATURE_MAX_SECS + 60) return invalid(`its deadline is more than ${PLEDGE_SIGNATURE_MAX_SECS / 60} minutes away`);
    const td = pledgeTypedData({ chainId, pledgeId: p.id, wallet, token: token.address, amountAtomic: atomic, deadline });
    let ok = false;
    try { ok = await verifyPledgeSignature({ address: wallet, ...td, signature }); }
    catch (e) { throw fail('signature_unreadable', `Could not check the signature (${e.shortMessage || e.message}). Nothing was charged.`, 502); }
    if (!ok) return invalid('it was not signed by the funding wallet');
    return { problem: null, hash: hashTypedData(td) };
  }

  function patchFunding(pledgeId, ref, patch) {
    const cur = store.getPledge(pledgeId);
    if (!cur?.funding || cur.funding.ref !== ref) return cur;
    return store.updatePledge(pledgeId, { funding: { ...cur.funding, ...patch } });
  }
  /** A pull that moved nothing (threw pre-send, ran dry, reverted): back to unfunded, the attempt on record; the fan may try again. */
  function backToUnfunded(pledgeId, ref, why) {
    const cur = store.getPledge(pledgeId);
    if (!cur?.funding || cur.funding.ref !== ref) return cur;
    const failure = { ref, txHash: cur.funding.txHash || null, approveTx: cur.funding.approveTx || null, fundSigHash: cur.funding.fundSigHash || null, why, at: new Date(now()).toISOString() };
    audit(cur, 'failed', { ref, txHash: failure.txHash, why });
    log.warn?.(`[bounty-money] pledge ${pledgeId}: funding ${ref} did not complete — ${why}`);
    return store.updatePledge(pledgeId, { funding: null, fundingFailures: [...(cur.fundingFailures || []), failure].slice(-10) });
  }
  function askPerson(pledgeId, ref, code, why, extra = {}) {
    const cur = store.getPledge(pledgeId);
    if (!cur?.funding || cur.funding.ref !== ref || cur.funding.needsPersonCode === code) return cur;
    audit(cur, 'unknown', { ref, code, why, ...extra });
    return patchFunding(pledgeId, ref, { needsPerson: why, needsPersonCode: code });
  }

  /**
   * Fund: validate the approve, the signature and the allowance, record the
   * attempt, pull through the door, then let the receipt decide. Mirrors
   * campaign-engine.js fund() rule for rule.
   */
  async function fund(pledgeId, { wallet, approveTx = null, signature = null, typedData = null } = {}, { accountId, isAdmin = false } = {}) {
    const p = store.getPledge(pledgeId);
    if (!p) throw fail('not_found', 'No such pledge.', 404);
    if (!isAdmin && p.contributor !== accountId) throw fail('forbidden', 'This is not your pledge.', 403);
    if (fundingBusy(p)) throw fail('funding_in_progress', 'This pledge is being funded. Wait for the chain to answer; do not approve again.', 409);
    if (p.status !== 'UNFUNDED') throw fail('already_funded', `This pledge is ${p.status === 'OPEN' ? 'already funded' : p.status.toLowerCase()}.`, 409);
    // A funding a person has to look at (short, unproven, a send nobody can
    // account for) is never retried by the fan: a retry could charge twice.
    if (p.funding && p.funding.needsPerson) throw fail('funding_needs_person', 'This pledge\'s funding is being checked by a person. Do not approve or fund again; nothing more is charged.', 409);
    if (!bountyFundingEnabled()) throw fail('funding_off', PAID_OFF_MSG, 503);
    if (!spender || !door.hasSigner?.(pullSigner)) throw fail('no_pull_signer', 'This server cannot take a pledge right now. Nothing was charged.', 503);
    if (!isAddr(wallet)) throw fail('invalid', 'Connect the wallet that approved the pledge.');
    if (!isTxHash(approveTx)) throw fail('approve_required', 'Approve the pledge amount from the funding wallet first: that approval is what shows the wallet is yours. Nothing was charged.', 402);
    funding.add(pledgeId);
    try {
      const need = atomicOf(p.amount);
      const atomic = need.toString();
      let ap;
      try { ap = await readApproval(approveTx); } catch (e) { throw fail('approve_unreadable', `Could not read the approval transaction on chain (${e.shortMessage || e.message}). Nothing was charged.`, 502); }
      const bad = approvalProblem(ap, { wallet, atomic, after: p.createdAt });
      if (bad) {
        audit(p, 'refused', { approveTx, from: wallet, why: bad });
        throw fail('approve_invalid', `That approval does not fund this pledge: ${bad}. Nothing was charged.`, 403);
      }
      const sig = await signatureProblem({ p, wallet, atomic, signature, typedData });
      if (sig.problem) {
        audit(p, 'refused', { approveTx, from: wallet, why: sig.problem });
        throw fail(sig.code, sig.code === 'signature_required' ? sig.problem : `That signature does not fund this pledge: ${sig.problem}. Nothing was charged.`, sig.status);
      }
      let allowance;
      try { allowance = big(await readAllowance(token.address, wallet)); } catch (e) { throw fail('allowance_unreadable', `Could not read the allowance on chain (${e.shortMessage || e.message}). Nothing was charged.`, 502); }
      if (allowance < need) throw fail('insufficient_allowance', `The wallet has approved ${fromAtomic(allowance, token.decimals)} ${token.symbol} to ${spender}; the pledge is ${p.amount}. Nothing was charged.`, 402, { allowance: allowance.toString() });
      // Re-read after the awaits: nothing may have changed.
      const cur = store.getPledge(pledgeId);
      if (!cur || cur.status !== 'UNFUNDED' || cur.funding || cur.amount !== p.amount) throw fail('terms_changed', 'The pledge changed while funding was starting. Nothing was charged; try again.', 409);
      if (approveTxUsedElsewhere(approveTx, pledgeId)) throw fail('approve_reused', 'That approval was already used to fund another pledge. Approve again for this one. Nothing was charged.', 409);
      if (pledgeSigUsed(sig.hash)) throw fail('signature_reused', 'That signature was already used. Sign again to fund this pledge. Nothing was charged.', 409);
      const attempt = (cur.fundingAttempts || 0) + 1;
      const ref = fundRef(pledgeId, attempt);
      const at = new Date(now()).toISOString();
      store.updatePledge(pledgeId, { fundingAttempts: attempt, funding: { state: 'pulling', wallet, ref, token: { address: token.address, decimals: token.decimals, symbol: token.symbol }, atomic, txHash: null, receipt: null, at, approveTx, fundSigHash: sig.hash, attempt } });
      audit(cur, 'started', { ref, atomic, from: wallet, fundSigHash: sig.hash, approveTx });
      let r;
      try { r = await door.pull({ from: wallet, to: platformAddress, token, amountAtomic: atomic, ref, signer: pullSigner, meta: { pledgeId, contributionId: cur.contributionId, approveTx } }); }
      catch (e) {
        const why = e.shortMessage || e.message;
        if (provablyPreSend(e)) { backToUnfunded(pledgeId, ref, `the pull was refused before sending: ${why}`); throw fail('pull_failed', `The pledge could not be collected (${why}). Nothing was sent; nothing was charged.`, 502); }
        const sentHash = door.status(ref)?.txHash || null;
        const note = sentHash ? `the pull threw after it was signed (${why}); its transaction ${sentHash} is on record and its receipt decides` : `the pull threw and may have been sent (${why}): check the wallet's transfers on chain`;
        if (sentHash) patchFunding(pledgeId, ref, { state: 'pending', txHash: sentHash });
        log.error?.(`[bounty-money] pledge ${pledgeId}: funding ${ref} — ${note}`);
        askPerson(pledgeId, ref, 'send_unknown', note, { txHash: sentHash });
        throw fail('pull_unconfirmed', 'The pledge transfer may have gone through; it is being checked on chain. Do not approve or fund again: this pledge stays locked until the chain answers or a person resolves it.', 502);
      }
      if (r.dry) { backToUnfunded(pledgeId, ref, 'the pull ran dry (no pull signer)'); throw fail('no_pull_signer', 'The pull ran dry: no pull signer. Nothing was charged.', 503); }
      patchFunding(pledgeId, ref, { state: 'pending', txHash: r.txHash || null });
      const rcpt = r.txHash ? await confirmTx(r.txHash) : null;
      const out = settleFunding(pledgeId, ref, rcpt, r.txHash);
      if (out.outcome === 'reverted') throw fail('pull_reverted', `The pledge transfer reverted on chain (${r.txHash}). Nothing was recorded as funded; try again.`, 502);
      if (out.outcome === 'short' || out.outcome === 'unproven') throw fail(`funding_${out.outcome}`, `${out.why}. The pledge is not funded and stays locked until a person resolves it. Do not approve or fund again.`, 502);
      return out.pledge;
    } finally {
      funding.delete(pledgeId);
    }
  }

  /**
   * The receipt decides — only THIS transaction's receipt, and only what its
   * own Transfer logs say moved (campaign-engine.js settleFunding, the same
   * table): no receipt → pending; reverted → unfunded; success with no
   * Transfer, or short → a person; success with the amount → OPEN, HELD.
   */
  function settleFunding(pledgeId, ref, rcpt, askedHash = null) {
    const cur = store.getPledge(pledgeId);
    if (!cur?.funding || cur.funding.ref !== ref || cur.status !== 'UNFUNDED') return { pledge: cur, outcome: 'stale' };
    const hash = askedHash || cur.funding.txHash;
    if (rcpt && !sameHash(rcpt.transactionHash, hash)) {
      audit(cur, 'receipt-foreign', { ref, txHash: hash, receiptHash: rcpt.transactionHash || null });
      log.error?.(`[bounty-money] pledge ${pledgeId}: funding ${ref} — the receipt answered for ${rcpt.transactionHash || 'no hash'}, not ${hash}: ignored`);
      rcpt = null;
    }
    if (!rcpt) {
      if (cur.funding.unconfirmedHash !== hash) {
        audit(cur, 'unconfirmed', { ref, txHash: hash });
        return { pledge: patchFunding(pledgeId, ref, { unconfirmedHash: hash }), outcome: 'pending' };
      }
      return { pledge: cur, outcome: 'pending' };
    }
    if (rcpt.status !== 'success') return { pledge: backToUnfunded(pledgeId, ref, `the pledge transfer reverted on chain (${hash})`), outcome: 'reverted' };
    const moved = transferredInReceipt(rcpt, { token: token.address, from: cur.funding.wallet, to: platformAddress });
    const want = big(cur.funding.atomic);
    if (moved == null || moved < want) {
      const why = moved == null
        ? `the funding transaction ${hash} succeeded but its logs show no ${token.symbol} Transfer from the funding wallet to the platform wallet`
        : `the funding transfer ${hash} delivered ${fromAtomic(moved, token.decimals)} ${token.symbol} of the ${fromAtomic(want, token.decimals)} pledge (short by ${fromAtomic(want - moved, token.decimals)})`;
      const outcome = moved == null ? 'unproven' : 'short';
      const p2 = askPerson(pledgeId, ref, outcome, why, { txHash: hash, receivedAtomic: moved == null ? '0' : moved.toString() });
      patchFunding(pledgeId, ref, { state: outcome, receivedAtomic: moved == null ? '0' : moved.toString(), txHash: hash });
      log.error?.(`[bounty-money] pledge ${pledgeId}: ${why} — not funded; needs a person`);
      return { pledge: p2, outcome, why };
    }
    const at = new Date(now()).toISOString();
    // Credited exactly the pledge amount: the pull asked for exactly that, and
    // more than it in the logs (impossible for a plain pull) is noted, not paid.
    if (moved > want) audit(cur, 'overpaid', { ref, txHash: hash, receivedAtomic: moved.toString(), creditedAtomic: want.toString() });
    const f = { ...cur.funding, state: 'confirmed', receipt: 'success', txHash: hash, receivedAtomic: moved.toString(), confirmedAt: at, needsPerson: null };
    const { pledge } = escrow.markPledgeFunded(pledgeId, { funding: f, actor: cur.contributor });
    audit(pledge, 'funded', { ref, txHash: hash, atomic: want.toString(), from: f.wallet });
    log.log?.(`[bounty-money] pledge ${pledgeId} funded ${fromAtomic(want, token.decimals)} ${token.symbol} (${ref}, tx ${hash})`);
    return { pledge, outcome: 'funded' };
  }

  /**
   * A signed pull whose nonce the chain has used elsewhere and that no node
   * knows can no longer land (campaign-engine.js droppedPullVerdict). Any
   * doubt, including an RPC that cannot answer, means no verdict.
   */
  async function droppedPullVerdict(rec) {
    if (!rec || rec.nonce == null || rec.nonceKey || !readSpenderNonce || !txKnown || !spender) return false;
    if (now() - (rec.sentAt || 0) < 120_000) return false;
    try {
      if ((await readSpenderNonce(spender)) <= rec.nonce) return false;
      return !(await txKnown(rec.txHash));
    } catch { return false; }
  }

  /**
   * Every UNFUNDED pledge with a funding attempt nobody in this process is
   * driving: ask the chain again. A door row with a hash → its receipt; no
   * row after STUCK_FUNDING_MS → the token's Transfer logs decide, or a
   * person. Never the allowance, never a guess.
   */
  async function sync({ force = false } = {}) {
    const out = { funded: [], failed: [], pending: 0, person: 0 };
    for (const p of store.listPledges({ status: 'UNFUNDED' })) {
      const f = p.funding;
      if (!f || !f.ref || funding.has(p.id) || reconciling.has(p.id)) continue;
      if (!['pulling', 'pending'].includes(f.state)) { if (f.needsPerson) out.person += 1; continue; }
      const rec = door.status(f.ref);
      const hash = rec?.txHash || f.txHash || null;
      if (hash) {
        if (rec?.status === 'PULL_SENT' && await droppedPullVerdict(rec)) {
          backToUnfunded(p.id, f.ref, `the signed pull ${hash} can no longer land (its nonce was used by another transaction and no node knows it)`);
          out.failed.push(p.id);
          continue;
        }
        if (f.txHash !== hash) patchFunding(p.id, f.ref, { txHash: hash, state: 'pending' });
        reconciling.add(p.id);
        confirmTx(hash).then((rcpt) => {
          const r = settleFunding(p.id, f.ref, rcpt, hash);
          if (r.outcome === 'funded') out.funded.push(p.id);
        }).catch((e) => log.warn?.(`[bounty-money] pledge ${p.id}: reconcile failed — ${e.message}`)).finally(() => reconciling.delete(p.id));
        out.pending += 1;
        continue;
      }
      // No transaction on record: the process stopped between the attempt and
      // the door's row, or the pull threw before signing and was not recorded.
      const age = now() - Date.parse(f.at);
      if (!force && age < STUCK_FUNDING_MS) { out.pending += 1; continue; }
      if (typeof findFundingTransfer !== 'function') { askPerson(p.id, f.ref, 'no_tx_no_search', `no transaction on record ${Math.round(age / 60_000)} min after the attempt, and this server cannot search the chain for it`); out.person += 1; continue; }
      try {
        const found = await findFundingTransfer({ token: token.address, from: f.wallet, to: platformAddress, atomic: f.atomic, sinceMs: Date.parse(f.at) - 60_000 });
        if (found?.found && found.txHash) {
          patchFunding(p.id, f.ref, { txHash: found.txHash, state: 'pending' });
          const rcpt = await confirmTx(found.txHash);
          const r = settleFunding(p.id, f.ref, rcpt, found.txHash);
          if (r.outcome === 'funded') out.funded.push(p.id);
        } else {
          backToUnfunded(p.id, f.ref, `no transaction on record and no Transfer of the pledge on chain ${Math.round(age / 60_000)} min after the attempt`);
          out.failed.push(p.id);
        }
      } catch (e) {
        askPerson(p.id, f.ref, 'search_failed', `the chain could not be searched for the pledge transfer (${e.shortMessage || e.message})`);
        out.person += 1;
      }
    }
    return out;
  }

  /** Admin: resolve one stuck pledge by the sweep's own rule, now. */
  async function resolveStuckFunding(pledgeId) {
    const p = store.getPledge(pledgeId);
    if (!p) throw fail('not_found', 'No such pledge.', 404);
    if (p.status !== 'UNFUNDED' || !p.funding) return { pledge: p, outcome: 'nothing_to_resolve' };
    const before = p.funding.ref;
    await sync({ force: true });
    const after = store.getPledge(pledgeId);
    const outcome = after.status === 'OPEN' ? 'funded' : !after.funding ? 'unfunded' : after.funding.needsPerson ? 'needs_person' : 'pending';
    return { pledge: after, outcome, ref: before };
  }

  /** What a pledge's funding looks like to its owner (my pledges) — no hashes of other people's, no internals. */
  function fundingView(p) {
    if (!p) return null;
    const f = p.funding;
    return {
      state: p.status === 'OPEN' || p.status === 'CLAIMED' || p.status === 'EXPIRED' ? 'funded' : p.status === 'ABANDONED' ? 'abandoned' : !f ? 'unfunded' : f.state === 'confirmed' ? 'funded' : f.needsPerson ? 'needs_person' : f.state,
      txHash: f?.txHash || null, wallet: f?.wallet || null, at: f?.at || null,
      needsPerson: f?.needsPerson || null,
      failures: (p.fundingFailures || []).length,
    };
  }

  /** Door status of the payout for a RELEASE row, for a contributor's view: 'owed' | 'pending' | 'paid' | 'failed' | 'voided' | null. */
  function payoutState(rowId) {
    const rec = door.status(releaseRef(rowId));
    if (!rec) return 'owed';
    if (rec.status === 'DONE' || rec.status === 'RETAINED') return 'paid';
    if (rec.status === 'FAILED') return 'failed';
    if (rec.status === 'VOIDED') return 'voided';
    return 'pending';
  }
  function refundState(contributionId) {
    const rec = door.status(refundRef(contributionId));
    if (!rec) return null;
    if (rec.status === 'DONE' || rec.status === 'RETAINED') return 'paid';
    if (rec.status === 'FAILED') return 'failed';
    if (rec.status === 'VOIDED') return 'voided';
    return 'pending';
  }

  /** What the boot log and /api/bounty/config say. */
  function summary() {
    const unfundedHeld = store.listReservedHandles().flatMap((r) => store.listContributions(r.key))
      .filter((c) => c.status === 'HELD' && !c.forfeitOfClip && !fundingWalletFor(c.id)).length;
    return {
      mode: 'real', fundingEnabled: bountyFundingEnabled(), spender, pullSigner: !!spender && !!door.hasSigner?.(pullSigner),
      payoutSigner: !!door.hasSigner?.('platform'), platformAddress, token: token.symbol,
      pendingIntents: pending().length, ledgerOnlyHeld: unfundedHeld,
    };
  }

  // A SettlementInterface whose `mode` is 'real' (the base class keeps mode as
  // a getter, so it is defined here rather than assigned).
  const impl = Object.create(SettlementInterface.prototype, { mode: { value: 'real', enumerable: true } });
  return Object.assign(impl, {
    release, refund, pending,
    fundTerms, needsApproval, fund, settleFunding, sync, resolveStuckFunding,
    payOwed, payAccount, fundingView, payoutState, refundState, fundingWalletFor, fundedAtomicFor, summary,
    abandonSweep: (opts) => escrow.sweepUnfundedPledges(opts),
  });
}
