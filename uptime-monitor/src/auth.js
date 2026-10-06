import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const SESSION_TTL_SEC = 60 * 60 * 24 * 30;
export const COOKIE = 'pw_session';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createSession(db, userId, now = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token), userId, now + SESSION_TTL_SEC * 1000,
  );
  return token;
}

export function userForSession(db, token, now = Date.now()) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).get(sha256(token), now);
  return row || null;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function cookieHeader(token, { secure, clear = false }) {
  const parts = [`${COOKIE}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push(clear ? 'Max-Age=0' : `Max-Age=${SESSION_TTL_SEC}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// One-time tokens for email verification and password reset. Only the hash is stored.
export const TOKEN_TTL = { verify: 24 * 3600 * 1000, reset: 3600 * 1000 };

export function createToken(db, userId, purpose, now = Date.now()) {
  db.prepare('DELETE FROM tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, purpose, now + TOKEN_TTL[purpose]);
  return token;
}

// Returns the user id and deletes the token, or null if unknown, expired or already used.
export function consumeToken(db, token, purpose, now = Date.now()) {
  if (typeof token !== 'string' || !token) return null;
  const hash = sha256(token);
  const row = db.prepare('SELECT user_id FROM tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ?').get(hash, purpose, now);
  const deleted = db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(hash);
  return row && deleted.changes === 1 ? row.user_id : null;
}
