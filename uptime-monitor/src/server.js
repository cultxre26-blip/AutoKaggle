import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { PLANS, planFor } from './plans.js';
import {
  COOKIE, hashPassword, verifyPassword, createSession, userForSession, destroySession,
  cookieHeader, parseCookies, validEmail,
} from './auth.js';
import { parseTarget } from './ssrf.js';
import { rateLimit } from './rateLimit.js';
import { createMailer } from './mailer.js';
import { createBilling } from './billing.js';
import { startScheduler } from './scheduler.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DUMMY_HASH = hashPassword('timing-equalizer');

export function createApp({ config, db, mailer, billing }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
    });
    next();
  });

  // Stripe needs the raw body for signature verification, so this route precedes express.json().
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    try {
      res.json({ result: billing.verifyAndHandle(req.body, req.get('stripe-signature')) });
    } catch (err) {
      res.status(err.status || 400).json({ error: 'Webhook rejected' });
    }
  });

  app.use(express.json({ limit: '10kb' }));

  // CSRF defence: cookies are SameSite=Lax, and state-changing requests must be same-origin JSON.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin && origin !== new URL(config.appUrl).origin) return res.status(403).json({ error: 'Cross-origin request blocked' });
    if (req.is('application/json') === false) return res.status(415).json({ error: 'JSON required' });
    next();
  });

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

  const sessionToken = (req) => parseCookies(req.get('cookie'))[COOKIE];
  const requireUser = (req, res, next) => {
    const user = userForSession(db, sessionToken(req));
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    req.user = user;
    next();
  };

  const publicUser = (u) => {
    const plan = planFor(u);
    return { email: u.email, plan: u.plan, subscriptionStatus: u.subscription_status, limits: plan, billingEnabled: billing.enabled };
  };

  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  app.get('/api/plans', (req, res) => res.json(PLANS));

  app.post('/api/signup', authLimiter, (req, res) => {
    const { email, password } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
      return res.status(400).json({ error: 'Password must be 10 to 200 characters' });
    }
    const normalized = email.trim().toLowerCase();
    try {
      const { lastInsertRowid } = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
        .run(normalized, hashPassword(password), Date.now());
      const token = createSession(db, Number(lastInsertRowid));
      res.set('Set-Cookie', cookieHeader(token, { secure: config.secureCookies }));
      res.status(201).json({ ok: true });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with that email already exists' });
      throw err;
    }
  });

  app.post('/api/login', authLimiter, (req, res) => {
    const { email, password } = req.body || {};
    const user = typeof email === 'string' ? db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) : null;
    const ok = verifyPassword(typeof password === 'string' ? password : '', user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: 'Incorrect email or password' });
    res.set('Set-Cookie', cookieHeader(createSession(db, user.id), { secure: config.secureCookies }));
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    destroySession(db, sessionToken(req));
    res.set('Set-Cookie', cookieHeader('', { secure: config.secureCookies, clear: true }));
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => res.json(publicUser(req.user)));

  app.delete('/api/me', requireUser, (req, res) => {
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    res.set('Set-Cookie', cookieHeader('', { secure: config.secureCookies, clear: true }));
    res.json({ ok: true });
  });

  const siteView = (s) => ({
    id: s.id, name: s.name, url: s.url, intervalSec: s.interval_sec, slug: s.slug, paused: Boolean(s.paused),
    status: s.status, lastCheckedAt: s.last_checked_at, sslExpiresAt: s.ssl_expires_at,
  });

  app.get('/api/sites', requireUser, (req, res) => {
    res.json(db.prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY id').all(req.user.id).map(siteView));
  });

  app.post('/api/sites', requireUser, (req, res) => {
    const plan = planFor(req.user);
    const { name, url, intervalSec } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.length > 80) return res.status(400).json({ error: 'Name is required (max 80 characters)' });
    let target;
    try { target = parseTarget(url, config.allowPrivateTargets); } catch (err) { return res.status(400).json({ error: err.message }); }
    const count = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE user_id = ?').get(req.user.id).n;
    if (count >= plan.maxSites) return res.status(402).json({ error: `Your ${plan.name} plan allows ${plan.maxSites} site(s). Upgrade to add more.` });
    const interval = Number(intervalSec) || plan.minIntervalSec;
    if (interval < plan.minIntervalSec || interval > 3600) {
      return res.status(400).json({ error: `Check interval must be between ${plan.minIntervalSec} and 3600 seconds on your plan` });
    }
    const slug = randomBytes(9).toString('base64url');
    const { lastInsertRowid } = db.prepare('INSERT INTO sites (user_id, name, url, interval_sec, slug, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, name.trim(), target.toString(), interval, slug, Date.now());
    res.status(201).json(siteView(db.prepare('SELECT * FROM sites WHERE id = ?').get(lastInsertRowid)));
  });

  app.patch('/api/sites/:id', requireUser, (req, res) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    if (typeof req.body?.paused === 'boolean') db.prepare('UPDATE sites SET paused = ? WHERE id = ?').run(req.body.paused ? 1 : 0, site.id);
    res.json(siteView(db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id)));
  });

  app.delete('/api/sites/:id', requireUser, (req, res) => {
    const r = db.prepare('DELETE FROM sites WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Site not found' });
    res.json({ ok: true });
  });

  app.get('/api/sites/:id/checks', requireUser, (req, res) => {
    const site = db.prepare('SELECT id FROM sites WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const checks = db.prepare('SELECT checked_at, ok, status_code, response_ms, error FROM checks WHERE site_id = ? ORDER BY checked_at DESC LIMIT 100').all(site.id);
    const incidents = db.prepare('SELECT started_at, resolved_at, reason FROM incidents WHERE site_id = ? ORDER BY started_at DESC LIMIT 20').all(site.id);
    res.json({ checks, incidents });
  });

  // Public status data: unguessable slug, no URL or owner details exposed.
  app.get('/api/status/:slug', (req, res) => {
    const s = db.prepare('SELECT id, name, status, last_checked_at FROM sites WHERE slug = ?').get(req.params.slug);
    if (!s) return res.status(404).json({ error: 'Not found' });
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const stats = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS up FROM checks WHERE site_id = ? AND checked_at >= ?').get(s.id, since);
    res.json({ name: s.name, status: s.status, lastCheckedAt: s.last_checked_at, uptime30d: stats.total ? Math.round((stats.up / stats.total) * 10000) / 100 : null });
  });
  app.get('/status/:slug', (req, res) => res.sendFile(join(publicDir, 'status.html')));

  app.post('/api/billing/checkout', requireUser, async (req, res) => {
    try { res.json({ url: await billing.checkoutUrl(req.user, req.body?.plan) }); }
    catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not start checkout' }); }
  });
  app.post('/api/billing/portal', requireUser, async (req, res) => {
    try { res.json({ url: await billing.portalUrl(req.user) }); }
    catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not open billing portal' }); }
  });

  app.use(express.static(publicDir, { extensions: ['html'] }));

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const db = openDb(config.databasePath);
  const mailer = createMailer(config.smtp);
  const billing = createBilling(config, db);
  const app = createApp({ config, db, mailer, billing });
  const stopScheduler = startScheduler(db, mailer, config);
  const server = app.listen(config.port, () => console.log(`PingWatch listening on ${config.port}`));
  const shutdown = () => { stopScheduler(); server.close(() => { db.close(); process.exit(0); }); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
