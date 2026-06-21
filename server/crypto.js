import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { config } from './config.js';

// Derive a stable 32-byte AES key from the app secret.
const KEY = scryptSync(config.appSecret, 'cf-dns-panel:enc:v1', 32);

/** AES-256-GCM encrypt -> base64(iv | tag | ciphertext). */
export function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** Reverse of encrypt(). Throws if the payload was tampered with or the key changed. */
export function decrypt(payloadB64) {
  const buf = Buffer.from(payloadB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** scrypt password hash, encoded as "scrypt$<saltHex>$<hashHex>". No native deps. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const dk = scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const dk = scryptSync(String(password), salt, expected.length);
    return timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}
