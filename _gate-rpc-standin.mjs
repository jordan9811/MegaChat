/**
 * A JSON-RPC node STAND-IN for the money gates: an HTTP server on 127.0.0.1
 * that answers only the methods a gate hands it. No network beyond the
 * loopback, no funds, no real chain. Every key a gate signs with here is
 * generated for the run and never funded anywhere.
 *
 * `handlers[method](params)` returns the JSON-RPC result, or throws
 * `{ rpcError }` (a JSON-RPC error answer) or `{ httpStatus }` (the HTTP
 * request itself fails, as a load balancer's 504 does: the node may still
 * have taken the transaction). A method with no handler is answered with a
 * JSON-RPC error, so a gate that forgot one fails loudly instead of hanging.
 *
 * This file names no signing method on purpose: the gates that use it name
 * the ones they answer, and Gate H Tier 3 pins those gates.
 */
import http from 'http';
import { encodeAbiParameters } from 'viem';

export function startRpcStandIn(handlers, { log = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let msgs;
      try { msgs = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const batch = Array.isArray(msgs);
      const answers = [];
      for (const m of batch ? msgs : [msgs]) {
        seen.push(m.method);
        const h = handlers[m.method];
        if (log) console.log('[stand-in]', m.method, JSON.stringify(m.params).slice(0, 160));
        if (!h) { answers.push({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `stand-in does not answer ${m.method}` } }); continue; }
        try { answers.push({ jsonrpc: '2.0', id: m.id, result: await h(m.params || []) }); }
        catch (e) {
          if (e?.httpStatus) { res.writeHead(e.httpStatus, { 'content-type': 'text/plain' }).end('upstream timeout'); return; }
          answers.push({ jsonrpc: '2.0', id: m.id, error: e?.rpcError || { code: -32603, message: String(e?.message || e) } });
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(batch ? answers : answers[0]));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

export const hex = (n) => `0x${BigInt(n).toString(16)}`;

/**
 * A READ-ONLY node for a gate that boots server.js: every ERC-20 read answers
 * (decimals, symbol, a zero balance and allowance), and nothing can be
 * prepared for sending — gas estimation is refused — so a server holding a
 * generated key still signs nothing. What the server asked is in `seen`.
 */
export function readOnlyTokenNode({ chainId = 4217, decimals = 6, symbol = 'USDC' } = {}) {
  const word = (n) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(n)]);
  return {
    eth_chainId: () => hex(chainId),
    eth_blockNumber: () => hex(1000),
    eth_getBlockByNumber: () => block(1000),
    eth_getCode: () => '0x',
    eth_getTransactionCount: () => '0x0',
    eth_gasPrice: () => hex(1_000_000_000n),
    eth_maxPriorityFeePerGas: () => '0x0',
    eth_call: ([call]) => {
      const sel = String(call?.data || call?.input || '').slice(0, 10);
      if (sel === '0x313ce567') return word(decimals);                                   // decimals()
      if (sel === '0x95d89b41') return encodeAbiParameters([{ type: 'string' }], [symbol]); // symbol()
      return word(0);                                                                    // balanceOf, allowance, anything else
    },
    eth_estimateGas: () => { throw { rpcError: { code: -32000, message: 'read-only stand-in: nothing is sent from a gate' } }; },
  };
}

export function block(n, txs = []) {
  return {
    number: hex(n), hash: `0x${n.toString(16).padStart(64, '0')}`, parentHash: `0x${'0'.repeat(64)}`,
    timestamp: hex(Math.floor(Date.now() / 1000)), baseFeePerGas: hex(1_000_000_000n), gasLimit: hex(30_000_000), gasUsed: '0x0',
    miner: `0x${'0'.repeat(40)}`, difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', logsBloom: `0x${'0'.repeat(512)}`,
    nonce: '0x0000000000000000', receiptsRoot: `0x${'0'.repeat(64)}`, sha3Uncles: `0x${'0'.repeat(64)}`, size: '0x0',
    stateRoot: `0x${'0'.repeat(64)}`, transactionsRoot: `0x${'0'.repeat(64)}`, mixHash: `0x${'0'.repeat(64)}`, uncles: [], transactions: txs,
  };
}

export function receipt(hash, n, from, to, status = '0x1') {
  return {
    transactionHash: hash, transactionIndex: '0x0', blockHash: `0x${n.toString(16).padStart(64, '0')}`, blockNumber: hex(n),
    from, to, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: hex(1_000_000_000n), contractAddress: null,
    logs: [], logsBloom: `0x${'0'.repeat(512)}`, status, type: '0x2',
  };
}

export function tx(hash, from, nonce, to, input = '0x', blockNumber = null) {
  return {
    hash, from, nonce: hex(nonce), to, input, value: '0x0', gas: '0x5208', maxFeePerGas: hex(2_000_000_000n), maxPriorityFeePerGas: '0x0',
    type: '0x2', chainId: hex(4217), v: '0x0', r: `0x${'1'.repeat(64)}`, s: `0x${'2'.repeat(64)}`, yParity: '0x0', accessList: [],
    blockNumber: blockNumber == null ? null : hex(blockNumber), blockHash: blockNumber == null ? null : `0x${blockNumber.toString(16).padStart(64, '0')}`, transactionIndex: blockNumber == null ? null : '0x0',
  };
}
