'use strict';
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const { schemas, parse } = require('./validation');
const { unauthorized, conflict } = require('./errors');
const log = require('./logger');

const router = express.Router();
const limiter = auth.rateLimit({ windowMs: 60_000, max: 20 });

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    business: {
      id: u.business_id,
      name: u.business_name,
      timezone: u.timezone,
      countryCode: u.country_code,
      whatsappTemplate: u.whatsapp_template,
    },
  };
}

router.post('/signup', limiter, async (req, res) => {
  const body = parse(schemas.signup, req.body);
  const passwordHash = await auth.hashPassword(body.password);
  const user = await db.tx(async (client) => {
    const exists = await client.query('SELECT 1 FROM users WHERE lower(email) = $1', [body.email]);
    if (exists.rowCount) throw conflict('An account with this email already exists. Please sign in.');
    const b = await client.query('INSERT INTO businesses (name) VALUES ($1) RETURNING *', [body.businessName]);
    const u = await client.query(
      `INSERT INTO users (business_id, name, email, password_hash, role, last_login_at)
       VALUES ($1, $2, $3, $4, 'owner', now()) RETURNING *`,
      [b.rows[0].id, body.name, body.email, passwordHash]
    );
    const biz = b.rows[0];
    return {
      ...u.rows[0],
      business_name: biz.name,
      timezone: biz.timezone,
      country_code: biz.country_code,
      whatsapp_template: biz.whatsapp_template,
    };
  });
  auth.setSession(res, user);
  log.info('signup', { userId: user.id, businessId: user.business_id });
  res.status(201).json({ user: publicUser(user) });
});

router.post('/login', limiter, async (req, res) => {
  const body = parse(schemas.login, req.body);
  const { rows } = await db.query(
    `SELECT u.*, b.name AS business_name, b.timezone, b.country_code, b.whatsapp_template
       FROM users u JOIN businesses b ON b.id = u.business_id
      WHERE lower(u.email) = $1`,
    [body.email]
  );
  const u = rows[0];
  const generic = 'Incorrect email or password.';
  if (!u) {
    await auth.verifyPassword(body.password, auth.DUMMY_HASH);
    throw unauthorized(generic);
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    throw unauthorized(`Too many failed attempts. Try again after ${auth.LOCK_MINUTES} minutes.`);
  }
  const ok = await auth.verifyPassword(body.password, u.password_hash);
  if (!ok) {
    await db.query(
      `UPDATE users SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
        WHERE id = $1`,
      [u.id, auth.MAX_FAILED, String(auth.LOCK_MINUTES)]
    );
    log.warn('login_failed', { userId: u.id });
    throw unauthorized(generic);
  }
  if (!u.is_active) throw unauthorized('This account has been deactivated. Contact your business owner.');
  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  auth.setSession(res, u);
  res.json({ user: publicUser(u) });
});

router.post('/logout', (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

router.get('/me', auth.requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/change-password', auth.requireAuth, limiter, async (req, res) => {
  const body = parse(schemas.changePassword, req.body);
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const ok = await auth.verifyPassword(body.currentPassword, rows[0].password_hash);
  if (!ok) throw unauthorized('Current password is incorrect.');
  const hash = await auth.hashPassword(body.newPassword);
  // Bumping token_version signs out every other device.
  const upd = await db.query(
    `UPDATE users SET password_hash = $2, token_version = token_version + 1, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.user.id, hash]
  );
  auth.setSession(res, upd.rows[0]);
  res.json({ ok: true });
});

module.exports = router;
