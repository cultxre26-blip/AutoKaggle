import nodemailer from 'nodemailer';
import { postWebhook } from './webhook.js';

export function createMailer(smtp, log = console, { allowPrivate = false } = {}) {
  const webhook = (url, payload) => postWebhook(url, payload, { allowPrivate });
  if (!smtp.host) {
    return { webhook, async send({ to, subject, text }) { log.log(`[mail disabled] to=${to} subject=${subject}\n${text}`); } };
  }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  return {
    webhook,
    async send({ to, subject, text }) {
      try {
        await transport.sendMail({ from: smtp.from, to, subject, text });
      } catch (err) {
        log.error(`mail to ${to} failed: ${err.message}`);
      }
    },
  };
}
