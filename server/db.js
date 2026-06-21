import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  token_last4     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  username    TEXT,
  account_id  INTEGER,
  zone_id     TEXT,
  zone_name   TEXT,
  action      TEXT,
  rr_type     TEXT,
  rr_name     TEXT,
  detail_json TEXT,
  client_ip   TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ddns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT UNIQUE NOT NULL,
  account_id  INTEGER NOT NULL,
  zone_id     TEXT NOT NULL,
  zone_name   TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  record_name TEXT NOT NULL,
  record_type TEXT NOT NULL,
  last_ip     TEXT,
  updated_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER,
  zone_id      TEXT NOT NULL,
  zone_name    TEXT,
  label        TEXT,
  record_count INTEGER,
  records_json TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Lightweight migrations: add columns to existing installs without data loss.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('users', 'totp_secret', 'TEXT'); // encrypted base32 TOTP secret
ensureColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');

export function isSetupComplete() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0;
}

/** Best-effort cleanup of expired sessions; called at boot. */
export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}
