// Probe: can the seller wallet write on Tempo mainnet with fees paid from
// its stablecoin balance? Dust-level SELF-transfer (1 micro-USDC.e to self) —
// the only real cost is the network fee.
process.loadEnvFile('C:/Users/jorda/OneDrive/Documents/video-stream/.env');
import { createWalletClient, createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';

const USDC = process.env.TEMPO_USDC_ADDRESS;
const account = privateKeyToAccount(process.env.SELLER_PRIVATE_KEY);
console.log('seller:', account.address);

const pub = createPublicClient({ chain: tempo, transport: http() });
const wallet = createWalletClient({ account, chain: tempo, transport: http() });

const balBefore = await pub.readContract({
  address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address],
});
console.log('USDC.e before:', formatUnits(balBefore, 6));

try {
  const hash = await wallet.writeContract({
    address: USDC, abi: erc20Abi, functionName: 'transfer',
    args: [account.address, 1n], // 0.000001 USDC.e to self
  });
  console.log('tx sent:', hash);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  console.log('status:', receipt.status, 'gasUsed:', receipt.gasUsed.toString());
  const balAfter = await pub.readContract({
    address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address],
  });
  console.log('USDC.e after:', formatUnits(balAfter, 6), '(fee paid:', formatUnits(balBefore - balAfter, 6) + ')');
  console.log('PROBE RESULT: plain viem writeContract works on Tempo mainnet');
} catch (err) {
  console.error('PROBE FAILED:', err.shortMessage || err.message);
  if (err.cause) console.error('cause:', err.cause.shortMessage || err.cause.message);
  process.exit(1);
}
