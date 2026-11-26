'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { AppError, unauthorized, forbidden, tooMany } = require('./errors');

const COOKIE = 'fp_session';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const BCRYPT_COST = 11;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Used to keep login timing similar whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', BCRYPT_COST);

const isProd = () => process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new AppError(500, 'CONFIG_MISSING', 'Server is not configured: JWT_SECRET must be at least 32 characters.');
  }
  return s;
}

const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_COST);
const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);

function setSession(res, user) {
  const token = jwt.sign({ sub: user.id, bid: user.business_id, tv: user.token_version }, secret(), {
    algorithm: 'HS256',
    expiresIn: `${SESSION_DAYS}d`,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: isProd(), sameSite: 'strict', path: '/' });
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Verifies the session cookie AND re-checks the user in the database, so
// deactivated users and changed passwords take effect immediately.
async function requireAuth(req, _res, next) {
  const token = readCookie(req, COOKIE);
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, secret(), { algorithms: ['HS256'] });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unauthorized('Your session has expired. Please sign in again.');
  }
  const { rows } = await db.query(
    `SELECT u.id, u.business_id, u.name, u.email, u.role, u.is_active, u.token_version,
            b.name AS business_name, b.timezone, b.country_code, b.whatsapp_template
       FROM users u JOIN businesses b ON b.id = u.business_id
      WHERE u.id = $1`,
    [payload.sub]
  );
  const u = rows[0];
  if (!u || !u.is_active || u.token_version !== payload.tv || u.business_id !== payload.bid) {
    throw unauthorized('Your session is no longer valid. Please sign in again.');
  }
  req.user = u;
  next();
}

function requireOwner(req, _res, next) {
  if (req.user?.role !== 'owner') throw forbidden('Only the business owner can do this.');
  next();
}

// Small in-memory limiter for auth endpoints. It is per server instance, so it
// is a speed bump, not a guarantee; the per-account lockout below is the real
// protection, and Vercel Firewall rate limiting can be added on top.
const buckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, _res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const key = `${req.path}:${ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    }
    if (b.count > max) throw tooMany();
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  setSession,
  clearSession,
  requireAuth,
  requireOwner,
  rateLimit,
  DUMMY_HASH,
  MAX_FAILED,
  LOCK_MINUTES,
};
