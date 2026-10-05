import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  subscription_status TEXT NOT NULL DEFAULT 'none',
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  interval_sec INTEGER NOT NULL DEFAULT 300,
  slug TEXT NOT NULL UNIQUE,
  paused INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  ssl_expires_at INTEGER,
  ssl_alert_level INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  response_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_site_time ON checks(site_id, checked_at);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
`;

const COLUMNS = [
  ['sites', 'keyword', 'TEXT'],
  ['users', 'alert_webhook_url', 'TEXT'],
  ['incidents', 'diagnosis_code', 'TEXT'],
];

function addMissingColumns(db) {
  for (const [table, column, type] of COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}
