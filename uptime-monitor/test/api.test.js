import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, listen, client } from './helpers.js';

const creds = { email: 'a@example.com', password: 'correct-horse-battery' };

test('signup, session, logout and login flow', async () => {
  const ctx = makeCtx();
  const srv = await listen(ctx.app);
  const c = client(srv.base);
  assert.equal((await c('/api/me')).status, 401);
  assert.equal((await c('/api/signup', 'POST', creds)).status, 201);
  assert.equal((await c('/api/me')).body.email, 'a@example.com');
  assert.equal((await c('/api/signup', 'POST', creds)).status, 409);
  await c('/api/logout', 'POST', {});
  assert.equal((await c('/api/me')).status, 401);
  assert.equal((await c('/api/login', 'POST', { ...creds, password: 'wrong-password-1' })).status, 401);
  assert.equal((await c('/api/login', 'POST', creds)).status, 200);
  await srv.close();
});

test('rejects weak passwords, bad email, cross-origin and non-JSON writes', async () => {
  const ctx = makeCtx();
  const srv = await listen(ctx.app);
  const c = client(srv.base);
  assert.equal((await c('/api/signup', 'POST', { email: 'a@example.com', password: 'short' })).status, 400);
  assert.equal((await c('/api/signup', 'POST', { email: 'nope', password: 'correct-horse-battery' })).status, 400);
  assert.equal((await c('/api/signup', 'POST', creds, { Origin: 'https://evil.example' })).status, 403);
  const res = await fetch(srv.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
  await srv.close();
});

test('free plan limits sites; sites are isolated per user', async () => {
  const ctx = makeCtx();
  const srv = await listen(ctx.app);
  const a = client(srv.base);
  await a('/api/signup', 'POST', creds);
  ctx.db.exec('UPDATE users SET email_verified = 1');
  const first = await a('/api/sites', 'POST', { name: 'One', url: 'https://example.com' });
  assert.equal(first.status, 201);
  assert.equal((await a('/api/sites', 'POST', { name: 'Two', url: 'https://example.org' })).status, 402);
  assert.equal((await a('/api/sites', 'POST', { name: 'Fast', url: 'https://example.net', intervalSec: 30 })).status, 402);
  const b = client(srv.base);
  await b('/api/signup', 'POST', { email: 'b@example.com', password: 'correct-horse-battery' });
  assert.equal((await b('/api/sites')).body.length, 0);
  assert.equal((await b(`/api/sites/${first.body.id}`, 'DELETE')).status, 404);
  assert.equal((await b(`/api/sites/${first.body.id}/checks`)).status, 404);
  await srv.close();
});

test('site validation blocks private targets when not allowed', async () => {
  const ctx = makeCtx({ ALLOW_PRIVATE_TARGETS: '0' });
  const srv = await listen(ctx.app);
  const c = client(srv.base);
  await c('/api/signup', 'POST', creds);
  ctx.db.exec('UPDATE users SET email_verified = 1');
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest', 'http://[::1]/', 'ftp://example.com', 'javascript:alert(1)', 'https://u:p@example.com']) {
    assert.equal((await c('/api/sites', 'POST', { name: 'x', url })).status, 400, url);
  }
  await srv.close();
});

test('public status page exposes no owner or URL data', async () => {
  const ctx = makeCtx();
  const srv = await listen(ctx.app);
  const c = client(srv.base);
  await c('/api/signup', 'POST', creds);
  ctx.db.exec('UPDATE users SET email_verified = 1');
  const site = (await c('/api/sites', 'POST', { name: 'Shop', url: 'https://example.com' })).body;
  const pub = await client(srv.base)(`/api/status/${site.slug}`);
  assert.deepEqual(Object.keys(pub.body).sort(), ['lastCheckedAt', 'name', 'status', 'uptime30d']);
  assert.equal((await client(srv.base)('/api/status/nope')).status, 404);
  await srv.close();
});

test('account deletion removes user data', async () => {
  const ctx = makeCtx();
  const srv = await listen(ctx.app);
  const c = client(srv.base);
  await c('/api/signup', 'POST', creds);
  ctx.db.exec('UPDATE users SET email_verified = 1');
  await c('/api/sites', 'POST', { name: 'Shop', url: 'https://example.com' });
  assert.equal((await c('/api/me', 'DELETE')).status, 200);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM sites').get().n, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  await srv.close();
});

test('security headers and health check', async () => {
  const ctx = makeCtx();
  const srv = await listen(ctx.app);
  const res = await fetch(srv.base + '/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('content-security-policy').includes("default-src 'self'"));
  await srv.close();
});
