import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createBilling } from '../src/billing.js';

export function makeCtx(env = {}) {
  const config = loadConfig({ APP_URL: 'http://localhost:3000', ALLOW_PRIVATE_TARGETS: '1', STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_TEAM: 'price_team', ...env });
  const db = openDb(':memory:');
  const sent = [];
  const mailer = { async send(m) { sent.push(m); } };
  const billing = createBilling(config, db);
  return { config, db, mailer, billing, sent, app: createApp({ config, db, mailer, billing }) };
}

export async function listen(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

export function client(base) {
  let cookie = '';
  return async (path, method = 'GET', body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
