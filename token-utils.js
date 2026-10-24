/**
 * TIP-20 / ERC-20 helpers — dynamic decimals (never hardcode 6/18).
 *
 * Tempo note: TIP-20 stablecoins expose the full ERC-20 read interface
 * (decimals/symbol/balanceOf/allowance), so viem's erc20Abi works unchanged.
 * The Arc Testnet 1-gwei priority-fee floor hack that used to live here was
 * Arc-specific and is intentionally gone (see TEMPO_NOTES.md).
 */
import { createPublicClient, http, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const tokenChain = (chainId, rpcUrl) => ({
  id: chainId,
  name: 'Tempo',
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 6 },
  rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
});

function checkDecimals(decimals) {
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error('Invalid decimals');
  return d;
}

// An unsigned decimal with at least one digit: "1", "1.5", ".5", "1.".
const DECIMAL_RE = /^(\d+(\.\d*)?|\.\d+)$/;

/**
 * A decimal amount string → atomic units. REFUSES (throws) anything that is
 * not an unsigned plain decimal: a sign ("-0.5" used to come back as +0.5, so
 * a campaign reward typed as "-0.5" was accepted as 0.5), an exponent
 * (String(1e-7) is "1e-7"), a second dot ("1.2.3" used to read as 1.2), or no
 * digit at all. Surrounding whitespace is trimmed, as BigInt always did.
 *
 * Digits past the token's precision are TRUNCATED by default, which is what
 * this function always did and what live callers depend on: server.js parses
 * the demo room's "0.001" tick price at 0 decimals (points) on every passkey
 * terms request. `{ exact: true }` refuses them instead; money a person types
 * should be parsed that way.
 */
export function toAtomic(amountStr, decimals, { exact = false } = {}) {
  const d = checkDecimals(decimals);
  const s = String(amountStr ?? '').trim();
  if (!DECIMAL_RE.test(s)) throw new Error(`Invalid amount ${JSON.stringify(String(amountStr)).slice(0, 40)}: expected an unsigned decimal such as "1.5"`);
  const [whole, frac = ''] = s.split('.');
  if (exact && frac.replace(/0+$/, '').length > d) throw new Error(`Invalid amount ${s}: more than ${d} decimal places`);
  const fracPadded = (frac + '0'.repeat(d)).slice(0, d);
  return BigInt(whole || '0') * (10n ** BigInt(d)) + BigInt(fracPadded || '0');
}

/** Atomic units → a trimmed decimal string. Sign-safe: -1500000n at 6 is "-1.5" (it used to print "-1.-5"). */
export function fromAtomic(atomic, decimals) {
  const d = checkDecimals(decimals);
  const v = BigInt(atomic);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(d);
  const whole = a / base;
  const frac = d ? (a % base).toString().padStart(d, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** An EVM address: 0x and 40 hex. Shared, so the 16 inline copies can converge on one (cc-34). */
export const isEvmAddress = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
/** A transaction hash: 0x and 64 hex. Never a key check — keys go through normalizeKey. */
export const isTxHash = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
/** Two addresses (or hashes) are the same, case-insensitively; a missing one is never the same. */
export const sameAddress = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * A private key as a human might store it: with or without 0x. Null if it is
 * neither. FOR COMPARISON ONLY outside escrow-chain.js: every money signer in
 * server.js accepts only the 0x form, and stays that way (DECISIONS
 * 2026-10-24), so a guard that compares keys must normalise to see every key
 * a signer could end up using, while a loader must not start using one.
 */
export function normalizeKey(v) {
  const t = String(v || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return `0x${t}`;
  return /^0x[0-9a-fA-F]{64}$/.test(t) ? t : null;
}

/** The address a key resolves to, through normalizeKey; null when it is no key. Never logs the key. */
export function signerAddress(raw) {
  const k = normalizeKey(raw);
  if (!k) return null;
  try { return privateKeyToAccount(k).address; } catch { return null; }
}

/**
 * Why a configured key will not be used by a strict (0x-only) loader:
 * 'unset', 'malformed' (set, but not 0x followed by 64 hex), or null when it
 * is usable. For logs that name the variable, never its value.
 */
export function keyProblem(raw) {
  if (raw == null || String(raw).trim() === '') return 'unset';
  return /^0x[0-9a-fA-F]{64}$/.test(String(raw)) ? null : 'malformed';
}

export async function readTokenMetadata(tokenAddress, rpcUrl, chainId = 4217) {
  const client = createPublicClient({
    chain: tokenChain(chainId, rpcUrl),
    transport: http(rpcUrl),
  });
  const addr = tokenAddress;
  const decimals = Number(await client.readContract({
    address: addr,
    abi: erc20Abi,
    functionName: 'decimals',
  }));
  let symbol = 'TOKEN';
  try {
    symbol = String(await client.readContract({
      address: addr,
      abi: erc20Abi,
      functionName: 'symbol',
    }));
  } catch { /* non-standard token */ }
  return { address: addr, decimals, symbol };
}

export async function readTokenBalance(tokenAddress, owner, rpcUrl, chainId = 4217) {
  const client = createPublicClient({
    chain: tokenChain(chainId, rpcUrl),
    transport: http(rpcUrl),
  });
  const raw = await client.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
  return BigInt(raw);
}

export async function readTokenAllowance(tokenAddress, owner, spender, rpcUrl, chainId = 4217) {
  const client = createPublicClient({
    chain: tokenChain(chainId, rpcUrl),
    transport: http(rpcUrl),
  });
  const raw = await client.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });
  return BigInt(raw);
}

/** Validate a Tempo TIP-20/ERC-20 and return metadata for room config. */
export async function validatePaymentToken(tokenAddress, rpcUrl, chainId = 4217) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress || '')) {
    throw new Error('Invalid token address');
  }
  return readTokenMetadata(tokenAddress, rpcUrl, chainId);
}

/**
 * A paid seat's CITED approve transaction (OPEN-ISSUES N16): when the client
 * names one, it must be readable, mined, successful and sent BY the payer.
 * Returns null when it is, or a refusal reason. `readReceipt(hash)` resolves
 * to the receipt or throws (not found, not mined, RPC error) — every throw is
 * a refusal: a junk or unmined hash used to fall through to "the allowance is
 * authoritative", which made citing one the same as citing none. No hash at
 * all (`cited: false`) is not judged here: the caller keeps the allowance-only
 * behaviour for that case and logs it.
 */
export async function citedApproveProblem({ txHash, payer, readReceipt }) {
  if (txHash == null || txHash === '') return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) return 'approve_tx_invalid';
  let receipt;
  try { receipt = await readReceipt(txHash); } catch { return 'approve_tx_unreadable'; }
  if (!receipt) return 'approve_tx_unreadable';
  if (receipt.status !== 'success') return 'tx_not_success';
  if (!receipt.from || String(receipt.from).toLowerCase() !== String(payer).toLowerCase()) return 'approve_not_from_payer';
  return null;
}
