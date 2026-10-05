import http from 'node:http';
import https from 'node:https';
import { guardedLookup, parseTarget } from './ssrf.js';

const TIMEOUT_MS = 10_000;

export function checkSite(urlString, { allowPrivate = false, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let url;
    try {
      // Node skips DNS lookup for IP literals, so they must be validated up front.
      url = parseTarget(urlString, allowPrivate);
    } catch (err) {
      return resolve({ ok: false, statusCode: null, responseMs: 0, sslExpiresAt: null, error: err.message });
    }
    const lib = url.protocol === 'https:' ? https : http;
    let sslExpiresAt = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ responseMs: Date.now() - started, sslExpiresAt, ...result });
    };
    const req = lib.request(
      url,
      { method: 'GET', timeout: timeoutMs, lookup: guardedLookup(allowPrivate), headers: { 'User-Agent': 'PingWatch/1.0 (+uptime monitor)' } },
      (res) => {
        const cert = res.socket.getPeerCertificate?.();
        if (cert && cert.valid_to) sslExpiresAt = new Date(cert.valid_to).getTime();
        res.resume();
        const code = res.statusCode;
        finish(code < 400 ? { ok: true, statusCode: code } : { ok: false, statusCode: code, error: `HTTP ${code}` });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeoutMs / 1000}s`)));
    req.on('error', (err) => finish({ ok: false, statusCode: null, error: err.code || err.message }));
    req.end();
  });
}
