/**
 * Mint a REAL sealed mc_identity cookie for gates.
 *
 * The seal is HMAC-SHA256 over a base64url payload with AUTH_SECRET — the
 * exact construction auth.js uses. Reimplemented here rather than exported
 * from auth.js on purpose: this is test scaffolding, and giving production
 * code a "make me any identity" export is precisely the kind of convenience
 * that becomes an auth bypass. Two implementations of a four-line HMAC is the
 * cheaper risk, and if they ever diverge every auth gate fails loudly.
 *
 * The caller must ALSO have the identity record in the identity store for
 * `readIdentityFromRequest` to resolve a username — the cookie carries only
 * provider + platformId. `seedIdentity` does both against a running server's
 * data dir.
 */
import { createHmac } from 'node:crypto';

const secret = () =>
  process.env.AUTH_SECRET || process.env.MPP_SECRET_KEY || 'megachat-dev-secret';

const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');

/** The sealed cookie value alone. */
export function sealIdentityValue({ provider, platformId }) {
  const payload = Buffer.from(JSON.stringify({ provider, platformId })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** A `Cookie:` header value carrying that identity. */
export function sealIdentityForTests({ provider, platformId }) {
  return `mc_identity=${encodeURIComponent(sealIdentityValue({ provider, platformId }))}`;
}

export default sealIdentityForTests;
