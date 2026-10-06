import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SMTPServer } from 'smtp-server';
import Stripe from 'stripe';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createBilling } from '../src/billing.js';
import { createMailer } from '../src/mailer.js';
import { listen, client } from './helpers.js';

// A minimal fake of the Stripe REST API, driven through the real Stripe SDK.
async function fakeStripe() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url, body: new URLSearchParams(body), auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/customers') return res.end(JSON.stringify({ id: 'cus_fake1' }));
      if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/c/cs_1' }));
      if (req.url === '/v1/billing_portal/sessions') return res.end(JSON.stringify({ id: 'bps_1', url: 'https://billing.stripe.test/p/1' }));
      res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'unexpected ' + req.url } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

const stripeEnv = { APP_URL: 'http://localhost:3000', ALLOW_PRIVATE_TARGETS: '1', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_testsecret', STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_TEAM: 'price_team' };

async function stripeApp() {
  const fake = await fakeStripe();
  const config = loadConfig(stripeEnv);
  const db = openDb(':memory:');
  const billing = createBilling(config, db, { host: '127.0.0.1', port: fake.port, protocol: 'http', maxNetworkRetries: 0 });
  const app = createApp({ config, db, mailer: { async send() {}, async webhook() {} }, billing });
  return { fake, db, srv: await listen(app) };
}

test('checkout creates a Stripe customer once and returns the hosted checkout URL', async () => {
  const { fake, db, srv } = await stripeApp();
  const c = client(srv.base);
  await c('/api/signup', 'POST', { email: 'pay@example.com', password: 'correct-horse-battery' });
  const r = await c('/api/billing/checkout', 'POST', { plan: 'pro' });
  assert.equal(r.status, 200);
  assert.equal(r.body.url, 'https://checkout.stripe.test/c/cs_1');
  await c('/api/billing/checkout', 'POST', { plan: 'team' });
  const customerCalls = fake.calls.filter((x) => x.path === '/v1/customers');
  assert.equal(customerCalls.length, 1, 'customer reused on second checkout');
  assert.equal(customerCalls[0].body.get('email'), 'pay@example.com');
  const checkout = fake.calls.filter((x) => x.path === '/v1/checkout/sessions')[0];
  assert.equal(checkout.body.get('mode'), 'subscription');
  assert.equal(checkout.body.get('customer'), 'cus_fake1');
  assert.equal(checkout.body.get('line_items[0][price]'), 'price_pro');
  assert.equal(checkout.body.get('success_url'), 'http://localhost:3000/dashboard.html?billing=success');
  assert.match(checkout.auth, /Bearer sk_test_fake/);
  assert.equal(db.prepare('SELECT stripe_customer_id FROM users').get().stripe_customer_id, 'cus_fake1');
  assert.equal((await c('/api/billing/checkout', 'POST', { plan: 'free' })).status, 400);
  assert.equal((await c('/api/billing/checkout', 'POST', { plan: 'enterprise' })).status, 400);
  const portal = await c('/api/billing/portal', 'POST', {});
  assert.equal(portal.body.url, 'https://billing.stripe.test/p/1');
  await srv.close(); await fake.close();
});

test('signed webhook over HTTP upgrades the plan; bad or missing signatures are rejected; replays are ignored', async () => {
  const { fake, db, srv } = await stripeApp();
  db.prepare("INSERT INTO users (id, email, password_hash, stripe_customer_id, created_at) VALUES (1,'p@example.com','x','cus_fake1',0)").run();
  const stripe = new Stripe('sk_test_fake');
  const event = { id: 'evt_http_1', object: 'event', type: 'customer.subscription.created',
    data: { object: { id: 'sub_1', customer: 'cus_fake1', status: 'active', items: { data: [{ price: { id: 'price_team' } }] } } } };
  const payload = JSON.stringify(event);
  const sign = (body, secret = 'whsec_testsecret') => stripe.webhooks.generateTestHeaderString({ payload: body, secret });
  const post = (body, sig) => fetch(srv.base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'Stripe-Signature': sig } : {}) }, body });

  assert.equal((await post(payload)).status, 400, 'missing signature');
  assert.equal((await post(payload, sign(payload, 'whsec_wrong'))).status, 400, 'wrong secret');
  assert.equal((await post(payload, sign(payload + ' '))).status, 400, 'signature over different body');
  assert.equal(db.prepare('SELECT plan FROM users').get().plan, 'free');

  const ok = await post(payload, sign(payload));
  assert.equal(ok.status, 200);
  assert.equal(db.prepare('SELECT plan, subscription_status FROM users').get().plan, 'team');
  const replay = await post(payload, sign(payload));
  assert.deepEqual(await replay.json(), { result: 'duplicate' });
  await srv.close(); await fake.close();
});

test('real SMTP delivery: verification email arrives with a working link', async () => {
  const received = [];
  const smtp = new SMTPServer({
    authOptional: true, disabledCommands: ['STARTTLS'],
    onData(stream, session, cb) { let d = ''; stream.on('data', (c) => (d += c)); stream.on('end', () => { received.push({ data: d, to: session.envelope.rcptTo.map((r) => r.address) }); cb(); }); },
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  const config = loadConfig({ APP_URL: 'http://localhost:3000', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.server.address().port), MAIL_FROM: 'PingWatch <alerts@pw.example.com>' });
  const db = openDb(':memory:');
  const mailer = createMailer(config.smtp);
  const srv = await listen(createApp({ config, db, mailer, billing: createBilling(config, db) }));
  const c = client(srv.base);
  await c('/api/signup', 'POST', { email: 'real@example.com', password: 'correct-horse-battery' });
  for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].to, ['real@example.com']);
  assert.match(received[0].data, /From: PingWatch <alerts@pw\.example\.com>/);
  assert.match(received[0].data, /Subject: Confirm your PingWatch email/);
  const decoded = received[0].data.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const token = decoded.match(/verify\.html\?token=([\w-]+)/)[1];
  assert.equal((await c('/api/verify', 'POST', { token })).status, 200);
  await srv.close(); await new Promise((r) => smtp.close(r));
});

test('SMTP failure never breaks signup', async () => {
  const config = loadConfig({ APP_URL: 'http://localhost:3000', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' });
  const db = openDb(':memory:');
  const srv = await listen(createApp({ config, db, mailer: createMailer(config.smtp, { log() {}, error() {} }), billing: createBilling(config, db) }));
  assert.equal((await client(srv.base)('/api/signup', 'POST', { email: 'x@example.com', password: 'correct-horse-battery' })).status, 201);
  await srv.close();
});
