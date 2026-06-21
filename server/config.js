import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDir, '..');

// Load .env from the project root if present (Node >= 20.12 ships process.loadEnvFile).
const envFile = path.join(projectRoot, '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.warn('[config] failed to load .env:', err.message);
  }
}

const dataDir = process.env.DATA_DIR || path.join(projectRoot, 'data');

/**
 * APP_SECRET secures cookie signing + at-rest token encryption. If the operator
 * did not supply one, generate and persist a stable key so encrypted tokens and
 * sessions survive restarts. Setting APP_SECRET in the environment is recommended
 * for production so the key is not stored next to the database.
 */
function getOrCreateSecret() {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 16) {
    return { secret: process.env.APP_SECRET, generated: false };
  }
  mkdirSync(dataDir, { recursive: true });
  const keyFile = path.join(dataDir, 'secret.key');
  if (existsSync(keyFile)) {
    return { secret: readFileSync(keyFile, 'utf8').trim(), generated: true };
  }
  const secret = randomBytes(32).toString('hex');
  writeFileSync(keyFile, secret, { mode: 0o600 });
  return { secret, generated: true };
}

const { secret, generated } = getOrCreateSecret();

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8787),
  // Optional sub-path when reverse-proxied under a path (e.g. "/dns"). Must match
  // the web build's BASE_PATH. Empty = served at domain root (the common case).
  basePath: (process.env.BASE_PATH || '').replace(/\/+$/, ''),
  appSecret: secret,
  appSecretGenerated: generated,
  dataDir,
  dbPath: process.env.DB_PATH || path.join(dataDir, 'cf-dns-panel.db'),
  projectRoot,
  cookieName: 'cfp_sid',
  // Set COOKIE_SECURE=true in production (browser reaches the panel over HTTPS via 1Panel).
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  sessionTtlMs: 1000 * 60 * 60 * 24 * 7, // 7 days
  logLevel: process.env.LOG_LEVEL || 'info',
};
