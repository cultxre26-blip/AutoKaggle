export function loadConfig(env = process.env) {
  const appUrl = env.APP_URL || 'http://localhost:3000';
  const production = env.NODE_ENV === 'production';
  if (production && (!env.SESSION_SECRET || env.SESSION_SECRET === 'change-me')) {
    throw new Error('SESSION_SECRET must be set in production');
  }
  const config = {
    companyName: env.COMPANY_NAME || '',
    supportEmail: env.SUPPORT_EMAIL || '',
    trustProxy: Number(env.TRUST_PROXY ?? 1),
    port: Number(env.PORT || 3000),
    appUrl,
    secureCookies: appUrl.startsWith('https://'),
    databasePath: env.DATABASE_PATH || './data/pingwatch.db',
    allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === '1',
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
      prices: { pro: env.STRIPE_PRICE_PRO || '', team: env.STRIPE_PRICE_TEAM || '' },
    },
    turnstile: { siteKey: env.TURNSTILE_SITE_KEY || '', secret: env.TURNSTILE_SECRET_KEY || '' },
    smtp: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT || 587),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || 'PingWatch <alerts@localhost>',
    },
  };
  if (production) validateProduction(config);
  return config;
}

// Fail fast on a half-configured production deploy instead of failing later in front of customers.
function validateProduction(c) {
  const problems = [];
  if (!c.appUrl.startsWith('https://')) problems.push('APP_URL must be an https URL');
  if (c.allowPrivateTargets) problems.push('ALLOW_PRIVATE_TARGETS must not be enabled (it disables SSRF protection)');
  if (c.stripe.secretKey) {
    if (!c.stripe.webhookSecret) problems.push('STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set');
    if (!c.stripe.prices.pro || !c.stripe.prices.team) problems.push('STRIPE_PRICE_PRO and STRIPE_PRICE_TEAM are required when billing is enabled');
  }
  if (!c.companyName || !c.supportEmail) problems.push('COMPANY_NAME and SUPPORT_EMAIL are required: they appear in the terms and privacy pages');
  if (!c.smtp.host) problems.push('SMTP_HOST is required: verification, reset and alert emails cannot be delivered without it');
  if (Boolean(c.turnstile.siteKey) !== Boolean(c.turnstile.secret)) problems.push('Set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither');
  if (problems.length) throw new Error(`Invalid production configuration:\n - ${problems.join('\n - ')}`);
}
