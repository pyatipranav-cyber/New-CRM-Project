'use strict';
const express = require('express');
const db = require('./db');
const { requireOwner } = require('./auth');
const { schemas, parse, normalizeMobile, uuid, STATUSES, OPEN_STATUSES } = require('./validation');
const { badRequest, notFound, conflict } = require('./errors');

const router = express.Router();
const PAGE_SIZE = 25;

// ---------- helpers ----------

function todayIn(tz) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date()
  );
}

function monthStart(today) {
  return today.slice(0, 8) + '01';
}

function id(param) {
  if (!uuid.safeParse(param).success) throw notFound();
  return param;
}

const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

function likePattern(q) {
  return '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
}

function enquiryOut(r) {
  return {
    id: r.id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    mobile: r.mobile,
    product: r.product,
    source: r.source,
    estimatedValue: r.estimated_value,
    enquiryDate: r.enquiry_date,
    status: r.status,
    saleValue: r.sale_value,
    lostReason: r.lost_reason,
    closedAt: r.closed_at,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    nextFollowUp: r.next_follow_up_id
      ? { id: r.next_follow_up_id, dueDate: r.next_due_date, dueTime: hhmm(r.next_due_time) }
      : null,
  };
}

function followUpOut(r) {
  return {
    id: r.id,
    enquiryId: r.enquiry_id,
    dueDate: r.due_date,
    dueTime: hhmm(r.due_time),
    note: r.note,
    status: r.status,
    outcome: r.outcome,
    completedAt: r.completed_at,
    completedByName: r.completed_by_name || null,
    createdAt: r.created_at,
    customerId: r.customer_id,
    customerName: r.customer_name,
    mobile: r.mobile,
    product: r.product,
    enquiryStatus: r.enquiry_status,
    estimatedValue: r.estimated_value,
  };
}

const ENQUIRY_SELECT = `
  SELECT e.*, c.name AS customer_name, c.mobile,
         nf.id AS next_follow_up_id, nf.due_date AS next_due_date, nf.due_time AS next_due_time
    FROM enquiries e
    JOIN customers c ON c.id = e.customer_id AND c.business_id = e.business_id
    LEFT JOIN LATERAL (
      SELECT f.id, f.due_date, f.due_time FROM follow_ups f
       WHERE f.enquiry_id = e.id AND f.business_id = e.business_id AND f.status = 'pending'
       ORDER BY f.due_date, f.due_time NULLS LAST LIMIT 1
    ) nf ON true`;

const FOLLOWUP_SELECT = `
  SELECT f.*, e.product, e.status AS enquiry_status, e.estimated_value,
         c.id AS customer_id, c.name AS customer_name, c.mobile, u.name AS completed_by_name
    FROM follow_ups f
    JOIN enquiries e ON e.id = f.enquiry_id AND e.business_id = f.business_id
    JOIN customers c ON c.id = e.customer_id AND c.business_id = e.business_id
    LEFT JOIN users u ON u.id = f.completed_by`;

async function loadEnquiry(client, businessId, enquiryId, { lock = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM enquiries WHERE id = $1 AND business_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [enquiryId, businessId]
  );
  if (!rows[0]) throw notFound('Enquiry not found.');
  return rows[0];
}

async function fetchEnquiry(client, businessId, enquiryId) {
  const { rows } = await client.query(`${ENQUIRY_SELECT} WHERE e.id = $1 AND e.business_id = $2`, [
    enquiryId,
    businessId,
  ]);
  if (!rows[0]) throw notFound('Enquiry not found.');
  return enquiryOut(rows[0]);
}

// Applies a status change, writes history and keeps follow-ups consistent:
// closing an enquiry (converted/lost) cancels its pending follow-ups.
async function applyStatus(client, user, enquiry, { status, note, saleValue, lostReason }) {
  if (enquiry.status === status) return false;
  const closing = status === 'converted' || status === 'lost';
  if (status === 'lost' && !lostReason && !note) {
    throw badRequest('Please add a short reason why this enquiry was lost.', {
      fields: { lostReason: 'Reason is required.' },
    });
  }
  await client.query(
    `UPDATE enquiries SET status = $3,
            sale_value  = CASE WHEN $3 = 'converted' THEN COALESCE($4::numeric, estimated_value) ELSE NULL END,
            lost_reason = CASE WHEN $3 = 'lost' THEN COALESCE($5, $6) ELSE NULL END,
            closed_at   = CASE WHEN $7 THEN now() ELSE NULL END,
            updated_at  = now()
      WHERE id = $1 AND business_id = $2`,
    [enquiry.id, user.business_id, status, saleValue ?? null, lostReason ?? null, note ?? null, closing]
  );
  if (closing) {
    await client.query(
      `UPDATE follow_ups SET status = 'cancelled', outcome = COALESCE(outcome, $3)
        WHERE enquiry_id = $1 AND business_id = $2 AND status = 'pending'`,
      [enquiry.id, user.business_id, `Closed as ${status}`]
    );
  }
  await client.query(
    `INSERT INTO status_history (business_id, enquiry_id, from_status, to_status, note, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user.business_id, enquiry.id, enquiry.status, status, note || lostReason || null, user.id]
  );
  return true;
}

// ---------- dashboard ----------

router.get('/dashboard', async (req, res) => {
  const bid = req.user.business_id;
  const today = todayIn(req.user.timezone);
  const data = await db.withTenant(bid, async (c) => {
    const e = await c.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'new')::int AS new_count,
              count(*) FILTER (WHERE status = ANY($2))::int AS open_count,
              count(*) FILTER (WHERE status = 'converted')::int AS converted,
              count(*) FILTER (WHERE status = 'lost')::int AS lost,
              COALESCE(sum(sale_value) FILTER (WHERE status = 'converted'), 0) AS won_value,
              COALESCE(sum(sale_value) FILTER (WHERE status = 'converted'
                        AND (closed_at AT TIME ZONE $4)::date >= $3::date), 0) AS won_value_month,
              count(*) FILTER (WHERE status = 'converted'
                        AND (closed_at AT TIME ZONE $4)::date >= $3::date)::int AS converted_month,
              COALESCE(sum(estimated_value) FILTER (WHERE status = ANY($2)), 0) AS pipeline_value
         FROM enquiries WHERE business_id = $1`,
      [bid, OPEN_STATUSES, monthStart(today), req.user.timezone]
    );
    const f = await c.query(
      `SELECT count(*) FILTER (WHERE due_date = $2)::int AS due_today,
              count(*) FILTER (WHERE due_date < $2)::int AS overdue,
              count(*)::int AS pending
         FROM follow_ups WHERE business_id = $1 AND status = 'pending'`,
      [bid, today]
    );
    const noNext = await c.query(
      `${ENQUIRY_SELECT}
        WHERE e.business_id = $1 AND e.status = ANY($2) AND nf.id IS NULL
        ORDER BY e.created_at DESC LIMIT 20`,
      [bid, OPEN_STATUSES]
    );
    const noNextCount = await c.query(
      `SELECT count(*)::int AS n FROM enquiries e
        WHERE e.business_id = $1 AND e.status = ANY($2)
          AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.enquiry_id = e.id AND f.business_id = e.business_id AND f.status = 'pending')`,
      [bid, OPEN_STATUSES]
    );
    const due = await c.query(
      `${FOLLOWUP_SELECT}
        WHERE f.business_id = $1 AND f.status = 'pending' AND f.due_date <= $2
        ORDER BY f.due_date, f.due_time NULLS LAST LIMIT 100`,
      [bid, today]
    );
    return { e: e.rows[0], f: f.rows[0], noNext: noNext.rows, noNextCount: noNextCount.rows[0].n, due: due.rows };
  });
  const dueRows = data.due.map(followUpOut);
  res.json({
    today,
    stats: {
      totalEnquiries: data.e.total,
      newEnquiries: data.e.new_count,
      openEnquiries: data.e.open_count,
      converted: data.e.converted,
      lost: data.e.lost,
      wonValue: data.e.won_value,
      wonValueThisMonth: data.e.won_value_month,
      convertedThisMonth: data.e.converted_month,
      pipelineValue: data.e.pipeline_value,
      dueToday: data.f.due_today,
      overdue: data.f.overdue,
      pendingFollowUps: data.f.pending,
      noNextStep: data.noNextCount,
    },
    overdue: dueRows.filter((r) => r.dueDate < today),
    dueToday: dueRows.filter((r) => r.dueDate === today),
    noNextStep: data.noNext.map(enquiryOut),
  });
});

// ---------- enquiries ----------

router.get('/enquiries', async (req, res) => {
  const bid = req.user.business_id;
  const status = String(req.query.status || 'all');
  const q = String(req.query.q || '').trim().slice(0, 80);
  const page = Math.max(1, Math.min(10_000, parseInt(req.query.page, 10) || 1));

  const where = ['e.business_id = $1'];
  const params = [bid];
  if (status === 'open') {
    params.push(OPEN_STATUSES);
    where.push(`e.status = ANY($${params.length})`);
  } else if (STATUSES.includes(status)) {
    params.push(status);
    where.push(`e.status = $${params.length}`);
  } else if (status !== 'all') {
    throw badRequest('Unknown status filter.');
  }
  if (q) {
    params.push(likePattern(q));
    const p = `$${params.length}`;
    const digits = q.replace(/\D/g, '');
    let mobileClause = '';
    if (digits.length >= 3) {
      params.push(likePattern(digits));
      mobileClause = ` OR c.mobile LIKE $${params.length}`;
    }
    where.push(`(c.name ILIKE ${p} OR e.product ILIKE ${p}${mobileClause})`);
  }

  const result = await db.withTenant(bid, async (c) => {
    const count = await c.query(
      `SELECT count(*)::int AS n FROM enquiries e
         JOIN customers c ON c.id = e.customer_id AND c.business_id = e.business_id
        WHERE ${where.join(' AND ')}`,
      params
    );
    const rows = await c.query(
      `${ENQUIRY_SELECT} WHERE ${where.join(' AND ')}
        ORDER BY (e.status = ANY('{new,interested,follow_up}')) DESC,
                 nf.due_date ASC NULLS FIRST, e.created_at DESC
        LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params
    );
    return { total: count.rows[0].n, rows: rows.rows };
  });
  res.json({
    items: result.rows.map(enquiryOut),
    page,
    pageSize: PAGE_SIZE,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / PAGE_SIZE)),
  });
});

router.post('/enquiries', async (req, res) => {
  const body = parse(schemas.createEnquiry, req.body);
  const u = req.user;
  const mobile = normalizeMobile(body.mobile, u.country_code);
  if (!mobile) {
    throw badRequest('Enter a valid mobile number, e.g. 98450 12345.', { fields: { mobile: 'Invalid mobile number.' } });
  }
  const today = todayIn(u.timezone);
  if (body.nextFollowUpDate && body.nextFollowUpDate < today) {
    throw badRequest('Next follow-up date cannot be in the past.', { fields: { nextFollowUpDate: 'Choose today or later.' } });
  }
  const out = await db.withTenant(u.business_id, async (c) => {
    // Same mobile = same customer, so repeat visitors are linked, not duplicated.
    const cust = await c.query(
      `INSERT INTO customers (business_id, name, mobile, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, mobile) DO UPDATE SET updated_at = now()
       RETURNING id, name, (xmax = 0) AS inserted`,
      [u.business_id, body.name, mobile, u.id]
    );
    const customer = cust.rows[0];
    const enq = await c.query(
      `INSERT INTO enquiries (business_id, customer_id, product, source, estimated_value, enquiry_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, $7::date), $8, $9) RETURNING id`,
      [
        u.business_id,
        customer.id,
        body.product,
        body.source,
        body.estimatedValue ?? null,
        body.enquiryDate ?? null,
        today,
        body.notes ?? null,
        u.id,
      ]
    );
    const enquiryId = enq.rows[0].id;
    await c.query(
      `INSERT INTO status_history (business_id, enquiry_id, from_status, to_status, note, changed_by)
       VALUES ($1, $2, NULL, 'new', 'Enquiry created', $3)`,
      [u.business_id, enquiryId, u.id]
    );
    if (body.nextFollowUpDate) {
      await c.query(
        `INSERT INTO follow_ups (business_id, enquiry_id, due_date, due_time, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [u.business_id, enquiryId, body.nextFollowUpDate, body.nextFollowUpTime ?? null, u.id]
      );
    }
    return {
      enquiry: await fetchEnquiry(c, u.business_id, enquiryId),
      existingCustomer: !customer.inserted,
      existingCustomerName: customer.inserted ? null : customer.name,
    };
  });
  res.status(201).json(out);
});

router.get('/enquiries/:id', async (req, res) => {
  const enquiryId = id(req.params.id);
  const bid = req.user.business_id;
  const out = await db.withTenant(bid, async (c) => {
    const enquiry = await fetchEnquiry(c, bid, enquiryId);
    // One client = one connection, so these run sequentially by design.
    const cust = await c.query('SELECT id, name, mobile, notes, created_at FROM customers WHERE id = $1 AND business_id = $2', [
      enquiry.customerId,
      bid,
    ]);
    const fus = await c.query(
      `${FOLLOWUP_SELECT} WHERE f.enquiry_id = $1 AND f.business_id = $2
        ORDER BY (f.status = 'pending') DESC, f.due_date DESC, f.created_at DESC`,
      [enquiryId, bid]
    );
    const hist = await c.query(
      `SELECT h.from_status, h.to_status, h.note, h.changed_at, u.name AS changed_by_name
         FROM status_history h LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.enquiry_id = $1 AND h.business_id = $2 ORDER BY h.changed_at DESC, h.id`,
      [enquiryId, bid]
    );
    const others = await c.query(
      `SELECT id, product, status, enquiry_date FROM enquiries
        WHERE customer_id = $1 AND business_id = $2 AND id <> $3 ORDER BY enquiry_date DESC LIMIT 20`,
      [enquiry.customerId, bid, enquiryId]
    );
    return {
      enquiry,
      customer: cust.rows[0],
      followUps: fus.rows.map(followUpOut),
      history: hist.rows.map((h) => ({
        fromStatus: h.from_status,
        toStatus: h.to_status,
        note: h.note,
        changedAt: h.changed_at,
        changedByName: h.changed_by_name,
      })),
      otherEnquiries: others.rows.map((o) => ({
        id: o.id,
        product: o.product,
        status: o.status,
        enquiryDate: o.enquiry_date,
      })),
    };
  });
  res.json(out);
});

router.patch('/enquiries/:id', async (req, res) => {
  const enquiryId = id(req.params.id);
  const body = parse(schemas.updateEnquiry, req.body);
  const bid = req.user.business_id;
  const out = await db.withTenant(bid, async (c) => {
    await loadEnquiry(c, bid, enquiryId, { lock: true });
    const sets = [];
    const params = [enquiryId, bid];
    const map = { product: 'product', source: 'source', estimatedValue: 'estimated_value', enquiryDate: 'enquiry_date', notes: 'notes' };
    for (const [k, col] of Object.entries(map)) {
      if (body[k] !== undefined) {
        params.push(body[k]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (sets.length) {
      await c.query(
        `UPDATE enquiries SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND business_id = $2`,
        params
      );
    }
    return fetchEnquiry(c, bid, enquiryId);
  });
  res.json({ enquiry: out });
});

router.delete('/enquiries/:id', requireOwner, async (req, res) => {
  const enquiryId = id(req.params.id);
  const bid = req.user.business_id;
  await db.withTenant(bid, async (c) => {
    const e = await loadEnquiry(c, bid, enquiryId, { lock: true });
    await c.query('DELETE FROM enquiries WHERE id = $1 AND business_id = $2', [enquiryId, bid]);
    // Remove the customer too if this was their only enquiry.
    await c.query(
      `DELETE FROM customers c WHERE c.id = $1 AND c.business_id = $2
          AND NOT EXISTS (SELECT 1 FROM enquiries e WHERE e.customer_id = c.id AND e.business_id = c.business_id)`,
      [e.customer_id, bid]
    );
  });
  res.json({ ok: true });
});

router.post('/enquiries/:id/status', async (req, res) => {
  const enquiryId = id(req.params.id);
  const body = parse(schemas.changeStatus, req.body);
  const bid = req.user.business_id;
  const out = await db.withTenant(bid, async (c) => {
    const e = await loadEnquiry(c, bid, enquiryId, { lock: true });
    const changed = await applyStatus(c, req.user, e, body);
    return { changed, enquiry: await fetchEnquiry(c, bid, enquiryId) };
  });
  res.json(out);
});

router.post('/enquiries/:id/follow-ups', async (req, res) => {
  const enquiryId = id(req.params.id);
  const body = parse(schemas.createFollowUp, req.body);
  const bid = req.user.business_id;
  if (body.dueDate < todayIn(req.user.timezone)) {
    throw badRequest('Follow-up date cannot be in the past.', { fields: { dueDate: 'Choose today or later.' } });
  }
  const out = await db.withTenant(bid, async (c) => {
    const e = await loadEnquiry(c, bid, enquiryId, { lock: true });
    if (!OPEN_STATUSES.includes(e.status)) {
      throw conflict(`This enquiry is marked ${e.status}. Reopen it before adding a follow-up.`);
    }
    const f = await c.query(
      `INSERT INTO follow_ups (business_id, enquiry_id, due_date, due_time, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [bid, enquiryId, body.dueDate, body.dueTime ?? null, body.note ?? null, req.user.id]
    );
    const row = await c.query(`${FOLLOWUP_SELECT} WHERE f.id = $1 AND f.business_id = $2`, [f.rows[0].id, bid]);
    return followUpOut(row.rows[0]);
  });
  res.status(201).json({ followUp: out });
});

// ---------- customers ----------

router.patch('/customers/:id', async (req, res) => {
  const customerId = id(req.params.id);
  const body = parse(schemas.updateCustomer, req.body);
  const bid = req.user.business_id;
  let mobile;
  if (body.mobile !== undefined) {
    mobile = normalizeMobile(body.mobile, req.user.country_code);
    if (!mobile) throw badRequest('Enter a valid mobile number.', { fields: { mobile: 'Invalid mobile number.' } });
  }
  const out = await db.withTenant(bid, async (c) => {
    const sets = [];
    const params = [customerId, bid];
    if (body.name !== undefined) { params.push(body.name); sets.push(`name = $${params.length}`); }
    if (mobile !== undefined) { params.push(mobile); sets.push(`mobile = $${params.length}`); }
    if (body.notes !== undefined) { params.push(body.notes); sets.push(`notes = $${params.length}`); }
    const sql = sets.length
      ? `UPDATE customers SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND business_id = $2 RETURNING id, name, mobile, notes`
      : 'SELECT id, name, mobile, notes FROM customers WHERE id = $1 AND business_id = $2';
    try {
      const r = await c.query(sql, params);
      if (!r.rows[0]) throw notFound('Customer not found.');
      return r.rows[0];
    } catch (err) {
      if (err.code === '23505') throw conflict('Another customer already has this mobile number.');
      throw err;
    }
  });
  res.json({ customer: out });
});

// ---------- follow-ups ----------

router.get('/follow-ups', async (req, res) => {
  const bid = req.user.business_id;
  const view = String(req.query.view || 'today');
  const today = todayIn(req.user.timezone);
  const views = {
    overdue: { where: "f.status = 'pending' AND f.due_date < $2", order: 'f.due_date ASC, f.due_time NULLS LAST' },
    today: { where: "f.status = 'pending' AND f.due_date = $2", order: 'f.due_time NULLS LAST, f.created_at' },
    upcoming: { where: "f.status = 'pending' AND f.due_date > $2", order: 'f.due_date ASC, f.due_time NULLS LAST' },
    done: { where: "f.status = 'done'", order: 'f.completed_at DESC' },
  };
  const v = views[view];
  if (!v) throw badRequest('Unknown view.');
  const rows = await db.withTenant(bid, async (c) => {
    const params = [bid];
    if (view !== 'done') params.push(today);
    const r = await c.query(
      `${FOLLOWUP_SELECT} WHERE f.business_id = $1 AND ${v.where} ORDER BY ${v.order} LIMIT 200`,
      params
    );
    return r.rows;
  });
  res.json({ today, view, items: rows.map(followUpOut) });
});

async function loadPendingFollowUp(c, bid, followUpId) {
  const r = await c.query('SELECT * FROM follow_ups WHERE id = $1 AND business_id = $2 FOR UPDATE', [followUpId, bid]);
  const f = r.rows[0];
  if (!f) throw notFound('Follow-up not found.');
  if (f.status !== 'pending') throw conflict(`This follow-up is already ${f.status}.`);
  return f;
}

router.post('/follow-ups/:id/complete', async (req, res) => {
  const followUpId = id(req.params.id);
  const body = parse(schemas.completeFollowUp, req.body);
  const bid = req.user.business_id;
  const today = todayIn(req.user.timezone);
  if (body.next && body.next.dueDate < today) {
    throw badRequest('Next follow-up date cannot be in the past.', { fields: { 'next.dueDate': 'Choose today or later.' } });
  }
  const out = await db.withTenant(bid, async (c) => {
    const f = await loadPendingFollowUp(c, bid, followUpId);
    await c.query(
      `UPDATE follow_ups SET status = 'done', outcome = $3, completed_at = now(), completed_by = $4
        WHERE id = $1 AND business_id = $2`,
      [followUpId, bid, body.outcome ?? null, req.user.id]
    );
    let enquiry = await loadEnquiry(c, bid, f.enquiry_id, { lock: true });
    if (body.status) {
      await applyStatus(c, req.user, enquiry, {
        status: body.status,
        note: body.outcome,
        saleValue: body.saleValue,
        lostReason: body.lostReason,
      });
      enquiry = await loadEnquiry(c, bid, f.enquiry_id);
    }
    let nextCreated = false;
    if (body.next && OPEN_STATUSES.includes(enquiry.status)) {
      await c.query(
        `INSERT INTO follow_ups (business_id, enquiry_id, due_date, due_time, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [bid, f.enquiry_id, body.next.dueDate, body.next.dueTime ?? null, body.next.note ?? null, req.user.id]
      );
      nextCreated = true;
    }
    return { nextCreated, enquiry: await fetchEnquiry(c, bid, f.enquiry_id) };
  });
  res.json(out);
});

router.patch('/follow-ups/:id', async (req, res) => {
  const followUpId = id(req.params.id);
  const body = parse(schemas.updateFollowUp, req.body);
  const bid = req.user.business_id;
  if (body.dueDate && body.dueDate < todayIn(req.user.timezone)) {
    throw badRequest('Follow-up date cannot be in the past.', { fields: { dueDate: 'Choose today or later.' } });
  }
  const out = await db.withTenant(bid, async (c) => {
    await loadPendingFollowUp(c, bid, followUpId);
    const sets = [];
    const params = [followUpId, bid];
    if (body.dueDate !== undefined) { params.push(body.dueDate); sets.push(`due_date = $${params.length}`); }
    if (body.dueTime !== undefined) { params.push(body.dueTime); sets.push(`due_time = $${params.length}`); }
    if (body.note !== undefined) { params.push(body.note); sets.push(`note = $${params.length}`); }
    if (sets.length) {
      await c.query(`UPDATE follow_ups SET ${sets.join(', ')} WHERE id = $1 AND business_id = $2`, params);
    }
    const r = await c.query(`${FOLLOWUP_SELECT} WHERE f.id = $1 AND f.business_id = $2`, [followUpId, bid]);
    return followUpOut(r.rows[0]);
  });
  res.json({ followUp: out });
});

router.post('/follow-ups/:id/cancel', async (req, res) => {
  const followUpId = id(req.params.id);
  const bid = req.user.business_id;
  await db.withTenant(bid, async (c) => {
    await loadPendingFollowUp(c, bid, followUpId);
    await c.query(
      `UPDATE follow_ups SET status = 'cancelled', completed_at = now(), completed_by = $3
        WHERE id = $1 AND business_id = $2`,
      [followUpId, bid, req.user.id]
    );
  });
  res.json({ ok: true });
});

module.exports = router;
module.exports.todayIn = todayIn;
