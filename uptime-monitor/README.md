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

## Going live checklist
1. Set `NODE_ENV=production`, a random `SESSION_SECRET`, and `APP_URL` to your https URL (the server refuses to start in production with the default secret).
2. Stripe: create Pro and Team recurring prices, set `STRIPE_PRICE_PRO`/`STRIPE_PRICE_TEAM`, and point a webhook at `/api/stripe/webhook` for `customer.subscription.created|updated|deleted`; set `STRIPE_WEBHOOK_SECRET`. Enable the customer portal in the Stripe dashboard.
3. SMTP: set the `SMTP_*` variables and a verified `MAIL_FROM` domain (SPF/DKIM).
4. Put it behind HTTPS (a reverse proxy or platform TLS). The app trusts one proxy hop for client IPs.
5. Mount a persistent volume for `DATABASE_PATH` and back it up (SQLite, WAL mode). Run a single instance; the scheduler runs in-process.
6. Replace `public/terms.html` and `public/privacy.html` with lawyer-reviewed text.
7. Not included yet: per-account API rate limiting beyond sign-in and a CAPTCHA on signup. Add these before heavy public traffic.

## Security notes
- Monitored URLs are validated and DNS is resolved through a guard that rejects private, loopback and link-local addresses (SSRF and DNS-rebinding protection). Redirects are not followed. `ALLOW_PRIVATE_TARGETS=1` disables this and is for local testing only.
- State-changing API calls require same-origin JSON.
- Strict CSP, no inline scripts, UI built with `textContent` (no HTML injection).

## Docker
```bash
docker build -t pingwatch . && docker run -p 3000:3000 -v pingwatch-data:/data --env-file .env pingwatch
```
