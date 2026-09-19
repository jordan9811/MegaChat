#!/usr/bin/env node
/**
 * Send a small amount of the escrow token from the seller wallet to an escrow
 * role wallet so it can pay gas. Tempo fees are paid in the token itself.
 *
 *   ESCROW_FUNDER_KEY=... node scripts/fund-escrow-roles.mjs --to 0x… --amount 0.10 --i-mean-mainnet
 *
 * Refuses without the flag, refuses amounts above 1.00, and prints the
 * transaction hash and both balances — never a key. Pinned by Gate H Tier 3.
 */
import { createPublicClient, createWalletClient, http, erc20Abi, parseUnits, formatUnits, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';

const USDC_E = '0x20c000000000000000000000b9537d11c60e8b50';
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? undefined : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const to = arg('to'), amount = arg('amount');
if (arg('i-mean-mainnet') !== true) { console.error('refusing without --i-mean-mainnet'); process.exit(2); }
if (!isAddress(to || '')) { console.error('--to must be an address'); process.exit(2); }
if (!(Number(amount) > 0) || Number(amount) > 1) { console.error('--amount must be between 0 and 1.00'); process.exit(2); }
const raw = String(process.env.ESCROW_FUNDER_KEY || '').trim();
const key = /^[0-9a-fA-F]{64}$/.test(raw) ? `0x${raw}` : raw;
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) { console.error('ESCROW_FUNDER_KEY missing or malformed'); process.exit(2); }

const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain: tempo, transport: http() });
const wallet = createWalletClient({ account, chain: tempo, transport: http() });
const bal = (a) => pub.readContract({ address: USDC_E, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const value = parseUnits(String(amount), 6);
console.log(`[fund] ${formatUnits(value, 6)} USDC.e ${account.address} → ${to}`);
const hash = await wallet.writeContract({ address: USDC_E, abi: erc20Abi, functionName: 'transfer', args: [to, value], feeToken: USDC_E });
const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
console.log(`[fund] ${r.status} tx ${hash} — funder now ${formatUnits(await bal(account.address), 6)}, recipient now ${formatUnits(await bal(to), 6)}`);
process.exit(r.status === 'success' ? 0 : 1);
