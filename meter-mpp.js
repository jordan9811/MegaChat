/**
 * MPP session meter — TIP-1034 payment channels on Tempo (the Phase 2 rebuild).
 *
 * Flow per seat:
 *   1. Viewer joins (POST /api/join/mpp) — no upfront transfer, no approve.
 *   2. Once live, the browser calls the tick route every tickSeconds through
 *      mppx's session manager. The FIRST call gets a 402 challenge; the
 *      manager opens an on-chain escrow channel with the session cap as the
 *      deposit (one wallet transaction), then every subsequent tick is a
 *      SIGNED OFF-CHAIN VOUCHER — zero gas, verified in-process.
 *   3. Leave → the client cooperatively closes the channel; kick/vanish → we
 *      settle server-side with the newest voucher. Either way the on-chain
 *      close pays the seller what was streamed and AUTO-REFUNDS the unspent
 *      deposit to the viewer straight from escrow — no seller-key refund
 *      transfers anymore.
 *
 * The server can only claim what the viewer signed; the viewer can never
 * exceed the locked deposit. (mpp.dev/payment-methods/tempo/session)
 */
import { randomBytes } from 'crypto';
import { createWalletClient, http } from 'viem';
import { tempo as tempoChain } from 'viem/chains';
import { Mppx, Store, tempo } from 'mppx/server';

/** Convert an Express request into a web-standard Request for mppx. */
export function toWebRequest(req) {
  const url = `http://${req.headers.host || 'localhost'}${req.originalUrl}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'content-length') continue; // body is re-serialized below
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody && req.body && Object.keys(req.body).length > 0
    ? JSON.stringify(req.body)
    : undefined;
  return new Request(url, { method: req.method, headers, body });
}

/** Pipe a web-standard Response back through an Express response. */
export async function sendWebResponse(res, webResponse) {
  res.status(webResponse.status);
  webResponse.headers.forEach((value, key) => {
    if (key === 'content-length') return;
    res.setHeader(key, value);
  });
  const text = await webResponse.text();
  res.send(text);
}

/**
 * Build the meter. Returns null when no seller key is configured (MPP joins
 * are then disabled with a clear error instead of a crash).
 */
export function createMppMeter({ account, rpcUrl, chainId, feeToken, log = console }) {
  if (!account) return null;

  const walletClient = createWalletClient({
    account,
    chain: tempoChain,
    transport: http(rpcUrl),
  });

  const store = Store.memory();
  // Binds challenges to their contents; regenerating on restart only voids
  // in-flight challenges (clients re-probe), never on-chain channel state.
  const secretKey = process.env.MPP_SECRET_KEY || randomBytes(32).toString('hex');

  const method = tempo.session({
    account,
    client: walletClient,
    chainId,
    store,
    feeToken,
    // Server-owned cadence: claim streamed funds on-chain in batches instead
    // of per voucher. Clients neither see nor control this.
    settlementSchedule: {
      amount: '0.25', // settle once ≥ $0.25 has accumulated…
      intervalMs: 5 * 60_000, // …or every 5 minutes, whichever first
      units: 300,
    },
  });

  const mppx = Mppx.create({ methods: [method], secretKey });

  // onPaymentSuccess fires inline on the request path. mppx may clone the
  // Request internally (a WeakMap on the instance misses — observed on
  // mainnet), so correlate by URL string: ticks for one seat are serialized
  // by the client, and the seat id is in the query.
  const receipts = new Map();
  mppx.onPaymentSuccess((ctx) => {
    const url = ctx.input instanceof Request ? ctx.input.url : null;
    if (url) receipts.set(url, ctx.receipt);
  });
  mppx.onPaymentFailed((ctx) => {
    log.warn(`[meter:mpp] payment failed: ${ctx.error?.message || 'unknown'}`);
  });

  return {
    store,
    walletClient,

    /**
     * Run one paid tick (or an open/top-up/close management action) through
     * the session method. Returns:
     *   { status: 402, respond(expressRes) }          — challenge issued
     *   { status: 200, receipt, respond(expressRes, body) } — payment verified
     */
    async handleTick(webRequest, opts) {
      const result = await mppx.session({
        amount: opts.amount,
        currency: opts.currency,
        decimals: opts.decimals,
        unitType: opts.unitType || 'tick',
        // Channels pay the streamer's wallet (recipient/payee) but are
        // OPERATED by the platform account: TIP-1034 only lets the payee or
        // a designated operator settle, and server-side settlement (kick,
        // vanish) is signed by the platform key (mainnet lesson: settle
        // reverts with "tx sender is not the channel payee" otherwise).
        operator: account.address,
        ...(opts.recipient ? { recipient: opts.recipient } : {}),
        ...(opts.suggestedDeposit ? { suggestedDeposit: opts.suggestedDeposit } : {}),
      })(webRequest);

      if (result.status === 402) {
        return {
          status: 402,
          respond: (res) => sendWebResponse(res, result.challenge),
        };
      }

      const receipt = receipts.get(webRequest.url) || null;
      receipts.delete(webRequest.url);
      return {
        status: 200,
        receipt,
        respond: (res, body) =>
          sendWebResponse(
            res,
            result.withReceipt(
              new Response(JSON.stringify(body), {
                headers: { 'Content-Type': 'application/json' },
              })
            )
          ),
      };
    },

    /**
     * Server-driven settlement for a channel whose owner vanished or was
     * kicked: submits the newest signed voucher on-chain, which pays the
     * seller and releases the remainder back to the viewer.
     */
    async settleChannel(channelId, reason = 'seat_ended') {
      if (!channelId) return null;
      try {
        // feeToken must be explicit here: the method-level feeToken only
        // covers SCHEDULED settlements, and the resolver otherwise prefers
        // the chain default fee token (pathUSD) which this account may not
        // hold (mainnet lesson: "total cost exceeds the balance").
        const txHash = await tempo.session.settle(store, walletClient, channelId, {
          account,
          feeToken,
        });
        log.log(`[meter:mpp] settled channel ${channelId} (${reason}) tx ${txHash}`);
        return txHash;
      } catch (err) {
        // Cooperative client close may have landed first — that's success.
        log.warn(`[meter:mpp] settle ${channelId} (${reason}): ${err.shortMessage || err.message}`);
        return null;
      }
    },
  };
}
