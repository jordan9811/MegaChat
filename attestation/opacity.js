/**
 * Opacity (zkTLS) — NOT INTEGRATED. This file is the whole boundary.
 *
 * Opacity proves that a real TLS session with a site returned a particular
 * value, without handing us the session. It would let someone attest an
 * attribute from a platform this app has no API relationship with, or prove a
 * figure without granting us OAuth at all.
 *
 * WHAT IS ACTUALLY TRUE TODAY (checked 2026-09-19, and the prompt's assumption
 * that "Opacity is mobile, Reclaim is web" does not survive it):
 *   · Opacity ships native/mobile-first wrappers around a Rust core —
 *     `opacity-ios`, `opacity-android` (Kotlin), `react-native-opacity`,
 *     `flutter-opacity-core`, `capacitor-opacity` (github.com/OpacityLabs).
 *     There is no first-party browser-JS SDK in that list.
 *   · Its documentation site (docs.opacity.network) was returning a Cloudflare
 *     DNS error, so the integration contract could not be read from the source
 *     of truth. That alone is a reason this pass did not wire it.
 *   · Verification is AVS/SGX-flavoured (`opacity-avs-node`, `dcap-verify`,
 *     `opacity-ratls`), so a proof most likely arrives from a CLIENT and is
 *     checked against attestation collateral rather than fetched by us.
 *
 * TO WIRE IT, fill in `fetchAttributes` below and nothing else:
 *   1. The proof is produced on the CLIENT (a mobile app or a native shell),
 *      not here — this adapter's job is to VERIFY one and read values out.
 *      Expect the signature to become `verifyProof({ proof, expect })`.
 *   2. Verify before trusting: never parse values out of an unverified blob.
 *   3. Build records with `attr(name, value, 'opacity', { proof })`, storing
 *      the proof opaquely and exactly as received.
 *   4. Trust stays below the platform APIs (attestation/index.js explains why)
 *      and that ordering is this app's call, not Opacity's.
 */
export const status = 'not-configured';

export async function fetchAttributes() {
  return { ok: false, records: [], error: 'not-configured' };
}

/** The shape a real integration would take. Deliberately unimplemented. */
export async function verifyProof() {
  return { ok: false, records: [], error: 'not-configured' };
}
