import nodemailer from 'nodemailer';

export function createMailer(smtp, log = console) {
  if (!smtp.host) {
    return { async send({ to, subject, text }) { log.log(`[mail disabled] to=${to} subject=${subject}\n${text}`); } };
  }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  return {
    async send({ to, subject, text }) {
      try {
        await transport.sendMail({ from: smtp.from, to, subject, text });
      } catch (err) {
        log.error(`mail to ${to} failed: ${err.message}`);
      }
    },
  };
}
