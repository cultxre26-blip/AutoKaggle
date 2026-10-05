import Stripe from 'stripe';
import { PLANS } from './plans.js';

export function createBilling(config, db, stripeOptions = {}) {
  const enabled = Boolean(config.stripe.secretKey);
  const stripe = enabled ? new Stripe(config.stripe.secretKey, stripeOptions) : null;
  const priceToPlan = Object.fromEntries(
    Object.entries(config.stripe.prices).filter(([, id]) => id).map(([plan, id]) => [id, plan]),
  );

  async function checkoutUrl(user, plan) {
    if (!enabled) throw Object.assign(new Error('Billing is not configured'), { status: 503 });
    const price = config.stripe.prices[plan];
    if (!PLANS[plan] || plan === 'free' || !price) throw Object.assign(new Error('Unknown plan'), { status: 400 });
    let customer = user.stripe_customer_id;
    if (!customer) {
      customer = (await stripe.customers.create({ email: user.email, metadata: { user_id: String(user.id) } })).id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customer, user.id);
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [{ price, quantity: 1 }],
      success_url: `${config.appUrl}/dashboard.html?billing=success`,
      cancel_url: `${config.appUrl}/dashboard.html?billing=cancelled`,
    });
    return session.url;
  }

  async function portalUrl(user) {
    if (!enabled || !user.stripe_customer_id) throw Object.assign(new Error('No billing account yet'), { status: 400 });
    const s = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${config.appUrl}/dashboard.html`,
    });
    return s.url;
  }

  function applySubscription(sub) {
    const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    const plan = priceToPlan[sub.items.data[0]?.price?.id] || 'free';
    const status = sub.status === 'active' || sub.status === 'trialing' ? sub.status : sub.status;
    db.prepare('UPDATE users SET plan = ?, subscription_status = ?, stripe_subscription_id = ? WHERE stripe_customer_id = ?')
      .run(plan, status, sub.id, customer);
  }

  // Idempotent: Stripe retries deliveries, so each event id is processed once.
  function handleEvent(event, now = Date.now()) {
    const seen = db.prepare('INSERT OR IGNORE INTO webhook_events (id, received_at) VALUES (?, ?)').run(event.id, now);
    if (seen.changes === 0) return 'duplicate';
    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      applySubscription(event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      db.prepare("UPDATE users SET plan = 'free', subscription_status = 'canceled', stripe_subscription_id = NULL WHERE stripe_customer_id = ?").run(customer);
    }
    return 'processed';
  }

  function verifyAndHandle(rawBody, signature) {
    if (!enabled || !config.stripe.webhookSecret) throw Object.assign(new Error('Billing is not configured'), { status: 503 });
    const event = stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
    return handleEvent(event);
  }

  return { enabled, checkoutUrl, portalUrl, handleEvent, verifyAndHandle };
}
