import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeCtx } from './helpers.js';
import { checkSite } from '../src/checker.js';
import { runDueChecks } from '../src/scheduler.js';
import { isPrivateAddress } from '../src/ssrf.js';

function target(handler) {
  const server = http.createServer(handler);
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((x) => server.close(x)) })));
}

function seed(ctx, { plan = 'free', status = 'none' } = {}) {
  const u = ctx.db.prepare("INSERT INTO users (email, password_hash, plan, subscription_status, created_at) VALUES ('o@example.com','x',?,?,0)").run(plan, status);
  return Number(u.lastInsertRowid);
}
function addSite(ctx, userId, url, slug = 's' + Math.random()) {
  return Number(ctx.db.prepare("INSERT INTO sites (user_id, name, url, slug, created_at) VALUES (?, 'Site', ?, ?, 0)").run(userId, url, slug).lastInsertRowid);
}

test('private address detection', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('checker blocks private targets unless allowed', async () => {
  const t = await target((q, r) => r.end('ok'));
  const blocked = await checkSite(t.url, { allowPrivate: false });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /private|reserved/i);
  assert.equal((await checkSite(t.url, { allowPrivate: true })).ok, true);
  await t.close();
});

test('checker reports HTTP errors and timeouts', async () => {
  const t = await target((q, r) => { r.statusCode = 503; r.end(); });
  const res = await checkSite(t.url, { allowPrivate: true });
  assert.deepEqual([res.ok, res.statusCode], [false, 503]);
  await t.close();
  const slow = await target(() => {});
  const timeout = await checkSite(slow.url, { allowPrivate: true, timeoutMs: 200 });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /Timed out/);
  slow.close();
});

test('two failures open an incident and alert once; recovery resolves it', async () => {
  const ctx = makeCtx();
  const id = addSite(ctx, seed(ctx), 'http://x');
  let ok = false;
  const fake = async () => (ok ? { ok: true, statusCode: 200, responseMs: 5 } : { ok: false, statusCode: null, responseMs: 5, error: 'ECONNREFUSED' });
  let now = 1_000_000;
  const step = async () => { await runDueChecks(ctx.db, ctx.mailer, ctx.config, now, fake); now += 10 * 60_000; };
  await step();
  assert.equal(ctx.sent.length, 0, 'one failure is not an outage');
  await step();
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0].subject, /Down/);
  await step();
  assert.equal(ctx.sent.length, 1, 'no repeat alerts while down');
  ok = true;
  await step();
  assert.equal(ctx.sent.length, 2);
  assert.match(ctx.sent[1].subject, /Recovered/);
  const inc = ctx.db.prepare('SELECT * FROM incidents WHERE site_id = ?').all(id);
  assert.equal(inc.length, 1);
  assert.ok(inc[0].resolved_at);
});

test('SSL expiry alerts once per threshold and resets after renewal', async () => {
  const ctx = makeCtx();
  addSite(ctx, seed(ctx), 'http://x');
  const day = 24 * 3600 * 1000;
  let now = 5_000_000_000;
  let expires = now + 10 * day;
  const fake = async () => ({ ok: true, statusCode: 200, responseMs: 5, sslExpiresAt: expires });
  const step = async (advance = 10 * 60_000) => { await runDueChecks(ctx.db, ctx.mailer, ctx.config, now, fake); now += advance; };
  await step(); await step();
  assert.equal(ctx.sent.filter((m) => /SSL/.test(m.subject)).length, 1);
  expires = now + 2 * day;
  await step();
  assert.equal(ctx.sent.filter((m) => /SSL/.test(m.subject)).length, 2, 'escalates at 3 days');
  expires = now + 90 * day;
  await step(); await step();
  expires = now + 5 * day;
  await step();
  assert.equal(ctx.sent.filter((m) => /SSL/.test(m.subject)).length, 3, 're-arms after renewal');
});

test('lapsed plans only monitor the allowed number of sites', async () => {
  const ctx = makeCtx();
  const uid = seed(ctx, { plan: 'pro', status: 'canceled' });
  addSite(ctx, uid, 'http://a'); addSite(ctx, uid, 'http://b'); addSite(ctx, uid, 'http://c');
  const n = await runDueChecks(ctx.db, ctx.mailer, ctx.config, 1_000_000, async () => ({ ok: true, statusCode: 200, responseMs: 1 }));
  assert.equal(n, 1);
});
