# PingWatch

A small uptime and SSL-expiry monitor sold as a monthly subscription. Node 22, Express, SQLite (`node:sqlite`), Stripe, nodemailer. Three runtime dependencies.

## What it does
- Sign up and sign in (scrypt password hashes, hashed server-side session tokens, HttpOnly SameSite cookies).
- Email verification (required before adding sites, which also stops the service being used to probe arbitrary URLs by throwaway accounts) and password reset. Links are single-use, hashed at rest, and expire after 24 hours (verify) or 1 hour (reset). Resetting signs the user out everywhere. The forgot-password endpoint never reveals whether an email has an account.
- Monitor URLs on a schedule. A site is marked down after 2 consecutive failures, then one alert email is sent; a recovery email follows.
- SSL certificate expiry warnings at 14, 7 and 3 days, re-armed after renewal.
- Failure diagnosis: every failure is mapped to a plain-English cause and a suggested fix (DNS, refused, timeout, expired or untrusted certificate, 5xx, 404, blocked, missing content). It appears in alert emails, check results and the incident list.
- Keyword checks: optionally require text on the page, so a site that returns 200 but shows an error page still counts as down.
- Webhook alerts (Slack/Discord-compatible JSON) in addition to email, with the same SSRF protection as the checker.
- "Check now" button to confirm a fix without waiting, throttled to once per 10 seconds per site.
- Incident timeline with duration, resolution time, and response-time average and p95.
- Public status page per site at an unguessable URL, with 30-day uptime.
- Plans: Free (1 site, 5 min), Pro $9 (10 sites, 1 min), Team $29 (50 sites, 1 min). Prices are set in Stripe; the figures shown on the landing page live in `src/plans.js`.
- Stripe Checkout, customer portal, and an idempotent signed webhook. Lapsed subscriptions stop using paid capacity without deleting data.
- Account deletion removes all of a user's data.

## Run locally
```bash
cp .env.example .env   # then export the variables, or use your process manager
npm install
npm start              # http://localhost:3000
npm test
```
Without `STRIPE_SECRET_KEY` billing is disabled; without `SMTP_HOST` alerts are printed to stdout.

## Going live
The supported production setup is `docker-compose.yml`: the app, Caddy (automatic HTTPS via Let's Encrypt) and a daily backup job.

1. Point a DNS record at your server and copy `.env.example` to `.env`. Set `DOMAIN`, `APP_URL=https://<domain>`, a random `SESSION_SECRET`, SMTP details with a verified `MAIL_FROM` domain (SPF/DKIM), and the Stripe values below.
2. Stripe: create recurring Pro and Team prices, set `STRIPE_PRICE_PRO` and `STRIPE_PRICE_TEAM`, add a webhook endpoint at `https://<domain>/api/stripe/webhook` for `customer.subscription.created`, `.updated` and `.deleted`, and set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Enable the customer portal in the Stripe dashboard.
3. Optional: set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to add a Cloudflare human check on signup.
4. `docker compose --env-file .env up -d --build`. In production the app refuses to start on an unsafe configuration (non-https URL, default secret, missing SMTP, half-configured Stripe or Turnstile, SSRF protection disabled).
5. Set `COMPANY_NAME` and `SUPPORT_EMAIL` (required in production). The terms and privacy pages are drafts that describe what the app really collects; have a lawyer review them for your jurisdiction before taking payments.
6. Restore drill (already rehearsed in development): copy a file from the `backups` volume to `DATABASE_PATH` on a scratch instance and sign in.

Operations:
- Run exactly one app instance; the scheduler runs in-process. Compose pins `replicas: 1`.
- `/healthz` returns 503 if the database is unreachable or the scheduler has stopped, so point a container health check or an external monitor (PingWatch itself works) at it.
- Logs are one JSON object per line on stdout/stderr. Request logs contain method, path, status and timing only (no query strings, cookies or tokens).
- Backups: `npm run backup` (or the compose `backup` service) writes an integrity-checked copy with `VACUUM INTO` and keeps the newest 14. Copy that volume off the host.
- Expired sessions, tokens and webhook records are pruned daily; check history is kept 30 days.
- Users can download all their data at `GET /api/me/export` and delete their account from the dashboard.
- CI (`.github/workflows/pingwatch.yml`) runs the tests, `npm audit` and a Docker build on every push.

How it was verified: the test suite runs the real Stripe SDK against a local fake Stripe API (checkout, portal, signed webhooks with raw-body handling, replays) and real SMTP delivery against a local SMTP server. The Docker image, the compose app and backup services, a backup-and-restore drill and the Caddyfile were run and validated locally. Not exercised: a live Stripe account, a real mail provider, and Let's Encrypt issuance, which need your credentials and domain.

Known limits: SQLite on one node is the scaling ceiling (fine for hundreds of users and thousands of monitors; move to Postgres beyond that), checks run from a single location, and alerts are email and webhook only (no SMS).

## Security notes
- Monitored URLs are validated and DNS is resolved through a guard that rejects private, loopback and link-local addresses (SSRF and DNS-rebinding protection). Redirects are not followed. `ALLOW_PRIVATE_TARGETS=1` disables this and is for local testing only.
- State-changing API calls require same-origin JSON.
- HSTS on https deployments, strict CSP, no inline scripts, UI built with `textContent` (no HTML injection).

