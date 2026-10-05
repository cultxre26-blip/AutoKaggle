export function loadConfig(env = process.env) {
  const appUrl = env.APP_URL || 'http://localhost:3000';
  const production = env.NODE_ENV === 'production';
  if (production && (!env.SESSION_SECRET || env.SESSION_SECRET === 'change-me')) {
    throw new Error('SESSION_SECRET must be set in production');
  }
  return {
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
    smtp: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT || 587),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || 'PingWatch <alerts@localhost>',
    },
  };
}
