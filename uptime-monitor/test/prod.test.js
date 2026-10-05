import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createBilling } from '../src/billing.js';
import { pruneExpired, schedulerHealthy } from '../src/scheduler.js';
import { makeCtx, listen, client } from './helpers.js';

const good = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), APP_URL: 'https://pw.example.com', SMTP_HOST: 'smtp.example.com' };

test('production config validation rejects unsafe or half-configured deploys', () => {
  assert.doesNotThrow(() => loadConfig(good));
  assert.throws(() => loadConfig({ ...good, SESSION_SECRET: 'change-me' }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ ...good, APP_URL: 'http://pw.example.com' }), /https/);
  assert.throws(() => loadConfig({ ...good, ALLOW_PRIVATE_TARGETS: '1' }), /SSRF/);
  assert.throws(() => loadConfig({ ...good, SMTP_HOST: '' }), /SMTP_HOST/);
  assert.throws(() => loadConfig({ ...good, STRIPE_SECRET_KEY: 'sk_x' }), /STRIPE_WEBHOOK_SECRET/);
  assert.throws(() => loadConfig({ ...good, TURNSTILE_SITE_KEY: 'k' }), /TURNSTILE/);
  assert.doesNotThrow(() => loadConfig({ ...good, STRIPE_SECRET_KEY: 'sk_x', STRIPE_WEBHOOK_SECRET: 'whsec', STRIPE_PRICE_PRO: 'p1', STRIPE_PRICE_TEAM: 'p2' }));
});

test('health check reflects scheduler state', () => {
  const now = 10_000_000;
  assert.equal(schedulerHealthy(now, { lastTick: null, runStartedAt: null }), true);
  assert.equal(schedulerHealthy(now, { lastTick: now - 20_000, runStartedAt: null }), true);
  assert.equal(schedulerHealthy(now, { lastTick: now - 200_000, runStartedAt: null }), false, 'timer stopped');
  assert.equal(schedulerHealthy(now, { lastTick: now - 1000, runStartedAt: now - 700_000 }), false, 'batch stuck');
});

test('HSTS only on https deployments; request ids are returned', async () => {
  const https = makeCtx({ APP_URL: 'https://pw.example.com' });
  const s1 = await listen(https.app);
  const r1 = await fetch(s1.base + '/healthz');
  assert.ok(r1.headers.get('strict-transport-security'));
  assert.ok(r1.headers.get('x-request-id'));
  await s1.close();
  const plain = makeCtx();
  const s2 = await listen(plain.app);
  assert.equal((await fetch(s2.base + '/healthz')).headers.get('strict-transport-security'), null);
  await s2.close();
});

test('expired sessions, tokens and old webhook events are pruned', () => {
  const ctx = makeCtx();
  ctx.db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (1,'a@example.com','x',0)").run();
  ctx.db.prepare("INSERT INTO sessions VALUES ('old', 1, 100), ('live', 1, 9999999999999)").run();
  ctx.db.prepare("INSERT INTO tokens VALUES ('old', 1, 'verify', 100), ('live', 1, 'verify', 9999999999999)").run();
  ctx.db.prepare("INSERT INTO webhook_events VALUES ('evt_old', 100), ('evt_new', ?)").run(Date.now());
  pruneExpired(ctx.db);
  const n = (t) => ctx.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  assert.deepEqual([n('sessions'), n('tokens'), n('webhook_events')], [1, 1, 1]);
});

test('account export contains the user data and requires login', async () => {
  const ctx = makeCtx();
  const srv = await listen(ctx.app);
  const c = client(srv.base);
  assert.equal((await c('/api/me/export')).status, 401);
  await c('/api/signup', 'POST', { email: 'a@example.com', password: 'correct-horse-battery' });
  ctx.db.exec('UPDATE users SET email_verified = 1');
  await c('/api/sites', 'POST', { name: 'Shop', url: 'https://example.com' });
  const res = await fetch(srv.base + '/api/me/export', { headers: { cookie: (await (async () => { const r = await fetch(srv.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'correct-horse-battery' }) }); return r.headers.get('set-cookie').split(';')[0]; })()) } });
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const data = await res.json();
  assert.equal(data.account.email, 'a@example.com');
  assert.equal(data.sites[0].name, 'Shop');
  assert.equal(data.account.password_hash, undefined);
  assert.equal(JSON.stringify(data).includes('scrypt$'), false);
  await srv.close();
});

test('captcha is enforced on signup only when configured, and fails closed', async () => {
  const config = loadConfig({ APP_URL: 'http://localhost:3000', TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' });
  const db = openDb(':memory:');
  const mailer = { async send() {}, async webhook() { return true; } };
  let allow = false;
  const app = createApp({ config, db, mailer, billing: createBilling(config, db), verifyCaptcha: async (t) => allow && t === 'good' });
  const srv = await listen(app);
  const c = client(srv.base);
  const body = { email: 'a@example.com', password: 'correct-horse-battery' };
  assert.equal((await c('/api/config')).body.captchaSiteKey, 'site');
  assert.equal((await c('/api/signup', 'POST', body)).status, 400);
  assert.equal((await c('/api/signup', 'POST', { ...body, captchaToken: 'good' })).status, 400, 'verifier says no');
  allow = true;
  assert.equal((await c('/api/signup', 'POST', { ...body, captchaToken: 'bad' })).status, 400);
  assert.equal((await c('/api/signup', 'POST', { ...body, captchaToken: 'good' })).status, 201);
  const csp = (await fetch(srv.base + '/healthz')).headers.get('content-security-policy');
  assert.match(csp, /challenges\.cloudflare\.com/);
  await srv.close();
});

test('backup script writes a verified copy and prunes old backups', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pwb-'));
  const dbPath = join(dir, 'live.db');
  const db = openDb(dbPath);
  db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES ('keep@example.com','x',1)").run();
  const out = join(dir, 'backups');
  const env = { ...process.env, DATABASE_PATH: dbPath };
  for (let i = 0; i < 3; i++) execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/backup.js', out, '2'], { env });
  const files = readdirSync(out).filter((f) => f.endsWith('.db'));
  assert.equal(files.length, 2);
  const copy = openDb(join(out, files[0]));
  assert.equal(copy.prepare('SELECT email FROM users').get().email, 'keep@example.com');
  copy.close(); db.close();
  rmSync(dir, { recursive: true });
});
