/**
 * A fresh v4 UUID naming one take, sent with its paid submit so the server can
 * tell a retry of that take from a new one (letters.js for a Holler,
 * bounty-routes.js for a bounty pledge). crypto.randomUUID exists only in a
 * secure context, and the join page also runs over plain http (MetaMask on a
 * LAN address); getRandomValues needs no secure context.
 */
export function newAttemptId(): string {
  if (typeof crypto.randomUUID === 'function' && typeof window !== 'undefined' && window.isSecureContext) {
    return crypto.randomUUID()
  }
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
