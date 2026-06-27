/**
 * ERC-20 helpers — dynamic decimals (never hardcode 6/18).
 */
import { createPublicClient, http, erc20Abi } from 'viem';

const arcChain = (chainId, rpcUrl) => ({
  id: chainId,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
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

export async function readTokenMetadata(tokenAddress, rpcUrl, chainId = 5042002) {
  const client = createPublicClient({
    chain: arcChain(chainId, rpcUrl),
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

export async function readTokenBalance(tokenAddress, owner, rpcUrl, chainId = 5042002) {
  const client = createPublicClient({
    chain: arcChain(chainId, rpcUrl),
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

export async function readTokenAllowance(tokenAddress, owner, spender, rpcUrl, chainId = 5042002) {
  const client = createPublicClient({
    chain: arcChain(chainId, rpcUrl),
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

/** Validate Arc ERC-20 and return metadata for room config. */
export async function validatePaymentToken(tokenAddress, rpcUrl, chainId = 5042002) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress || '')) {
    throw new Error('Invalid token address');
  }
  return readTokenMetadata(tokenAddress, rpcUrl, chainId);
}
