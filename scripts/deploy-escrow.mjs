#!/usr/bin/env node
/**
 * Deploy contracts/MegaChatEscrow.sol and record the deployment.
 *
 *   node scripts/deploy-escrow.mjs --chain moderato --ephemeral
 *       Rehearsal: a throwaway key is generated, funded from the Moderato
 *       faucet, and used for every role unless a role flag says otherwise.
 *       The key is discarded when the process exits and is never printed.
 *
 *   ESCROW_DEPLOYER_KEY=... node scripts/deploy-escrow.mjs --chain mainnet \
 *       --token 0x20c000000000000000000000b9537d11c60e8b50 \
 *       --operator 0x… --attester 0x… --owner 0x… --fee-recipient 0x… --i-mean-mainnet
 *       Production (Session 2). Refuses to run without every role given
 *       explicitly, the deployer key in the environment, and the flag.
 *
 * Roles, all immutable after deployment:
 *   operator       the only address that may deposit (pulls the viewer's approved cap)
 *   attester       the only address that may attest hidden time — a SEPARATE key
 *                  (ESCROW_ATTEST_KEY), never the payout or seller key
 *   owner          may tune the three escalation parameters inside hard bounds
 *   fee-recipient  receives the fee declared at deposit (0 bps today)
 *
 * Every deployment is appended to contracts/deployments.json with the source
 * and bytecode hashes of the artifact it came from, so an address can always
 * be checked against the code that produced it.
 *
 * This script never reads SELLER_PRIVATE_KEY or PLATFORM_SETTLEMENT_KEY.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createPublicClient, createWalletClient, http, erc20Abi, isAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { tempo, tempoModerato } from 'viem/chains';
import { loadArtifact, bytecodeMatches } from '../contracts/escrow-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOYMENTS = path.join(ROOT, 'contracts', 'deployments.json');

const CHAINS = {
  moderato: { chain: tempoModerato, defaultToken: '0x20c0000000000000000000000000000000000001', tokenLabel: 'AlphaUSD (testnet stand-in for USDC.e)' },
  mainnet: { chain: tempo, defaultToken: null, tokenLabel: 'USDC.e' },
};

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

export async function deployEscrow({ chainName, token, operator, attester, owner, feeRecipient, deployerKey, ephemeral = false, record = true, feeToken = null, log = console }) {
  const cfg = CHAINS[chainName];
  if (!cfg) throw new Error(`unknown chain "${chainName}" (moderato | mainnet)`);
  const pub = createPublicClient({ chain: cfg.chain, transport: http() });

  let key = deployerKey;
  if (ephemeral) {
    if (chainName !== 'moderato') throw new Error('--ephemeral is for the Moderato rehearsal only');
    key = generatePrivateKey();
  }
  if (!key) throw new Error('no deployer key: set ESCROW_DEPLOYER_KEY or pass --ephemeral on moderato');
  const deployer = privateKeyToAccount(key);
  const wallet = createWalletClient({ account: deployer, chain: cfg.chain, transport: http() });

  if (ephemeral) {
    await pub.request({ method: 'tempo_fundAddress', params: [deployer.address] });
    await new Promise((r) => setTimeout(r, 3000));
  }
  const tokenAddr = token || cfg.defaultToken;
  const roles = {
    operator: operator || (ephemeral ? deployer.address : null),
    attester: attester || (ephemeral ? deployer.address : null),
    owner: owner || (ephemeral ? deployer.address : null),
    feeRecipient: feeRecipient || (ephemeral ? deployer.address : null),
  };
  for (const [k, v] of Object.entries({ token: tokenAddr, ...roles })) {
    if (!v || !isAddress(v)) throw new Error(`${k} must be an address (got ${v})`);
  }
  const art = loadArtifact();
  const [sym, dec] = await Promise.all([
    pub.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'symbol' }),
    pub.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  log.log(`[deploy-escrow] ${chainName} (chainId ${cfg.chain.id}) token ${sym} (${dec} dp) ${tokenAddr}`);
  log.log(`[deploy-escrow] deployer ${deployer.address}${ephemeral ? ' (ephemeral, discarded on exit)' : ''}`);
  log.log(`[deploy-escrow] operator ${roles.operator} attester ${roles.attester} owner ${roles.owner} feeRecipient ${roles.feeRecipient}`);

  // On mainnet the deployer holds USDC.e, not pathUSD, and a contract creation
  // is a non-TIP-20 call whose fee token would otherwise default to pathUSD.
  // The fee token is therefore explicit (a Tempo transaction), defaulting to
  // the escrow token itself on mainnet.
  const fee = feeToken || (chainName === 'mainnet' ? tokenAddr : null);
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [tokenAddr, roles.operator, roles.attester, roles.owner, roles.feeRecipient], ...(fee ? { feeToken: fee } : {}) });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rcpt.status !== 'success' || !rcpt.contractAddress) throw new Error(`deployment reverted: ${hash}`);
  const code = await pub.getBytecode({ address: rcpt.contractAddress });
  const matches = bytecodeMatches(code, art);
  record = {
    chain: chainName, chainId: cfg.chain.id, address: rcpt.contractAddress, txHash: hash, blockNumber: rcpt.blockNumber.toString(),
    gasUsed: rcpt.gasUsed.toString(), deployer: deployer.address, ephemeralDeployer: ephemeral, token: tokenAddr, tokenSymbol: sym, roles,
    compiler: art.compiler, evmVersion: art.evmVersion, sourceHash: art.sourceHash,
    deployedBytecodeSha256: createHash('sha256').update(art.deployedBytecode).digest('hex'), onChainBytecodeMatchesArtifact: matches,
    deployedAt: new Date().toISOString(),
  };
  const entry = record;
  if (record !== false && arguments[0].record !== false) {
    const list = fs.existsSync(DEPLOYMENTS) ? JSON.parse(fs.readFileSync(DEPLOYMENTS, 'utf8')) : [];
    list.push(entry);
    fs.writeFileSync(DEPLOYMENTS, JSON.stringify(list, null, 2) + '\n');
  }
  log.log(`[deploy-escrow] deployed at ${rcpt.contractAddress} (tx ${hash}, gas ${rcpt.gasUsed}) — bytecode ${matches ? 'matches' : 'DOES NOT MATCH'} the artifact${arguments[0].record === false ? ' (not recorded: throwaway run)' : '; recorded in contracts/deployments.json'}`);
  return { ...entry, wallet, pub, key: undefined };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const chainName = arg('chain', 'moderato');
  const ephemeral = arg('ephemeral', false) === true;
  if (chainName === 'mainnet') {
    if (arg('i-mean-mainnet', false) !== true) { console.error('refusing mainnet without --i-mean-mainnet'); process.exit(2); }
    for (const r of ['token', 'operator', 'attester', 'owner', 'fee-recipient']) {
      if (!arg(r)) { console.error(`mainnet needs --${r} given explicitly`); process.exit(2); }
    }
    if (!process.env.ESCROW_DEPLOYER_KEY) { console.error('mainnet needs ESCROW_DEPLOYER_KEY in the environment'); process.exit(2); }
  }
  deployEscrow({
    chainName, ephemeral,
    token: arg('token') || undefined, operator: arg('operator') || undefined, attester: arg('attester') || undefined,
    owner: arg('owner') || undefined, feeRecipient: arg('fee-recipient') || undefined,
    feeToken: arg('fee-token') || undefined,
    deployerKey: process.env.ESCROW_DEPLOYER_KEY || undefined,
  }).then(() => process.exit(0)).catch((e) => { console.error('[deploy-escrow] failed:', e.shortMessage || e.message); process.exit(1); });
}
