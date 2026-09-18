#!/usr/bin/env node
/**
 * Compile contracts/MegaChatEscrow.sol with solc-js for Tempo's EVM (Osaka)
 * and write the artifact the deploy script and the gate consume:
 *
 *   contracts/build/MegaChatEscrow.json  { abi, bytecode, deployedBytecode, metadata, compiler, evmVersion, sourceHash }
 *
 * The artifact is committed so a deployed address can be checked against the
 * exact bytecode that produced it. Re-run after any change to the source.
 *
 *   node contracts/escrow-build.mjs            # build
 *   node contracts/escrow-build.mjs --check    # exit 1 if the artifact is stale
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const solc = require('solc');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'MegaChatEscrow.sol');
const OUT_DIR = path.join(HERE, 'build');
const OUT = path.join(OUT_DIR, 'MegaChatEscrow.json');
const EVM_VERSION = 'osaka';

export function buildEscrow({ write = true } = {}) {
  const source = fs.readFileSync(SRC, 'utf8');
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const input = {
    language: 'Solidity',
    sources: { 'MegaChatEscrow.sol': { content: source } },
    settings: {
      evmVersion: EVM_VERSION,
      optimizer: { enabled: true, runs: 200 },
      metadata: { bytecodeHash: 'none' },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'metadata'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    throw new Error('solc errors:\n' + errors.map((e) => e.formattedMessage).join('\n'));
  }
  for (const w of (out.errors || []).filter((e) => e.severity !== 'error')) console.warn(w.formattedMessage);
  const c = out.contracts['MegaChatEscrow.sol'].MegaChatEscrow;
  const artifact = {
    contractName: 'MegaChatEscrow',
    compiler: `solc ${solc.version()}`,
    evmVersion: EVM_VERSION,
    optimizer: { enabled: true, runs: 200 },
    sourceHash,
    abi: c.abi,
    bytecode: '0x' + c.evm.bytecode.object,
    deployedBytecode: '0x' + c.evm.deployedBytecode.object,
    // Byte ranges of the deployed code that hold immutables (roles, token,
    // domain separator). They are filled in at construction, so an on-chain
    // comparison must mask them — see bytecodeMatches().
    immutableReferences: Object.values(c.evm.deployedBytecode.immutableReferences || {}).flat(),
    metadata: c.metadata,
  };
  if (write) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + '\n');
  }
  return artifact;
}

export function loadArtifact() {
  return JSON.parse(fs.readFileSync(OUT, 'utf8'));
}

/**
 * Does on-chain runtime code come from this artifact? Immutable slots differ
 * per deployment (they carry the constructor's roles), so both sides are
 * compared with those ranges zeroed.
 */
export function bytecodeMatches(onChainHex, artifact) {
  const norm = (h) => (h || '').toLowerCase().replace(/^0x/, '');
  let a = norm(onChainHex), b = norm(artifact.deployedBytecode);
  if (!a || a.length !== b.length) return false;
  const mask = (hex, { start, length }) => hex.slice(0, start * 2) + '0'.repeat(length * 2) + hex.slice((start + length) * 2);
  for (const ref of artifact.immutableReferences || []) { a = mask(a, ref); b = mask(b, ref); }
  return a === b;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  if (process.argv.includes('--check')) {
    const fresh = buildEscrow({ write: false });
    const stored = fs.existsSync(OUT) ? loadArtifact() : null;
    const stale = !stored || stored.sourceHash !== fresh.sourceHash || stored.bytecode !== fresh.bytecode;
    console.log(stale ? 'artifact STALE — run node contracts/escrow-build.mjs' : `artifact fresh (${fresh.compiler}, ${EVM_VERSION}, ${(fresh.deployedBytecode.length - 2) / 2} bytes)`);
    process.exit(stale ? 1 : 0);
  }
  const a = buildEscrow();
  console.log(`built MegaChatEscrow: ${a.compiler}, evm ${EVM_VERSION}, deployed bytecode ${(a.deployedBytecode.length - 2) / 2} bytes, ${a.abi.filter((x) => x.type === 'function').length} functions → contracts/build/MegaChatEscrow.json`);
}
