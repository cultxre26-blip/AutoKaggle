import { checkSite } from './checker.js';
import { planFor } from './plans.js';
import { diagnose } from './diagnose.js';

const FAILURES_BEFORE_DOWN = 2;
const SSL_THRESHOLDS = [3, 7, 14]; // days, most urgent first
const RETENTION_MS = 30 * 24 * 3600 * 1000;
const CONCURRENCY = 10;
const DAY_MS = 24 * 3600 * 1000;

// Entitlements are enforced here, so a lapsed subscription stops using paid capacity
// (extra sites beyond the plan limit and sub-minimum intervals) without deleting data.
export function dueSites(db, now) {
  const rows = db.prepare(
    `SELECT s.*, u.email AS owner_email, u.alert_webhook_url AS owner_webhook, u.plan AS owner_plan, u.subscription_status
     FROM sites s JOIN users u ON u.id = s.user_id
     WHERE s.paused = 0 ORDER BY s.user_id, s.id`,
  ).all();
  const seen = new Map();
  return rows.filter((s) => {
    const plan = planFor({ plan: s.owner_plan, subscription_status: s.subscription_status });
    const rank = (seen.get(s.user_id) ?? 0) + 1;
    seen.set(s.user_id, rank);
    if (rank > plan.maxSites) return false;
    const interval = Math.max(s.interval_sec, plan.minIntervalSec);
    return s.last_checked_at === null || s.last_checked_at + interval * 1000 <= now;
  });
}

export async function applyResult(db, mailer, site, result, now) {
  db.prepare('INSERT INTO checks (site_id, checked_at, ok, status_code, response_ms, error) VALUES (?, ?, ?, ?, ?, ?)')
    .run(site.id, now, result.ok ? 1 : 0, result.statusCode ?? null, result.responseMs, result.error ?? null);

  let status = site.status;
  let failures = result.ok ? 0 : site.consecutive_failures + 1;
  const mails = [];
  const diagnosis = result.ok ? null : diagnose(result.error);

  if (result.ok) {
    if (site.status === 'down') {
      db.prepare('UPDATE incidents SET resolved_at = ? WHERE site_id = ? AND resolved_at IS NULL').run(now, site.id);
      mails.push({ event: 'recovered', subject: `[Recovered] ${site.name} is back up`, text: `${site.name} (${site.url}) is responding again.` });
    }
    status = 'up';
  } else if (failures >= FAILURES_BEFORE_DOWN && site.status !== 'down') {
    status = 'down';
    db.prepare('INSERT INTO incidents (site_id, started_at, reason, diagnosis_code) VALUES (?, ?, ?, ?)').run(site.id, now, result.error, diagnosis.code);
    mails.push({
      event: 'down',
      subject: `[Down] ${site.name}: ${diagnosis.title}`,
      text: `${site.name} (${site.url}) failed ${failures} checks in a row.\n\nLikely cause: ${diagnosis.title}\nWhat to try: ${diagnosis.fix}\n\nTechnical detail: ${result.error}`,
    });
  }

  let sslAlertLevel = site.ssl_alert_level;
  if (result.sslExpiresAt) {
    const daysLeft = Math.floor((result.sslExpiresAt - now) / DAY_MS);
    const level = SSL_THRESHOLDS.find((t) => daysLeft <= t) ?? 0;
    if (level === 0) sslAlertLevel = 0;
    else if (sslAlertLevel === 0 || level < sslAlertLevel) {
      sslAlertLevel = level;
      mails.push({
        event: 'ssl_expiring',
        subject: `[SSL] Certificate for ${site.name} expires in ${Math.max(daysLeft, 0)} days`,
        text: `The TLS certificate for ${site.url} expires on ${new Date(result.sslExpiresAt).toUTCString()}.`,
      });
    }
  }

  db.prepare(
    `UPDATE sites SET status = ?, consecutive_failures = ?, last_checked_at = ?,
     ssl_expires_at = COALESCE(?, ssl_expires_at), ssl_alert_level = ? WHERE id = ?`,
  ).run(status, failures, now, result.sslExpiresAt ?? null, sslAlertLevel, site.id);

  for (const m of mails) {
    await mailer.send({ to: site.owner_email, subject: m.subject, text: m.text });
    if (site.owner_webhook && mailer.webhook) {
      await mailer.webhook(site.owner_webhook, {
        text: `${m.subject}\n${m.text}`, event: m.event, site: site.name, url: site.url, diagnosis: m.event === 'down' ? diagnosis : undefined,
      });
    }
  }
}

export async function runDueChecks(db, mailer, config, now = Date.now(), check = checkSite) {
  const queue = dueSites(db, now);
  let index = 0;
  const worker = async () => {
    while (index < queue.length) {
      const site = queue[index++];
      try {
        const result = await check(site.url, { allowPrivate: config.allowPrivateTargets, keyword: site.keyword });
        await applyResult(db, mailer, site, result, now);
      } catch (err) {
        console.error(`check failed for site ${site.id}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return queue.length;
}

export function pruneOldChecks(db, now = Date.now()) {
  db.prepare('DELETE FROM checks WHERE checked_at < ?').run(now - RETENTION_MS);
}

export function startScheduler(db, mailer, config) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runDueChecks(db, mailer, config); } finally { running = false; }
  };
  const t1 = setInterval(tick, 15_000);
  const t2 = setInterval(() => pruneOldChecks(db), DAY_MS);
  tick();
  return () => { clearInterval(t1); clearInterval(t2); };
}
