import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './helpers.js';
import { planFor } from '../src/plans.js';

function user(ctx) {
  ctx.db.prepare("INSERT INTO users (id, email, password_hash, stripe_customer_id, created_at) VALUES (1,'b@example.com','x','cus_1',0)").run();
}
const sub = (status, price = 'price_pro') => ({ id: 'sub_1', customer: 'cus_1', status, items: { data: [{ price: { id: price } }] } });
const get = (ctx) => ctx.db.prepare('SELECT * FROM users WHERE id = 1').get();

test('subscription webhook upgrades, downgrades on cancel, and is idempotent', () => {
  const ctx = makeCtx();
  user(ctx);
  assert.equal(ctx.billing.handleEvent({ id: 'evt_1', type: 'customer.subscription.created', data: { object: sub('active') } }), 'processed');
  assert.equal(get(ctx).plan, 'pro');
  assert.equal(planFor(get(ctx)).maxSites, 10);
  assert.equal(ctx.billing.handleEvent({ id: 'evt_1', type: 'customer.subscription.created', data: { object: sub('active', 'price_team') } }), 'duplicate');
  assert.equal(get(ctx).plan, 'pro', 'replayed event ignored');
  ctx.billing.handleEvent({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: sub('active', 'price_team') } });
  assert.equal(get(ctx).plan, 'team');
  ctx.billing.handleEvent({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: sub('canceled') } });
  assert.equal(planFor(get(ctx)).name, 'Free');
});

test('past_due or unpaid subscriptions lose paid entitlements', () => {
  const ctx = makeCtx();
  user(ctx);
  ctx.billing.handleEvent({ id: 'evt_4', type: 'customer.subscription.updated', data: { object: sub('past_due') } });
  assert.equal(planFor(get(ctx)).name, 'Free');
});

test('webhook endpoint rejects unsigned requests and billing is off without keys', async () => {
  const ctx = makeCtx();
  assert.throws(() => ctx.billing.verifyAndHandle(Buffer.from('{}'), 'sig'), /not configured/);
  assert.equal(ctx.billing.enabled, false);
  await assert.rejects(ctx.billing.checkoutUrl({ id: 1, email: 'x' }, 'pro'), /not configured/);
});
