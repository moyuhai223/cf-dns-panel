import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTotpSecret, totpAt, totpVerify, totpUri } from '../server/crypto.js';

// RFC 6238 SHA-1 test vectors (secret = ASCII "12345678901234567890").
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('TOTP matches RFC 6238 SHA-1 vectors', () => {
  assert.equal(totpAt(RFC_SECRET, 59), '287082');
  assert.equal(totpAt(RFC_SECRET, 1111111109), '081804');
  assert.equal(totpAt(RFC_SECRET, 1234567890), '005924');
  assert.equal(totpAt(RFC_SECRET, 2000000000), '279037');
});

test('totpVerify accepts a fresh code and rejects wrong/garbage input', () => {
  const s = generateTotpSecret();
  const code = totpAt(s);
  assert.equal(totpVerify(s, code), true);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal(totpVerify(s, wrong), false);
  assert.equal(totpVerify(s, 'abc'), false);
  assert.equal(totpVerify(s, ''), false);
  assert.equal(totpVerify(s, null), false);
});

test('totpVerify tolerates ±1 step (clock drift)', () => {
  const s = generateTotpSecret();
  const now = Math.floor(Date.now() / 1000);
  // a code from the previous 30s window should still verify
  assert.equal(totpVerify(s, totpAt(s, now - 30)), true);
});

test('totpUri builds a valid otpauth URL', () => {
  assert.match(totpUri('ABC234', 'admin'), /^otpauth:\/\/totp\/cf-dns-panel:admin\?secret=ABC234&issuer=cf-dns-panel/);
});
