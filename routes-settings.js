'use strict';
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const { schemas, parse, uuid } = require('./validation');
const { notFound, conflict, badRequest } = require('./errors');

const router = express.Router();

function businessOut(b) {
  return {
    id: b.id,
    name: b.name,
    phone: b.phone,
    city: b.city,
    timezone: b.timezone,
    countryCode: b.country_code,
    whatsappTemplate: b.whatsapp_template,
  };
}

router.get('/settings', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM businesses WHERE id = $1', [req.user.business_id]);
  const payload = { business: businessOut(rows[0]) };
  if (req.user.role === 'owner') {
    payload.security = { appLevelIsolation: true, rowLevelSecurity: await db.rlsStatus() };
  }
  res.json(payload);
});

router.patch('/settings', auth.requireOwner, async (req, res) => {
  const body = parse(schemas.settings, req.body);
  const map = {
    name: 'name',
    phone: 'phone',
    city: 'city',
    timezone: 'timezone',
    countryCode: 'country_code',
    whatsappTemplate: 'whatsapp_template',
  };
  const sets = [];
  const params = [req.user.business_id];
  for (const [k, col] of Object.entries(map)) {
    if (body[k] !== undefined) {
      params.push(body[k]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  const sql = sets.length
    ? `UPDATE businesses SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`
    : 'SELECT * FROM businesses WHERE id = $1';
  const { rows } = await db.query(sql, params);
  res.json({ business: businessOut(rows[0]) });
});

// ---------- team ----------

const userOut = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  isActive: u.is_active,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
});

router.get('/team', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, name, email, role, is_active, last_login_at, created_at
       FROM users WHERE business_id = $1 ORDER BY role, created_at`,
    [req.user.business_id]
  );
  res.json({ items: rows.map(userOut) });
});

router.post('/team', auth.requireOwner, async (req, res) => {
  const body = parse(schemas.createStaff, req.body);
  const hash = await auth.hashPassword(body.password);
  try {
    const { rows } = await db.query(
      `INSERT INTO users (business_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'staff') RETURNING *`,
      [req.user.business_id, body.name, body.email, hash]
    );
    res.status(201).json({ user: userOut(rows[0]) });
  } catch (err) {
    if (err.code === '23505') throw conflict('A user with this email already exists.');
    throw err;
  }
});

router.patch('/team/:id', auth.requireOwner, async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) throw notFound();
  const body = parse(schemas.updateStaff, req.body);
  if (req.params.id === req.user.id) throw badRequest('Use "Change password" to update your own account.');
  const existing = await db.query('SELECT * FROM users WHERE id = $1 AND business_id = $2', [
    req.params.id,
    req.user.business_id,
  ]);
  if (!existing.rows[0]) throw notFound('User not found.');
  if (existing.rows[0].role === 'owner') throw badRequest('The owner account cannot be changed here.');
  const sets = ['token_version = token_version + 1']; // signs the user out everywhere
  const params = [req.params.id, req.user.business_id];
  if (body.isActive !== undefined) {
    params.push(body.isActive);
    sets.push(`is_active = $${params.length}`);
  }
  if (body.password !== undefined) {
    params.push(await auth.hashPassword(body.password));
    sets.push(`password_hash = $${params.length}`, 'failed_logins = 0', 'locked_until = NULL');
  }
  const { rows } = await db.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND business_id = $2 RETURNING *`,
    params
  );
  res.json({ user: userOut(rows[0]) });
});

// ---------- export (data ownership / manual backup) ----------

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/export.csv', auth.requireOwner, async (req, res) => {
  const bid = req.user.business_id;
  const rows = await db.withTenant(bid, async (c) => {
    const r = await c.query(
      `SELECT c.name, c.mobile, e.product, e.source, e.status, e.estimated_value, e.sale_value,
              e.enquiry_date, e.lost_reason, e.notes,
              (SELECT min(f.due_date) FROM follow_ups f
                 WHERE f.enquiry_id = e.id AND f.business_id = e.business_id AND f.status = 'pending') AS next_follow_up,
              e.created_at
         FROM enquiries e JOIN customers c ON c.id = e.customer_id AND c.business_id = e.business_id
        WHERE e.business_id = $1 ORDER BY e.created_at`,
      [bid]
    );
    return r.rows;
  });
  const header = ['Customer', 'Mobile', 'Product', 'Source', 'Status', 'Estimated value', 'Sale value',
    'Enquiry date', 'Lost reason', 'Notes', 'Next follow-up', 'Created at'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.name, r.mobile, r.product, r.source, r.status, r.estimated_value, r.sale_value, r.enquiry_date,
      r.lost_reason, r.notes, r.next_follow_up, r.created_at].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="followup-pro-export-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send('﻿' + lines.join('\r\n'));
});

module.exports = router;
