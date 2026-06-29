/**
 * Per-room password hashing — scrypt via node:crypto (no plaintext stored or logged).
 */
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SALT_LEN = 16;
const KEY_LEN = 64;

export async function hashPassword(password) {
  const plain = String(password || '');
  if (plain.length < 4) {
    throw new Error('Password must be at least 4 characters');
  }
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptAsync(plain, salt, KEY_LEN);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (!password || !stored || !stored.startsWith('scrypt:')) return false;
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  try {
    const hash = await scryptAsync(String(password), salt, expected.length);
    return timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}
