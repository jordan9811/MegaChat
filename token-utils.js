/**
 * TIP-20 / ERC-20 helpers — dynamic decimals (never hardcode 6/18).
 *
 * Tempo note: TIP-20 stablecoins expose the full ERC-20 read interface
 * (decimals/symbol/balanceOf/allowance), so viem's erc20Abi works unchanged.
 * The Arc Testnet 1-gwei priority-fee floor hack that used to live here was
 * Arc-specific and is intentionally gone (see TEMPO_NOTES.md).
 */
import { createPublicClient, http, erc20Abi } from 'viem';

const tokenChain = (chainId, rpcUrl) => ({
  id: chainId,
  name: 'Tempo',
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 6 },
  rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
});

export function toAtomic(amountStr, decimals) {
  const d = Number(decimals);
  if (!Number.isFinite(d) || d < 0 || d > 36) throw new Error('Invalid decimals');
  const [whole, frac = ''] = String(amountStr).split('.');
  const fracPadded = (frac + '0'.repeat(d)).slice(0, d);
  return BigInt(whole || '0') * (10n ** BigInt(d)) + BigInt(fracPadded || '0');
}

export function fromAtomic(atomic, decimals) {
  const d = Number(decimals);
  const v = BigInt(atomic);
  const base = 10n ** BigInt(d);
  const whole = v / base;
  const frac = (v % base).toString().padStart(d, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
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
