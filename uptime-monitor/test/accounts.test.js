import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, listen, client } from './helpers.js';
import { createToken, consumeToken } from '../src/auth.js';

const creds = { email: 'a@example.com', password: 'correct-horse-battery' };
const tokenFrom = (mail) => mail.text.match(/token=([\w-]+)/)[1];

test('signup sends a verification email; unverified users cannot add sites until they confirm', async () => {
  const ctx = makeCtx();
  const srv = await listen(ctx.app);
  const c = client(srv.base);
  await c('/api/signup', 'POST', creds);
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0].subject, /Confirm/);
  assert.equal((await c('/api/me')).body.emailVerified, false);
  const blocked = await c('/api/sites', 'POST', { name: 'x', url: 'https://example.com' });
  assert.deepEqual([blocked.status, blocked.body.code], [403, 'email_unverified']);

  const token = tokenFrom(ctx.sent[0]);
  assert.equal((await c('/api/verify', 'POST', { token: 'bogus' })).status, 400);
  assert.equal((await c('/api/verify', 'POST', { token })).status, 200);
  assert.equal((await c('/api/verify', 'POST', { token })).status, 400, 'token is single-use');
  assert.equal((await c('/api/me')).body.emailVerified, true);
  assert.equal((await c('/api/sites', 'POST', { name: 'x', url: 'https://example.com' })).status, 201);
  await srv.close();
});

test('resend sends a fresh link only to unverified users and invalidates the old one', async () => {
  const ctx = makeCtx();
  const srv = await listen(ctx.app);
  const c = client(srv.base);
  await c('/api/signup', 'POST', creds);
  const first = tokenFrom(ctx.sent[0]);
  await c('/api/verify/resend', 'POST', {});
  assert.equal(ctx.sent.length, 2);
  assert.equal((await c('/api/verify', 'POST', { token: first })).status, 400);
  assert.equal((await c('/api/verify', 'POST', { token: tokenFrom(ctx.sent[1]) })).status, 200);
  await c('/api/verify/resend', 'POST', {});
  assert.equal(ctx.sent.length, 2, 'nothing sent once verified');
  await srv.close();
});

test('forgot password never reveals whether an account exists', async () => {
  const ctx = makeCtx();
  const srv = await listen(ctx.app);
  const c = client(srv.base);
  await c('/api/signup', 'POST', creds);
  ctx.sent.length = 0;
  const known = await client(srv.base)('/api/password/forgot', 'POST', { email: 'A@Example.com' });
  const unknown = await client(srv.base)('/api/password/forgot', 'POST', { email: 'nobody@example.com' });
  assert.deepEqual([known.status, known.body], [unknown.status, unknown.body]);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].to, 'a@example.com');
  await srv.close();
});

test('password reset changes the password, signs out other sessions and is single-use', async () => {
  const ctx = makeCtx();
  const srv = await listen(ctx.app);
  const c = client(srv.base);
  await c('/api/signup', 'POST', creds);
  ctx.sent.length = 0;
  await client(srv.base)('/api/password/forgot', 'POST', { email: creds.email });
  const token = tokenFrom(ctx.sent[0]);
  const anon = client(srv.base);
  assert.equal((await anon('/api/password/reset', 'POST', { token, password: 'short' })).status, 400);
  assert.equal((await anon('/api/password/reset', 'POST', { token: 'nope', password: 'brand-new-password' })).status, 400);
  assert.equal((await anon('/api/password/reset', 'POST', { token, password: 'brand-new-password' })).status, 200);
  assert.equal((await anon('/api/password/reset', 'POST', { token, password: 'another-password-1' })).status, 400, 'single-use');
  assert.equal((await c('/api/me')).status, 401, 'old session revoked');
  assert.equal((await anon('/api/login', 'POST', creds)).status, 401);
  assert.equal((await anon('/api/login', 'POST', { email: creds.email, password: 'brand-new-password' })).status, 200);
  await srv.close();
});

test('expired tokens and purposes are not interchangeable', () => {
  const ctx = makeCtx();
  ctx.db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (1,'a@example.com','x',0)").run();
  const t = createToken(ctx.db, 1, 'reset', 1000);
  assert.equal(consumeToken(ctx.db, t, 'verify', 2000), null);
  const t2 = createToken(ctx.db, 1, 'reset', 1000);
  assert.equal(consumeToken(ctx.db, t2, 'reset', 1000 + 3600 * 1000 + 1), null, 'expired');
  const t3 = createToken(ctx.db, 1, 'reset', 1000);
  assert.equal(consumeToken(ctx.db, t3, 'reset', 2000), 1);
});
