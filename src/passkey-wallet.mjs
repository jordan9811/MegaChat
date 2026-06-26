/**
 * Circle Modular Wallets (passkey) client — browser source (bundled before serve).
 * Arc Testnet chain path: /arcTestnet (Circle skill Transport URL Path Segments).
 *
 * Edit this file, then run: npm run build:passkey
 */
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, parseUnits } from 'viem';
import { arcTestnet } from 'viem/chains';
import { createBundlerClient, toWebAuthnAccount } from 'viem/account-abstraction';
import {
  WebAuthnMode,
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  ContractAddress,
} from '@circle-fin/modular-wallets-core';

const CREDENTIAL_KEY = 'vstream_passkey_credential_v1';
const USDC_DECIMALS = 6;

let modularConfig = null;
let passkeyTransport = null;
let modularTransport = null;
let publicClient = null;
let bundlerClient = null;
let smartAccount = null;
let smartAccountAddress = null;

function loadStoredCredential() {
  try {
    const raw = localStorage.getItem(CREDENTIAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeCredential(credential) {
  localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(credential));
}

function encodeApprove(spender, amount) {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  });
  return { data, to: ContractAddress.ArcTestnet_USDC };
}

/** Build Circle transports + clients. Throws if config missing. */
export function initModularClients(config) {
  if (!config || !config.clientKey || !config.clientUrl || !config.chainPath) {
    throw new Error('Modular Wallets not configured on server');
  }
  modularConfig = config;
  const chainPath = config.chainPath;
  passkeyTransport = toPasskeyTransport(config.clientUrl, config.clientKey);
  modularTransport = toModularTransport(
    `${config.clientUrl}/${chainPath}`,
    config.clientKey
  );
  publicClient = createPublicClient({
    chain: arcTestnet,
    transport: modularTransport,
  });
  bundlerClient = createBundlerClient({
    chain: arcTestnet,
    transport: modularTransport,
  });
  console.log('[passkey] modular clients ready (Arc path:', chainPath + ')');
  return { publicClient, bundlerClient };
}

/** Register or login passkey, create Circle Smart Account, return address. */
export async function connectPasskey(username) {
  if (!modularConfig) throw new Error('Call initModularClients first');
  if (!username) throw new Error('Username required for passkey registration');

  const stored = loadStoredCredential();
  let credential;
  if (stored) {
    console.log('[passkey] logging in with stored credential…');
    credential = await toWebAuthnCredential({
      transport: passkeyTransport,
      mode: WebAuthnMode.Login,
    });
  } else {
    console.log('[passkey] registering new passkey for', username);
    credential = await toWebAuthnCredential({
      transport: passkeyTransport,
      mode: WebAuthnMode.Register,
      username,
    });
  }

  storeCredential(credential);

  smartAccount = await toCircleSmartAccount({
    client: publicClient,
    owner: toWebAuthnAccount({ credential }),
    name: username,
  });
  smartAccountAddress = smartAccount.address;
  console.log('[passkey] smart account:', smartAccountAddress);
  return smartAccountAddress;
}

export function getPasskeyAddress() {
  return smartAccountAddress;
}

export function isPasskeyReady() {
  return !!(smartAccount && smartAccountAddress && bundlerClient);
}

/** On-chain USDC balance of the smart account (6 decimals). */
export async function getPasskeyUsdcBalance() {
  if (!publicClient || !smartAccountAddress) return '0';
  const raw = await publicClient.readContract({
    address: ContractAddress.ArcTestnet_USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [smartAccountAddress],
  });
  return formatUnits(raw, USDC_DECIMALS);
}

/**
 * Phase 2 join: ONE gasless userOp approving the seller to pull up to sessionCap.
 * After this, the server pulls TICK_PRICE every tick via transferFrom — no further prompts.
 */
export async function authorizeSessionGasless(sessionCapAtomic, sellerAddress) {
  if (!isPasskeyReady()) throw new Error('Passkey wallet not connected');
  const amount = BigInt(sessionCapAtomic);
  if (amount <= 0n) throw new Error('Invalid session cap');

  const callData = encodeApprove(sellerAddress, amount);
  console.log(
    '[passkey] authorizing stream pulls:',
    formatUnits(amount, USDC_DECIMALS),
    'USDC cap for seller',
    sellerAddress
  );
  const userOpHash = await bundlerClient.sendUserOperation({
    account: smartAccount,
    calls: [callData],
    paymaster: true,
  });

  const { receipt } = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
  const txHash = receipt.transactionHash;
  console.log('[passkey] session authorize confirmed:', txHash);
  return {
    type: 'approve',
    txHash,
    payer: smartAccountAddress,
    amount: sessionCapAtomic,
    seller: sellerAddress,
  };
}

/** @deprecated Phase 1 upfront transfer — kept for reference; join uses authorizeSessionGasless. */
export async function payJoinGasless(amountAtomic, sellerAddress) {
  return authorizeSessionGasless(amountAtomic, sellerAddress);
}

/** Smoke-test client construction without WebAuthn (for automated gate). */
export function selfTestClients(config) {
  initModularClients(config);
  if (!publicClient || !bundlerClient) {
    throw new Error('Bundler/public client missing after init');
  }
}

window.PasskeyWallet = {
  initModularClients,
  connectPasskey,
  getPasskeyAddress,
  isPasskeyReady,
  getPasskeyUsdcBalance,
  authorizeSessionGasless,
  payJoinGasless,
  selfTestClients,
  parseUsdcAmount: (str) => parseUnits(String(str), USDC_DECIMALS).toString(),
};
