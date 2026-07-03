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
  getUserOperationGasPrice,
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  ContractAddress,
} from '@circle-fin/modular-wallets-core';

const CREDENTIAL_KEY = 'vstream_passkey_credential_v1';
const USDC_DECIMALS = 6;

// Arc's bundler rejects any userOp below 1 gwei priority fee ("precheck failed:
// maxPriorityFeePerGas is X but must be at least 1000000000"), but the network
// fee estimate can come back lower (~0.82 gwei). Every userOp built here MUST
// go through arcFeesWithFloor() — both via the bundler-client hook and the
// explicit values passed to sendUserOperation.
const MIN_PRIORITY_FEE_WEI = 1_000_000_000n; // 1 gwei bundler floor
const FALLBACK_BASE_FEE_BUDGET_WEI = 2_000_000_000n; // base-fee headroom if estimation fails

/**
 * Fee estimate clamped to the Arc bundler floor; maxFee keeps its headroom
 * above priority. Prefers Circle's own bundler oracle
 * (circle_getUserOperationGasPrice) so we track what the bundler will accept,
 * then falls back to the network estimate — the floor applies either way.
 */
async function arcFeesWithFloor(client) {
  let est = null;
  try {
    const gp = await getUserOperationGasPrice(client);
    if (gp?.medium?.maxPriorityFeePerGas && gp?.medium?.maxFeePerGas) {
      est = {
        maxFeePerGas: BigInt(gp.medium.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(gp.medium.maxPriorityFeePerGas),
      };
    }
  } catch {
    // Circle oracle unavailable — try the plain network estimate.
  }
  if (!est) {
    try {
      est = await client.estimateFeesPerGas();
    } catch {
      // RPC estimation unavailable — fall through to the floor values.
    }
  }
  const estPriority = est?.maxPriorityFeePerGas ?? 0n;
  const maxPriorityFeePerGas =
    estPriority > MIN_PRIORITY_FEE_WEI ? estPriority : MIN_PRIORITY_FEE_WEI;
  const baseFeeBudget =
    est && est.maxFeePerGas > estPriority
      ? est.maxFeePerGas - estPriority
      : FALLBACK_BASE_FEE_BUDGET_WEI;
  return {
    maxFeePerGas: baseFeeBudget + maxPriorityFeePerGas,
    maxPriorityFeePerGas,
  };
}

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

function isDuplicateUsernameError(err) {
  const text = [
    err?.message,
    err?.shortMessage,
    err?.details,
    err?.cause?.message,
  ].filter(Boolean).join(' ');
  return /username is duplicated/i.test(text);
}

async function loginPasskeyCredential() {
  console.log('[passkey] logging in with existing passkey…');
  return toWebAuthnCredential({
    transport: passkeyTransport,
    mode: WebAuthnMode.Login,
  });
}

function encodeApprove(spender, amount, tokenAddress) {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  });
  return { data, to: tokenAddress };
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
    userOperation: {
      // Fee source for EVERY userOp prepared through this client. Without this
      // viem falls back to the raw network estimate, which sits below Arc's
      // 1 gwei precheck floor and gets the op rejected.
      estimateFeesPerGas: () => arcFeesWithFloor(publicClient),
    },
  });
  console.log('[passkey] modular clients ready (Arc path:', chainPath + ')');
  return { publicClient, bundlerClient };
}

async function toSmartAccountFromCredential(credential, name) {
  storeCredential(credential);
  smartAccount = await toCircleSmartAccount({
    client: publicClient,
    owner: toWebAuthnAccount({ credential }),
    ...(name ? { name } : {}),
  });
  smartAccountAddress = smartAccount.address;
  console.log('[passkey] smart account:', smartAccountAddress);
  return smartAccountAddress;
}

/** First-time user: CREATE a passkey (WebAuthn register), then build the smart account. */
export async function registerPasskey(username) {
  if (!modularConfig) throw new Error('Call initModularClients first');
  if (!username) throw new Error('Username required to create a passkey');
  console.log('[passkey] registering new passkey for', username);
  let credential;
  try {
    credential = await toWebAuthnCredential({
      transport: passkeyTransport,
      mode: WebAuthnMode.Register,
      username,
    });
  } catch (err) {
    if (isDuplicateUsernameError(err)) {
      const friendly = new Error(
        `Username "${username}" already has a passkey — use "Sign in with existing passkey" instead.`
      );
      friendly.code = 'USERNAME_TAKEN';
      throw friendly;
    }
    throw err;
  }
  return toSmartAccountFromCredential(credential, username);
}

/** Returning user: sign in with an existing passkey (WebAuthn discoverable login). */
export async function loginPasskey(username) {
  if (!modularConfig) throw new Error('Call initModularClients first');
  const credential = await loginPasskeyCredential();
  return toSmartAccountFromCredential(credential, username || undefined);
}

/**
 * Auto mode (legacy entry point): stored credential -> login, otherwise
 * register; a duplicate username on register falls back to login.
 */
export async function connectPasskey(username) {
  if (!modularConfig) throw new Error('Call initModularClients first');
  if (!username) throw new Error('Username required for passkey registration');

  const stored = loadStoredCredential();
  if (stored) {
    console.log('[passkey] logging in with stored credential…');
    return loginPasskey(username);
  }
  try {
    return await registerPasskey(username);
  } catch (err) {
    if (err?.code !== 'USERNAME_TAKEN') throw err;
    console.log('[passkey] username already registered on Circle — switching to login');
    return loginPasskey(username);
  }
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
export async function authorizeSessionGasless(sessionCapAtomic, sellerAddress, tokenAddress) {
  if (!isPasskeyReady()) throw new Error('Passkey wallet not connected');
  const amount = BigInt(sessionCapAtomic);
  if (amount <= 0n) throw new Error('Invalid session cap');
  const token = tokenAddress || ContractAddress.ArcTestnet_USDC;

  const callData = encodeApprove(sellerAddress, amount, token);
  console.log(
    '[passkey] authorizing stream pulls:',
    formatUnits(amount, USDC_DECIMALS),
    'token',
    token,
    'cap for seller',
    sellerAddress
  );
  // Explicit fees at the call site as well — belt and suspenders with the
  // bundler-client hook, so a future client refactor can't drop the floor.
  const { maxFeePerGas, maxPriorityFeePerGas } = await arcFeesWithFloor(publicClient);
  const userOpHash = await bundlerClient.sendUserOperation({
    account: smartAccount,
    calls: [callData],
    paymaster: true,
    maxFeePerGas,
    maxPriorityFeePerGas,
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
    tokenAddress: token,
  };
}

/** @deprecated Phase 1 upfront transfer — kept for reference; join uses authorizeSessionGasless. */
export async function payJoinGasless(amountAtomic, sellerAddress, tokenAddress) {
  return authorizeSessionGasless(amountAtomic, sellerAddress, tokenAddress);
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
  registerPasskey,
  loginPasskey,
  getPasskeyAddress,
  isPasskeyReady,
  getPasskeyUsdcBalance,
  authorizeSessionGasless,
  payJoinGasless,
  selfTestClients,
  arcFeesWithFloor,
  MIN_PRIORITY_FEE_WEI,
  parseUsdcAmount: (str) => parseUnits(String(str), USDC_DECIMALS).toString(),
};
