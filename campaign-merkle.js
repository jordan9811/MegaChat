/**
 * campaign-merkle.js — the fingerprint of a frozen reference set.
 *
 * @openzeppelin/merkle-tree is not installed, so this is the small tree it
 * would have built, written down so a contract can verify it later:
 *
 *   ids     X user ids as decimal strings, de-duplicated, sorted NUMERICALLY
 *           (BigInt), so the same set always produces the same leaf order
 *   leaf    keccak256(abi.encodePacked(uint256 id))  — 32 bytes, big-endian
 *   pair    keccak256(min(a, b) ‖ max(a, b))         — sorted pairs, the
 *           convention OpenZeppelin's MerkleProof.verify uses, so a proof
 *           needs no left/right flags
 *   odd     a level with an odd count carries its last node up unchanged
 *   empty   keccak256 of zero bytes (a set must have ids; this is a sentinel)
 *
 * A one-id set's root is that id's leaf.
 *
 * TODO(campaign-root-onchain): publishing the root on chain is NOT done.
 * Any on-chain write must go through one of the two money doors and Gate H
 * (CLAUDE.md, standing rules) — settlement.js or escrow-chain.js — not here.
 * Until then the root is shown on the campaign page as a public fingerprint
 * anyone can recompute from the snapshot.
 */
import { keccak256, encodePacked, concat } from 'viem';

export function normaliseIds(ids) {
  const seen = new Set();
  for (const raw of ids || []) {
    const s = String(raw).trim();
    if (!/^\d{1,20}$/.test(s)) continue;
    const n = BigInt(s);
    if (n <= 0n || n >= 2n ** 64n) continue; // X ids are 64-bit snowflakes
    seen.add(n.toString());
  }
  return [...seen].sort((a, b) => { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; });
}

export const leafFor = (id) => keccak256(encodePacked(['uint256'], [BigInt(id)]));

function hashPair(a, b) {
  return BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

function levels(sortedIds) {
  let level = sortedIds.map(leafFor);
  const out = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    level = next;
    out.push(level);
  }
  return out;
}

/** The root over a set of ids, normalised first. */
export function merkleRoot(ids) {
  const sorted = normaliseIds(ids);
  if (!sorted.length) return keccak256('0x');
  const lv = levels(sorted);
  return lv[lv.length - 1][0];
}

/** The sibling path for `id`, or null when it is not in the set. */
export function merkleProof(ids, id) {
  const sorted = normaliseIds(ids);
  let idx = sorted.indexOf(BigInt(String(id)).toString());
  if (idx < 0) return null;
  const proof = [];
  for (const level of levels(sorted).slice(0, -1)) {
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sib < level.length) proof.push(level[sib]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(root, id, proof) {
  let h = leafFor(id);
  for (const p of proof || []) h = hashPair(h, p);
  return h === root;
}
