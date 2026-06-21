import {
  createCipheriv,
  createDecipheriv,
  createHmac,
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

/* ----------------------------- TOTP (RFC 6238) ----------------------------- */
// Standard 30s / 6-digit / SHA-1 TOTP, compatible with Google Authenticator,
// Authy, 1Password, etc. No external dependency.

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(keyBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', keyBuf).update(buf).digest();
  const offset = h[h.length - 1] & 0x0f;
  const code =
    ((h[offset] & 0x7f) << 24) |
    ((h[offset + 1] & 0xff) << 16) |
    ((h[offset + 2] & 0xff) << 8) |
    (h[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

/** A fresh base32 TOTP secret (20 random bytes). */
export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

/** The 6-digit code for a secret at a given unix time (defaults to now). */
export function totpAt(secretB32, unixSeconds) {
  const t = unixSeconds === undefined ? Math.floor(Date.now() / 1000) : unixSeconds;
  return hotp(base32Decode(secretB32), Math.floor(t / 30));
}

/** Verify a 6-digit code, tolerating ±`window` 30s steps for clock drift. */
export function totpVerify(secretB32, code, window = 1) {
  const c = String(code == null ? '' : code).trim();
  if (!secretB32 || !/^\d{6}$/.test(c)) return false;
  const key = base32Decode(secretB32);
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    if (hotp(key, counter + w) === c) return true;
  }
  return false;
}

/** otpauth:// URI for QR provisioning. */
export function totpUri(secretB32, label, issuer = 'cf-dns-panel') {
  const l = encodeURIComponent(label);
  const i = encodeURIComponent(issuer);
  return `otpauth://totp/${i}:${l}?secret=${secretB32}&issuer=${i}&algorithm=SHA1&digits=6&period=30`;
}
