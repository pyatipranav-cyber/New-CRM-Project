'use strict';
// End-to-end API test suite. Runs the real server against a real Postgres.
// Usage: npm test   (uses DATABASE_URL and JWT_SECRET from .env)
// WARNING: creates test businesses/users. Use a development database, never production.

const assert = require('assert/strict');
const app = require('./server');
const db = require('./db');
const { normalizeMobile } = require('./validation');
const { todayIn } = require('./routes-app');

let base;
let passed = 0;
const failures = [];
const run = Date.now().toString(36);

class Client {
  constructor() {
    this.cookie = null;
  }
  async req(method, path, body, { headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (method !== 'GET') h['x-requested-with'] = h['x-requested-with'] ?? 'FollowUpPro';
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.cookie) h.cookie = this.cookie;
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = set.match(/fp_session=([^;]*)/);
      if (m) this.cookie = m[1] ? `fp_session=${m[1]}` : null;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers, raw };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b = {}, o) { return this.req('POST', p, b, o); }
  patch(p, b = {}, o) { return this.req('PATCH', p, b, o); }
  del(p, o) { return this.req('DELETE', p, undefined, o); }
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}

function addDays(d, n) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

async function main() {
  await db.runMigrations();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const today = todayIn('Asia/Kolkata');

  const owner = new Client();
  const other = new Client();
  const staff = new Client();
  const anon = new Client();
  const ownerEmail = `owner-${run}@test.local`;
  const otherEmail = `other-${run}@test.local`;
  const staffEmail = `staff-${run}@test.local`;
  let enquiryA;
  let followUpA;
  let otherEnquiry;

  console.log('\nUnit: mobile normalisation');
  await test('normalises Indian numbers', () => {
    assert.equal(normalizeMobile('98450 12345'), '919845012345');
    assert.equal(normalizeMobile('+91 98450-12345'), '919845012345');
    assert.equal(normalizeMobile('09845012345'), '919845012345');
    assert.equal(normalizeMobile('919845012345'), '919845012345');
    assert.equal(normalizeMobile('+44 7700 900123'), '447700900123');
  });
  await test('rejects invalid numbers', () => {
    assert.equal(normalizeMobile('12345'), null);
    assert.equal(normalizeMobile('1234567890'), null); // Indian mobiles start 6-9
    assert.equal(normalizeMobile('98450123456'), null);
    assert.equal(normalizeMobile('abc'), null);
  });

  console.log('\nStatic + health');
  await test('serves the app shell with security headers', async () => {
    const r = await anon.get('/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(r.headers.get('x-powered-by'), null);
  });
  await test('health endpoint reports database ok', async () => {
    const r = await anon.get('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.database, 'ok');
  });
  await test('server source files are not downloadable', async () => {
    for (const p of ['/server.js', '/db.js', '/.env', '/package.json']) {
      const r = await anon.get(p);
      assert.equal(r.status, 404, p);
    }
  });

  console.log('\nAuthentication');
  await test('signup validates input server-side', async () => {
    const r = await anon.post('/api/auth/signup', { businessName: 'X', name: '', email: 'bad', password: 'short' });
    assert.equal(r.status, 400);
    assert.ok(r.json.error.details.fields.email);
    assert.ok(r.json.error.details.fields.password);
  });
  await test('owner can sign up and gets an httpOnly SameSite=Strict cookie', async () => {
    const r = await owner.post('/api/auth/signup', { businessName: 'Sharma Furniture', name: 'Ravi Sharma', email: ownerEmail, password: 'Secret123!' });
    assert.equal(r.status, 201);
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Strict/i);
    assert.equal(r.json.user.role, 'owner');
  });
  await test('password is stored as a bcrypt hash', async () => {
    const { rows } = await db.query('SELECT password_hash FROM users WHERE email = $1', [ownerEmail]);
    assert.match(rows[0].password_hash, /^\$2[aby]\$11\$/);
  });
  await test('duplicate email is rejected (case-insensitive)', async () => {
    const r = await anon.post('/api/auth/signup', { businessName: 'Dup Co', name: 'D', email: ownerEmail.toUpperCase(), password: 'Secret123!' });
    assert.equal(r.status, 409);
  });
  await test('second business signs up', async () => {
    const r = await other.post('/api/auth/signup', { businessName: 'Rival Motors', name: 'Rival', email: otherEmail, password: 'Secret123!' });
    assert.equal(r.status, 201);
  });
  await test('protected routes reject anonymous users', async () => {
    for (const p of ['/api/dashboard', '/api/enquiries', '/api/follow-ups', '/api/settings', '/api/export.csv']) {
      const r = await anon.get(p);
      assert.equal(r.status, 401, p);
    }
  });
  await test('tampered session cookie is rejected', async () => {
    const c = new Client();
    c.cookie = owner.cookie.slice(0, -4) + 'abcd';
    const r = await c.get('/api/dashboard');
    assert.equal(r.status, 401);
  });
  await test('wrong password gives a generic error', async () => {
    const r = await anon.post('/api/auth/login', { email: ownerEmail, password: 'nope-nope' });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.message, 'Incorrect email or password.');
    const r2 = await anon.post('/api/auth/login', { email: `ghost-${run}@test.local`, password: 'nope-nope' });
    assert.equal(r2.json.error.message, 'Incorrect email or password.');
  });
  await test('login works and resets failed counter', async () => {
    const c = new Client();
    const r = await c.post('/api/auth/login', { email: ownerEmail, password: 'Secret123!' });
    assert.equal(r.status, 200);
    const me = await c.get('/api/auth/me');
    assert.equal(me.json.user.email, ownerEmail);
  });

  console.log('\nCSRF protection');
  await test('mutation without the app header is blocked', async () => {
    const r = await owner.post('/api/enquiries', {}, { headers: { 'x-requested-with': '' } });
    assert.equal(r.status, 403);
  });
  await test('mutation from a foreign Origin is blocked', async () => {
    const r = await owner.post('/api/enquiries', {}, { headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });
  await test('malformed JSON returns 400, not 500', async () => {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'FollowUpPro' }, body: '{bad' });
    assert.equal(r.status, 400);
  });

  console.log('\nEnquiries');
  await test('create enquiry validates mobile and required fields', async () => {
    const r = await owner.post('/api/enquiries', { name: 'Anil', mobile: '123', product: 'Sofa', source: 'walk_in' });
    assert.equal(r.status, 400);
    assert.ok(r.json.error.details.fields.mobile);
    const r2 = await owner.post('/api/enquiries', { name: 'Anil', mobile: '9845012345', product: '', source: 'nope' });
    assert.equal(r2.status, 400);
  });
  await test('rejects follow-up dates in the past', async () => {
    const r = await owner.post('/api/enquiries', { name: 'Anil', mobile: '9845012345', product: 'Sofa', source: 'walk_in', nextFollowUpDate: addDays(today, -1) });
    assert.equal(r.status, 400);
  });
  await test('creates customer + enquiry + first follow-up', async () => {
    const r = await owner.post('/api/enquiries', {
      name: 'Anil Kumar', mobile: '98450 12345', product: '3-seater recliner sofa', source: 'walk_in',
      estimatedValue: '45,000', nextFollowUpDate: today, nextFollowUpTime: '11:30', notes: 'Wants grey fabric',
    });
    assert.equal(r.status, 201, r.text);
    enquiryA = r.json.enquiry;
    assert.equal(enquiryA.mobile, '919845012345');
    assert.equal(enquiryA.estimatedValue, 45000);
    assert.equal(enquiryA.status, 'new');
    assert.equal(enquiryA.nextFollowUp.dueDate, today);
    assert.equal(enquiryA.nextFollowUp.dueTime, '11:30');
    assert.equal(r.json.existingCustomer, false);
    followUpA = enquiryA.nextFollowUp.id;
  });
  await test('same mobile links to the existing customer instead of duplicating', async () => {
    const r = await owner.post('/api/enquiries', { name: 'Anil K', mobile: '+91 98450 12345', product: 'Dining table', source: 'phone' });
    assert.equal(r.status, 201);
    assert.equal(r.json.existingCustomer, true);
    assert.equal(r.json.enquiry.customerId, enquiryA.customerId);
    assert.equal(r.json.enquiry.customerName, 'Anil Kumar');
    assert.equal(r.json.enquiry.nextFollowUp, null);
  });
  await test('list, filter and search enquiries', async () => {
    const all = await owner.get('/api/enquiries');
    assert.equal(all.json.total, 2);
    const byName = await owner.get('/api/enquiries?q=anil');
    assert.equal(byName.json.total, 2);
    const byMobile = await owner.get('/api/enquiries?q=45012');
    assert.equal(byMobile.json.total, 2);
    const byProduct = await owner.get('/api/enquiries?q=recliner');
    assert.equal(byProduct.json.total, 1);
    const wildcard = await owner.get('/api/enquiries?q=' + encodeURIComponent('%'));
    assert.equal(wildcard.json.total, 0);
    const conv = await owner.get('/api/enquiries?status=converted');
    assert.equal(conv.json.total, 0);
    const bad = await owner.get('/api/enquiries?status=hacked');
    assert.equal(bad.status, 400);
  });
  await test('enquiry detail includes customer, follow-ups, history and other enquiries', async () => {
    const r = await owner.get(`/api/enquiries/${enquiryA.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.customer.name, 'Anil Kumar');
    assert.equal(r.json.followUps.length, 1);
    assert.equal(r.json.history[0].toStatus, 'new');
    assert.equal(r.json.otherEnquiries.length, 1);
  });
  await test('edit enquiry and customer', async () => {
    const r = await owner.patch(`/api/enquiries/${enquiryA.id}`, { estimatedValue: 48000, notes: 'Grey or beige' });
    assert.equal(r.status, 200);
    assert.equal(r.json.enquiry.estimatedValue, 48000);
    const c = await owner.patch(`/api/customers/${enquiryA.customerId}`, { name: 'Anil Kumar R' });
    assert.equal(c.json.customer.name, 'Anil Kumar R');
  });
  await test('invalid id returns 404 (no SQL error leak)', async () => {
    const r = await owner.get('/api/enquiries/not-a-uuid');
    assert.equal(r.status, 404);
    const r2 = await owner.get("/api/enquiries/1' OR '1'='1");
    assert.equal(r2.status, 404);
  });

  console.log('\nDashboard + follow-ups');
  await test('dashboard counts reflect data and the "no next step" leak', async () => {
    const r = await owner.get('/api/dashboard');
    const s = r.json.stats;
    assert.equal(s.totalEnquiries, 2);
    assert.equal(s.newEnquiries, 2);
    assert.equal(s.dueToday, 1);
    assert.equal(s.overdue, 0);
    assert.equal(s.noNextStep, 1);
    assert.equal(r.json.dueToday.length, 1);
    assert.equal(r.json.noNextStep[0].product, 'Dining table');
  });
  await test('overdue follow-ups appear in overdue view', async () => {
    const bid = (await db.query('SELECT business_id FROM users WHERE email = $1', [ownerEmail])).rows[0].business_id;
    const e2 = (await owner.get('/api/enquiries?q=dining')).json.items[0];
    const add = await owner.post(`/api/enquiries/${e2.id}/follow-ups`, { dueDate: today, note: 'Share catalogue' });
    assert.equal(add.status, 201);
    await db.withTenant(bid, (c) => c.query('UPDATE follow_ups SET due_date = $2 WHERE id = $1', [add.json.followUp.id, addDays(today, -3)]));
    const od = await owner.get('/api/follow-ups?view=overdue');
    assert.equal(od.json.items.length, 1);
    assert.equal(od.json.items[0].customerName, 'Anil Kumar R');
    const d = await owner.get('/api/dashboard');
    assert.equal(d.json.stats.overdue, 1);
    assert.equal(d.json.stats.noNextStep, 0);
  });
  await test('complete follow-up with outcome, status change and next follow-up', async () => {
    const r = await owner.post(`/api/follow-ups/${followUpA}/complete`, {
      outcome: 'Visited showroom, liked grey', status: 'interested', next: { dueDate: addDays(today, 2), dueTime: '17:00' },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.nextCreated, true);
    assert.equal(r.json.enquiry.status, 'interested');
    assert.equal(r.json.enquiry.nextFollowUp.dueDate, addDays(today, 2));
    const again = await owner.post(`/api/follow-ups/${followUpA}/complete`, {});
    assert.equal(again.status, 409);
    const done = await owner.get('/api/follow-ups?view=done');
    assert.equal(done.json.items.length, 1);
    assert.equal(done.json.items[0].outcome, 'Visited showroom, liked grey');
    const up = await owner.get('/api/follow-ups?view=upcoming');
    assert.equal(up.json.items.length, 1);
  });
  await test('reschedule and cancel a follow-up', async () => {
    const up = (await owner.get('/api/follow-ups?view=upcoming')).json.items[0];
    const r = await owner.patch(`/api/follow-ups/${up.id}`, { dueDate: addDays(today, 5) });
    assert.equal(r.json.followUp.dueDate, addDays(today, 5));
    const past = await owner.patch(`/api/follow-ups/${up.id}`, { dueDate: addDays(today, -5) });
    assert.equal(past.status, 400);
    const c = await owner.post(`/api/follow-ups/${up.id}/cancel`);
    assert.equal(c.status, 200);
    const c2 = await owner.post(`/api/follow-ups/${up.id}/cancel`);
    assert.equal(c2.status, 409);
  });
  await test('marking lost requires a reason', async () => {
    const r = await owner.post(`/api/enquiries/${enquiryA.id}/status`, { status: 'lost' });
    assert.equal(r.status, 400);
  });
  await test('converting records sale value, cancels pending follow-ups, writes history', async () => {
    await owner.post(`/api/enquiries/${enquiryA.id}/follow-ups`, { dueDate: addDays(today, 1) });
    const r = await owner.post(`/api/enquiries/${enquiryA.id}/status`, { status: 'converted', saleValue: 46500, note: 'Paid advance' });
    assert.equal(r.status, 200);
    assert.equal(r.json.enquiry.status, 'converted');
    assert.equal(r.json.enquiry.saleValue, 46500);
    assert.equal(r.json.enquiry.nextFollowUp, null);
    const d = await owner.get(`/api/enquiries/${enquiryA.id}`);
    assert.ok(d.json.followUps.every((f) => f.status !== 'pending'));
    assert.deepEqual(d.json.history.map((h) => h.toStatus), ['converted', 'interested', 'new']);
    const add = await owner.post(`/api/enquiries/${enquiryA.id}/follow-ups`, { dueDate: addDays(today, 1) });
    assert.equal(add.status, 409);
    const dash = await owner.get('/api/dashboard');
    assert.equal(dash.json.stats.converted, 1);
    assert.equal(dash.json.stats.wonValue, 46500);
    assert.equal(dash.json.stats.wonValueThisMonth, 46500);
  });
  await test('closed enquiry can be reopened', async () => {
    const r = await owner.post(`/api/enquiries/${enquiryA.id}/status`, { status: 'interested', note: 'Wants a second sofa' });
    assert.equal(r.json.enquiry.status, 'interested');
    assert.equal(r.json.enquiry.saleValue, null);
    await owner.post(`/api/enquiries/${enquiryA.id}/status`, { status: 'converted', saleValue: 46500 });
  });

  console.log('\nTenant isolation');
  await test('another business sees none of the data', async () => {
    const list = await other.get('/api/enquiries');
    assert.equal(list.json.total, 0);
    const d = await other.get('/api/dashboard');
    assert.equal(d.json.stats.totalEnquiries, 0);
    const fu = await other.get('/api/follow-ups?view=overdue');
    assert.equal(fu.json.items.length, 0);
  });
  await test('another business cannot read, edit, delete or act on records by id', async () => {
    assert.equal((await other.get(`/api/enquiries/${enquiryA.id}`)).status, 404);
    assert.equal((await other.patch(`/api/enquiries/${enquiryA.id}`, { product: 'hacked' })).status, 404);
    assert.equal((await other.post(`/api/enquiries/${enquiryA.id}/status`, { status: 'lost', lostReason: 'x' })).status, 404);
    assert.equal((await other.post(`/api/enquiries/${enquiryA.id}/follow-ups`, { dueDate: today })).status, 404);
    assert.equal((await other.patch(`/api/customers/${enquiryA.customerId}`, { name: 'hacked' })).status, 404);
    assert.equal((await other.del(`/api/enquiries/${enquiryA.id}`)).status, 404);
    const fu = (await owner.get('/api/follow-ups?view=overdue')).json.items[0];
    assert.equal((await other.post(`/api/follow-ups/${fu.id}/complete`, {})).status, 404);
    assert.equal((await other.post(`/api/follow-ups/${fu.id}/cancel`)).status, 404);
    const check = await owner.get(`/api/enquiries/${enquiryA.id}`);
    assert.equal(check.json.enquiry.product, '3-seater recliner sofa');
  });
  await test('same mobile number in another business is a separate customer', async () => {
    const r = await other.post('/api/enquiries', { name: 'Anil (rival)', mobile: '9845012345', product: 'Scooter', source: 'online' });
    assert.equal(r.status, 201);
    assert.equal(r.json.existingCustomer, false);
    otherEnquiry = r.json.enquiry;
  });
  await test('Row-Level Security blocks cross-tenant SQL even if app code forgot a filter', async () => {
    const rls = await db.rlsStatus();
    if (!rls.enforced) {
      console.log('      (skipped: database role bypasses RLS)');
      return;
    }
    const ownerBid = (await db.query('SELECT business_id FROM users WHERE email = $1', [ownerEmail])).rows[0].business_id;
    const otherBid = (await db.query('SELECT business_id FROM users WHERE email = $1', [otherEmail])).rows[0].business_id;
    const seen = await db.withTenant(ownerBid, (c) => c.query('SELECT business_id FROM enquiries'));
    assert.ok(seen.rows.length >= 2);
    assert.ok(seen.rows.every((r) => r.business_id === ownerBid));
    const leak = await db.withTenant(ownerBid, (c) => c.query('SELECT * FROM enquiries WHERE id = $1', [otherEnquiry.id]));
    assert.equal(leak.rowCount, 0);
    await assert.rejects(
      db.withTenant(ownerBid, (c) => c.query("INSERT INTO customers (business_id, name, mobile) VALUES ($1, 'x', '919999999999')", [otherBid])),
      /row-level security/
    );
    const noTenant = await db.query('SELECT count(*)::int AS n FROM enquiries');
    assert.equal(noTenant.rows[0].n, 0);
  });
  await test('database rejects linking records across businesses (composite FK)', async () => {
    const ownerBid = (await db.query('SELECT business_id FROM users WHERE email = $1', [ownerEmail])).rows[0].business_id;
    await assert.rejects(
      db.withTenant(ownerBid, (c) =>
        c.query("INSERT INTO enquiries (business_id, customer_id, product, source) VALUES ($1, $2, 'x', 'other')", [ownerBid, otherEnquiry.customerId])
      ),
      /foreign key/
    );
  });

  console.log('\nTeam + permissions');
  await test('owner adds a staff member; staff can log in', async () => {
    const r = await owner.post('/api/team', { name: 'Priya', email: staffEmail, password: 'StaffPass1' });
    assert.equal(r.status, 201);
    const l = await staff.post('/api/auth/login', { email: staffEmail, password: 'StaffPass1' });
    assert.equal(l.status, 200);
    assert.equal(l.json.user.role, 'staff');
  });
  await test('staff can work enquiries but cannot use owner-only actions', async () => {
    assert.equal((await staff.get('/api/enquiries')).json.total, 2);
    assert.equal((await staff.patch('/api/settings', { name: 'Hacked' })).status, 403);
    assert.equal((await staff.post('/api/team', { name: 'X', email: `x-${run}@test.local`, password: 'Password1' })).status, 403);
    assert.equal((await staff.get('/api/export.csv')).status, 403);
    assert.equal((await staff.del(`/api/enquiries/${enquiryA.id}`)).status, 403);
    const s = await staff.get('/api/settings');
    assert.equal(s.json.security, undefined);
  });
  await test('other business owner cannot manage this team', async () => {
    const staffId = (await db.query('SELECT id FROM users WHERE email = $1', [staffEmail])).rows[0].id;
    assert.equal((await other.patch(`/api/team/${staffId}`, { isActive: false })).status, 404);
  });
  await test('deactivating staff ends their session immediately', async () => {
    const staffId = (await db.query('SELECT id FROM users WHERE email = $1', [staffEmail])).rows[0].id;
    const r = await owner.patch(`/api/team/${staffId}`, { isActive: false });
    assert.equal(r.json.user.isActive, false);
    assert.equal((await staff.get('/api/dashboard')).status, 401);
    const l = await new Client().post('/api/auth/login', { email: staffEmail, password: 'StaffPass1' });
    assert.equal(l.status, 401);
  });

  console.log('\nSettings + export');
  await test('owner updates settings with validation', async () => {
    const bad = await owner.patch('/api/settings', { timezone: 'Mars/Base' });
    assert.equal(bad.status, 400);
    const r = await owner.patch('/api/settings', { city: 'Belagavi', whatsappTemplate: 'Hi {name}, from {business} about {product}' });
    assert.equal(r.status, 200);
    assert.equal(r.json.business.city, 'Belagavi');
    const s = await owner.get('/api/settings');
    assert.equal(typeof s.json.security.rowLevelSecurity.enforced, 'boolean');
  });
  await test('CSV export contains only this business and neutralises formulas', async () => {
    await owner.post('/api/enquiries', { name: '=HYPERLINK("x")', mobile: '9900112233', product: 'Bed', source: 'referral' });
    const r = await owner.get('/api/export.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.ok(r.text.includes('recliner'));
    assert.ok(!r.text.includes('Scooter'));
    assert.ok(r.text.includes(`"'=HYPERLINK(""x"")"`));
  });
  await test('owner deletes an enquiry; orphan customer is removed', async () => {
    const e = (await owner.get('/api/enquiries?q=bed')).json.items[0];
    const r = await owner.del(`/api/enquiries/${e.id}`);
    assert.equal(r.status, 200);
    assert.equal((await owner.get(`/api/enquiries/${e.id}`)).status, 404);
    assert.equal((await owner.get('/api/enquiries?q=9900112233')).json.total, 0);
  });

  console.log('\nPasswords + lockout');
  await test('change password signs out other sessions', async () => {
    const second = new Client();
    await second.post('/api/auth/login', { email: ownerEmail, password: 'Secret123!' });
    const bad = await owner.post('/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'NewSecret456' });
    assert.equal(bad.status, 401);
    const r = await owner.post('/api/auth/change-password', { currentPassword: 'Secret123!', newPassword: 'NewSecret456' });
    assert.equal(r.status, 200);
    assert.equal((await owner.get('/api/auth/me')).status, 200);
    assert.equal((await second.get('/api/auth/me')).status, 401);
  });
  await test('account locks after repeated failed logins', async () => {
    for (let i = 0; i < 5; i++) await new Client().post('/api/auth/login', { email: otherEmail, password: 'wrong-pass' });
    const r = await new Client().post('/api/auth/login', { email: otherEmail, password: 'Secret123!' });
    assert.equal(r.status, 401);
    assert.match(r.json.error.message, /Too many failed attempts/);
  });
  await test('logout clears the cookie', async () => {
    const r = await owner.post('/api/auth/logout');
    assert.equal(r.status, 200);
    assert.equal((await owner.get('/api/auth/me')).status, 401);
  });

  server.close();
  await db.close();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.close().catch(() => {});
  process.exit(1);
});
