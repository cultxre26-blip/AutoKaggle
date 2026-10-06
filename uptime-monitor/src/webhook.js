import http from 'node:http';
import https from 'node:https';
import { guardedLookup, parseTarget } from './ssrf.js';

// Posts JSON to a user-supplied URL. Same SSRF guard as the checker; failures never throw.
export function postWebhook(urlString, payload, { allowPrivate = false, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let url;
    try { url = parseTarget(urlString, allowPrivate); } catch { return resolve(false); }
    const body = JSON.stringify(payload);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'POST', timeout: timeoutMs, lookup: guardedLookup(allowPrivate),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'PingWatch/1.0' },
    }, (res) => { res.resume(); resolve(res.statusCode < 300); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}
