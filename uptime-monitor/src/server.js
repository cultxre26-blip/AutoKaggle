import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { PLANS, planFor } from './plans.js';
import {
  COOKIE, hashPassword, verifyPassword, createSession, userForSession, destroySession,
  cookieHeader, parseCookies, validEmail, createToken, consumeToken,
} from './auth.js';
import { parseTarget } from './ssrf.js';
import { rateLimit } from './rateLimit.js';
import { createMailer } from './mailer.js';
import { createBilling } from './billing.js';
import { startScheduler, applyResult, schedulerHealthy } from './scheduler.js';
import { log } from './log.js';
import { randomUUID } from 'node:crypto';
import { checkSite } from './checker.js';
import { diagnose } from './diagnose.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DUMMY_HASH = hashPassword('timing-equalizer');

export function createApp({ config, db, mailer, billing, verifyCaptcha = defaultVerifyCaptcha(config) }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const turnstile = config.turnstile.siteKey && config.turnstile.secret;
  const csp = ["default-src 'self'", "style-src 'self' 'unsafe-inline'", `script-src 'self'${turnstile ? ' https://challenges.cloudflare.com' : ''}`,
    "img-src 'self' data:", `frame-src ${turnstile ? 'https://challenges.cloudflare.com' : "'none'"}`, `connect-src 'self'`, "frame-ancestors 'none'"].join('; ');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': csp,
      ...(config.secureCookies ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });

  // Request log: method, path (no query string, which can hold one-time tokens), status and timing only.
  app.use((req, res, next) => {
    const started = Date.now();
    const id = randomUUID();
    res.set('X-Request-Id', id);
    res.on('finish', () => {
      if (req.path === '/healthz') return;
      log.info('request', { id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started });
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

  app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300 }));

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
    return { email: u.email, emailVerified: Boolean(u.email_verified), alertWebhookUrl: u.alert_webhook_url || '', plan: u.plan, subscriptionStatus: u.subscription_status, limits: plan, billingEnabled: billing.enabled };
  };

  app.get('/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
    } catch {
      return res.status(503).json({ ok: false, reason: 'database' });
    }
    if (!schedulerHealthy()) return res.status(503).json({ ok: false, reason: 'scheduler' });
    res.json({ ok: true });
  });

  app.get('/api/config', (req, res) => res.json({ captchaSiteKey: turnstile ? config.turnstile.siteKey : '', companyName: config.companyName || 'the operator of this service', supportEmail: config.supportEmail }));

  app.get('/api/plans', (req, res) => res.json(PLANS));

  const sendVerification = (userId, email) => mailer.send({
    to: email,
    subject: 'Confirm your PingWatch email',
    text: `Confirm your email to start monitoring sites:\n\n${config.appUrl}/verify.html?token=${createToken(db, userId, 'verify')}\n\nThis link expires in 24 hours. If you did not sign up, ignore this email.`,
  });

  app.post('/api/signup', authLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    if (turnstile && !(await verifyCaptcha(req.body?.captchaToken, req.ip))) {
      return res.status(400).json({ error: 'Please complete the human check and try again' });
    }
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
      return res.status(400).json({ error: 'Password must be 10 to 200 characters' });
    }
    const normalized = email.trim().toLowerCase();
    try {
      const { lastInsertRowid } = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
        .run(normalized, hashPassword(password), Date.now());
      const userId = Number(lastInsertRowid);
      const token = createSession(db, userId);
      res.set('Set-Cookie', cookieHeader(token, { secure: config.secureCookies }));
      sendVerification(userId, normalized);
      res.status(201).json({ ok: true });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with that email already exists' });
      throw err;
    }
  });

  app.post('/api/verify', authLimiter, (req, res) => {
    const userId = consumeToken(db, req.body?.token, 'verify');
    if (!userId) return res.status(400).json({ error: 'This link is invalid or has expired. Request a new one from your dashboard.' });
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);
    res.json({ ok: true });
  });

  app.post('/api/verify/resend', requireUser, rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }), (req, res) => {
    if (!req.user.email_verified) sendVerification(req.user.id, req.user.email);
    res.json({ ok: true });
  });

  // Always answers the same way so the endpoint cannot be used to discover which emails have accounts.
  app.post('/api/password/forgot', authLimiter, (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const user = email ? db.prepare('SELECT id, email FROM users WHERE email = ?').get(email) : null;
    if (user) {
      mailer.send({
        to: user.email,
        subject: 'Reset your PingWatch password',
        text: `Reset your password:\n\n${config.appUrl}/reset.html?token=${createToken(db, user.id, 'reset')}\n\nThis link expires in 1 hour. If you did not ask for this, ignore this email.`,
      });
    }
    res.json({ ok: true });
  });

  app.post('/api/password/reset', authLimiter, (req, res) => {
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
      return res.status(400).json({ error: 'Password must be 10 to 200 characters' });
    }
    const userId = consumeToken(db, req.body?.token, 'reset');
    if (!userId) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    db.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?').run(hashPassword(password), userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); // sign out everywhere
    res.json({ ok: true });
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

  app.patch('/api/me', requireUser, (req, res) => {
    const raw = req.body?.alertWebhookUrl;
    if (typeof raw !== 'string') return res.status(400).json({ error: 'alertWebhookUrl is required (empty string clears it)' });
    let value = null;
    if (raw.trim()) {
      try { value = parseTarget(raw.trim(), config.allowPrivateTargets).toString(); } catch (err) { return res.status(400).json({ error: err.message }); }
    }
    db.prepare('UPDATE users SET alert_webhook_url = ? WHERE id = ?').run(value, req.user.id);
    res.json(publicUser({ ...req.user, alert_webhook_url: value }));
  });

  // GDPR-style export of everything held about the account.
  app.get('/api/me/export', requireUser, (req, res) => {
    const u = req.user;
    const sites = db.prepare('SELECT id, name, url, keyword, interval_sec, slug, paused, created_at FROM sites WHERE user_id = ?').all(u.id);
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const data = {
      exportedAt: new Date().toISOString(),
      account: { email: u.email, plan: u.plan, subscriptionStatus: u.subscription_status, emailVerified: Boolean(u.email_verified), alertWebhookUrl: u.alert_webhook_url, createdAt: u.created_at },
      sites: sites.map((site) => ({
        ...site,
        incidents: db.prepare('SELECT started_at, resolved_at, reason FROM incidents WHERE site_id = ?').all(site.id),
        checks: db.prepare('SELECT checked_at, ok, status_code, response_ms, error FROM checks WHERE site_id = ? AND checked_at >= ?').all(site.id, since),
      })),
    };
    res.set('Content-Disposition', 'attachment; filename="pingwatch-export.json"');
    res.json(data);
  });

  app.delete('/api/me', requireUser, (req, res) => {
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    res.set('Set-Cookie', cookieHeader('', { secure: config.secureCookies, clear: true }));
    res.json({ ok: true });
  });

  const siteView = (s) => ({
    id: s.id, name: s.name, url: s.url, intervalSec: s.interval_sec, slug: s.slug, paused: Boolean(s.paused),
    keyword: s.keyword || '', status: s.status, lastCheckedAt: s.last_checked_at, sslExpiresAt: s.ssl_expires_at,
  });

  app.get('/api/sites', requireUser, (req, res) => {
    res.json(db.prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY id').all(req.user.id).map(siteView));
  });

  app.post('/api/sites', requireUser, (req, res) => {
    if (!req.user.email_verified) return res.status(403).json({ error: 'Confirm your email address before adding sites. Check your inbox.', code: 'email_unverified' });
    const plan = planFor(req.user);
    const { name, url, intervalSec, keyword } = req.body || {};
    if (keyword != null && (typeof keyword !== 'string' || keyword.length > 100)) return res.status(400).json({ error: 'Keyword must be text of at most 100 characters' });
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
    const { lastInsertRowid } = db.prepare('INSERT INTO sites (user_id, name, url, interval_sec, slug, keyword, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, name.trim(), target.toString(), interval, slug, (keyword || '').trim() || null, Date.now());
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
    const checks = db.prepare('SELECT checked_at, ok, status_code, response_ms, error FROM checks WHERE site_id = ? ORDER BY checked_at DESC LIMIT 100').all(site.id)
      .map((c) => ({ ...c, diagnosis: c.ok ? null : diagnose(c.error) }));
    const incidents = db.prepare('SELECT started_at, resolved_at, reason FROM incidents WHERE site_id = ? ORDER BY started_at DESC LIMIT 20').all(site.id)
      .map((i) => ({ ...i, diagnosis: diagnose(i.reason), durationMs: (i.resolved_at ?? Date.now()) - i.started_at }));
    const ms = checks.filter((c) => c.ok && c.response_ms != null).map((c) => c.response_ms).sort((a, b) => a - b);
    const stats = ms.length ? { avgMs: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length), p95Ms: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] } : null;
    res.json({ checks, incidents, stats });
  });

  // Manual re-check: lets a user confirm a fix without waiting for the next scheduled run.
  app.post('/api/sites/:id/check', requireUser, async (req, res) => {
    const site = db.prepare(
      `SELECT s.*, u.email AS owner_email, u.alert_webhook_url AS owner_webhook FROM sites s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ?`,
    ).get(Number(req.params.id), req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const now = Date.now();
    if (site.last_checked_at && now - site.last_checked_at < 10_000) return res.status(429).json({ error: 'Checked a moment ago, wait a few seconds' });
    const result = await checkSite(site.url, { allowPrivate: config.allowPrivateTargets, keyword: site.keyword });
    await applyResult(db, mailer, site, result, Date.now());
    res.json({ ok: result.ok, statusCode: result.statusCode ?? null, responseMs: result.responseMs, diagnosis: result.ok ? null : diagnose(result.error) });
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
    log.error('unhandled error', { path: req.path, error: err.message });
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const db = openDb(config.databasePath);
  const mailer = createMailer(config.smtp, undefined, { allowPrivate: config.allowPrivateTargets });
  const billing = createBilling(config, db);
  const app = createApp({ config, db, mailer, billing });
  const stopScheduler = startScheduler(db, mailer, config);
  const server = app.listen(config.port, () => log.info('listening', { port: config.port }));
  const shutdown = () => { stopScheduler(); server.close(() => { db.close(); process.exit(0); }); };
  process.on('unhandledRejection', (err) => { log.error('unhandled rejection', { error: String(err) }); });
  process.on('uncaughtException', (err) => { log.error('uncaught exception', { error: err.message }); process.exit(1); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function defaultVerifyCaptcha(config) {
  return async (token, ip) => {
    if (typeof token !== 'string' || !token) return false;
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: new URLSearchParams({ secret: config.turnstile.secret, response: token, remoteip: ip || '' }),
        signal: AbortSignal.timeout(5000),
      });
      return (await res.json()).success === true;
    } catch {
      return false; // fail closed
    }
  };
}
