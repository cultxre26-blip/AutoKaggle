import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx, listen, client } from './helpers.js';
import { diagnose } from '../src/diagnose.js';
import { checkSite } from '../src/checker.js';
import { runDueChecks } from '../src/scheduler.js';
import { postWebhook } from '../src/webhook.js';
import { openDb } from '../src/db.js';

function target(handler) {
  const server = http.createServer(handler);
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((x) => server.close(x)) })));
}
const creds = { email: 'a@example.com', password: 'correct-horse-battery' };

test('diagnose maps common failures to a cause and a fix', () => {
  const cases = { ENOTFOUND: 'dns', ECONNREFUSED: 'refused', ECONNRESET: 'reset', ETIMEDOUT: 'timeout', 'Timed out after 10s': 'timeout',
    CERT_HAS_EXPIRED: 'tls_expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'tls_untrusted', ERR_TLS_CERT_ALTNAME_INVALID: 'tls_hostname',
    KEYWORD_MISSING: 'content', 'HTTP 502': 'server_error', 'HTTP 404': 'not_found', 'HTTP 403': 'forbidden', 'HTTP 429': 'client_error', WEIRD: 'unknown' };
  for (const [err, code] of Object.entries(cases)) {
    const d = diagnose(err);
    assert.equal(d.code, code, err);
    assert.ok(d.title && d.fix);
  }
  assert.equal(diagnose(null), null);
});

test('keyword check passes, fails when text is missing, and is case-insensitive', async () => {
  const t = await target((q, r) => r.end('<html>Welcome to the Shop</html>'));
  assert.equal((await checkSite(t.url, { allowPrivate: true, keyword: 'welcome' })).ok, true);
  const miss = await checkSite(t.url, { allowPrivate: true, keyword: 'checkout' });
  assert.deepEqual([miss.ok, miss.statusCode, miss.error], [false, 200, 'KEYWORD_MISSING']);
  await t.close();
});

test('down alert includes diagnosis and fires the user webhook', async () => {
  const ctx = makeCtx();
  const uid = Number(ctx.db.prepare("INSERT INTO users (email, password_hash, alert_webhook_url, created_at) VALUES ('o@example.com','x','https://hooks.example/x',0)").run().lastInsertRowid);
  ctx.db.prepare("INSERT INTO sites (user_id, name, url, slug, keyword, created_at) VALUES (?, 'Shop', 'http://x', 's1', 'Welcome', 0)").run(uid);
  let seenKeyword;
  const fake = async (url, opts) => { seenKeyword = opts.keyword; return { ok: false, statusCode: 200, responseMs: 3, error: 'KEYWORD_MISSING' }; };
  await runDueChecks(ctx.db, ctx.mailer, ctx.config, 1_000_000, fake);
  await runDueChecks(ctx.db, ctx.mailer, ctx.config, 2_000_000, fake);
  assert.equal(seenKeyword, 'Welcome');
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0].text, /Likely cause: Page is up but the expected text is missing/);
  assert.match(ctx.sent[0].text, /What to try:/);
  assert.equal(ctx.hooks.length, 1);
  assert.equal(ctx.hooks[0].payload.event, 'down');
  assert.equal(ctx.hooks[0].payload.diagnosis.code, 'content');
  assert.equal(ctx.db.prepare('SELECT diagnosis_code FROM incidents').get().diagnosis_code, 'content');
});

test('webhook delivery posts JSON, and refuses private targets by default', async () => {
  let received;
  const t = await target((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received = JSON.parse(b); res.end('ok'); }); });
  assert.equal(await postWebhook(t.url, { text: 'hi' }, { allowPrivate: false }), false);
  assert.equal(await postWebhook(t.url, { text: 'hi' }, { allowPrivate: true }), true);
  assert.deepEqual(received, { text: 'hi' });
  await t.close();
});

test('API: keyword, webhook setting, manual check and incident details', async () => {
  const ctx = makeCtx();
  const app = await listen(ctx.app);
  const c = client(app.base);
  await c('/api/signup', 'POST', creds);
  ctx.db.exec('UPDATE users SET email_verified = 1');
  assert.equal((await c('/api/me', 'PATCH', { alertWebhookUrl: 'ftp://x' })).status, 400);
  const saved = await c('/api/me', 'PATCH', { alertWebhookUrl: 'https://hooks.example/abc' });
  assert.equal(saved.body.alertWebhookUrl, 'https://hooks.example/abc');
  assert.equal((await c('/api/me', 'PATCH', { alertWebhookUrl: '' })).body.alertWebhookUrl, '');

  const page = await target((q, r) => r.end('hello world'));
  assert.equal((await c('/api/sites', 'POST', { name: 'x', url: page.url, keyword: 'y'.repeat(101) })).status, 400);
  const site = (await c('/api/sites', 'POST', { name: 'Page', url: page.url, keyword: 'nothere' })).body;
  assert.equal(site.keyword, 'nothere');

  const r1 = await c(`/api/sites/${site.id}/check`, 'POST', {});
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ok, false);
  assert.equal(r1.body.diagnosis.code, 'content');
  assert.equal((await c(`/api/sites/${site.id}/check`, 'POST', {})).status, 429, 'rapid re-check is throttled');
  assert.equal((await client(app.base)(`/api/sites/${site.id}/check`, 'POST', {})).status, 401);

  ctx.db.prepare('UPDATE sites SET last_checked_at = 0, consecutive_failures = 1 WHERE id = ?').run(site.id);
  await c(`/api/sites/${site.id}/check`, 'POST', {});
  const d = (await c(`/api/sites/${site.id}/checks`)).body;
  assert.equal(d.incidents.length, 1);
  assert.equal(d.incidents[0].diagnosis.code, 'content');
  assert.ok(d.checks[0].diagnosis);
  await page.close(); await app.close();
});

test('opening an older database adds the new columns without losing data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', subscription_status TEXT NOT NULL DEFAULT 'none', stripe_customer_id TEXT UNIQUE, stripe_subscription_id TEXT, created_at INTEGER NOT NULL);
    INSERT INTO users (email, password_hash, created_at) VALUES ('keep@example.com','x',1);
    CREATE TABLE sites (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, interval_sec INTEGER NOT NULL DEFAULT 300, slug TEXT NOT NULL UNIQUE, paused INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'unknown', consecutive_failures INTEGER NOT NULL DEFAULT 0, last_checked_at INTEGER, ssl_expires_at INTEGER, ssl_alert_level INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE incidents (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, started_at INTEGER NOT NULL, resolved_at INTEGER, reason TEXT);`);
  old.close();
  const db = openDb(path);
  openDb(path).close(); // second open is a no-op
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('sites').includes('keyword'));
  assert.ok(cols('users').includes('alert_webhook_url'));
  assert.ok(cols('incidents').includes('diagnosis_code'));
  assert.equal(db.prepare('SELECT email FROM users').get().email, 'keep@example.com');
  db.close();
  rmSync(dir, { recursive: true });
});
