import dns from 'node:dns';
import net from 'node:net';

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) return isPrivateAddress(l.slice(7));
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

// Resolves at connect time and rejects private targets, which also defeats DNS rebinding.
export function guardedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = addresses.filter((a) => allowPrivate || !isPrivateAddress(a.address));
      if (list.length === 0) return cb(new Error('Target resolves to a private or reserved address'));
      if (options.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

export function parseTarget(raw, allowPrivate = false) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter a valid URL, including http:// or https://');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs are allowed');
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed');
  if (!allowPrivate && net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('Private and reserved addresses cannot be monitored');
  }
  return url;
}
