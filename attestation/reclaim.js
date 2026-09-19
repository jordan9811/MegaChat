/**
 * Reclaim Protocol (zkTLS) — NOT INTEGRATED. This file is the whole boundary.
 *
 * Reclaim proves a value from behind a site's login without revealing the
 * session: the user taps a button, completes the flow in Reclaim's client, and
 * a proof lands on our backend.
 *
 * WHAT IS ACTUALLY TRUE TODAY (checked 2026-09-19): Reclaim publishes SDKs for
 * a **NodeJS webapp, Flutter, React Native, Kotlin and Swift**
 * (docs.reclaimprotocol.org). So it covers mobile AND web — the prompt's
 * assumption that Reclaim is the web one and Opacity the mobile one is wrong
 * in its Reclaim half. On coverage alone Reclaim is the broader of the two,
 * and it is the only one of the pair whose documentation was reachable.
 *
 * TO WIRE IT, fill in `verifyProof` below and nothing else:
 *   1. The user-facing flow is Reclaim's, on the client. This adapter only
 *      verifies what comes back, so it needs no UI and no redirect of ours.
 *   2. Verify the proof with Reclaim's verifier BEFORE reading any value out
 *      of it. An unverified proof is an attacker-supplied JSON document.
 *   3. A provider in Reclaim's terms is a per-site extractor; the attribute
 *      names it yields must be mapped onto ATTRIBUTES in attestation/index.js
 *      rather than stored raw, or the classifier will not see them.
 *   4. Build records with `attr(name, value, 'reclaim', { proof })`, storing
 *      the proof opaquely and exactly as received.
 */
export const status = 'not-configured';

export async function fetchAttributes() {
  return { ok: false, records: [], error: 'not-configured' };
}

/** The shape a real integration would take. Deliberately unimplemented. */
export async function verifyProof() {
  return { ok: false, records: [], error: 'not-configured' };
}
