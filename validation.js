'use strict';
const { z } = require('zod');
const { badRequest } = require('./errors');

const STATUSES = ['new', 'interested', 'follow_up', 'converted', 'lost'];
const OPEN_STATUSES = ['new', 'interested', 'follow_up'];
const SOURCES = ['walk_in', 'phone', 'whatsapp', 'online', 'referral', 'other'];

// Empty strings from forms become null so optional fields behave predictably.
const emptyToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);

const text = (max, label) =>
  z.string({ error: `${label} is required.` }).trim().min(1, `${label} is required.`).max(max, `${label} is too long.`);

const optText = (max, label) =>
  z.preprocess(
    emptyToNull,
    z.string().trim().max(max, `${label} is too long (max ${max} characters).`).nullable().optional()
  );

function isRealDate(s) {
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const dateStr = (label) =>
  z.string({ error: `${label} is required.` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a valid date.`)
    .refine(isRealDate, `${label} must be a valid date.`)
    .refine((s) => s >= '2000-01-01' && s <= '2100-12-31', `${label} is out of range.`);

const optDate = (label) => z.preprocess(emptyToNull, dateStr(label).nullable().optional());

const optTime = z.preprocess(
  emptyToNull,
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be in HH:MM format.').nullable().optional()
);

const money = (label) =>
  z.preprocess(
    (v) => {
      v = emptyToNull(v);
      if (typeof v === 'string') return Number(v.replace(/[,\s₹]/g, ''));
      return v;
    },
    z.number({ error: `${label} must be a number.` })
      .finite(`${label} must be a number.`)
      .min(0, `${label} cannot be negative.`)
      .max(999_999_999_999, `${label} is too large.`)
      .nullable()
      .optional()
  );

const email = z
  .string({ error: 'Email is required.' })
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long.')
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Enter a valid email address.');

const password = z
  .string({ error: 'Password is required.' })
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password is too long.');

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/**
 * Normalises a phone number to digits including country code (E.164 without "+").
 * "98450 12345" -> "919845012345" when the business country code is 91.
 * Returns null when the number is not plausible.
 */
function normalizeMobile(raw, countryCode = '91') {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let s = String(raw).trim();
  const international = s.startsWith('+') || s.startsWith('00');
  let digits = s.replace(/\D/g, '');
  if (international) {
    if (s.startsWith('00')) digits = digits.slice(2);
  } else {
    digits = digits.replace(/^0+/, '');
    if (digits.length <= 10) digits = countryCode + digits;
    else if (!digits.startsWith(countryCode)) return null;
  }
  if (!/^[0-9]{8,15}$/.test(digits)) return null;
  // Indian mobiles: 91 + 10 digits starting 6-9.
  if (digits.startsWith('91') && digits.length !== 12 && countryCode === '91' && !international) return null;
  if (digits.startsWith('91') && digits.length === 12 && !/^91[6-9]/.test(digits)) return null;
  return digits;
}

const mobile = z.string({ error: 'Mobile number is required.' }).trim().min(1, 'Mobile number is required.').max(25);

function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const fields = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    const first = Object.values(fields)[0] || 'Invalid input.';
    throw badRequest(first, { fields });
  }
  return result.data;
}

const schemas = {
  signup: z.object({
    businessName: text(120, 'Business name').refine((s) => s.length >= 2, 'Business name is too short.'),
    name: text(100, 'Your name'),
    email,
    password,
  }),
  login: z.object({ email, password: z.string().min(1, 'Password is required.').max(128) }),
  changePassword: z.object({
    currentPassword: z.string().min(1, 'Current password is required.').max(128),
    newPassword: password,
  }),
  createEnquiry: z.object({
    name: text(120, 'Customer name'),
    mobile,
    product: text(160, 'Product'),
    source: z.enum(SOURCES, { error: 'Choose where the enquiry came from.' }),
    estimatedValue: money('Estimated value'),
    enquiryDate: optDate('Enquiry date'),
    nextFollowUpDate: optDate('Next follow-up date'),
    nextFollowUpTime: optTime,
    notes: optText(2000, 'Notes'),
  }),
  updateEnquiry: z.object({
    product: text(160, 'Product').optional(),
    source: z.enum(SOURCES).optional(),
    estimatedValue: money('Estimated value'),
    enquiryDate: dateStr('Enquiry date').optional(),
    notes: optText(2000, 'Notes'),
  }),
  updateCustomer: z.object({
    name: text(120, 'Customer name').optional(),
    mobile: mobile.optional(),
    notes: optText(2000, 'Notes'),
  }),
  changeStatus: z.object({
    status: z.enum(STATUSES, { error: 'Choose a valid status.' }),
    note: optText(1000, 'Note'),
    saleValue: money('Sale value'),
    lostReason: optText(300, 'Reason'),
  }),
  createFollowUp: z.object({
    dueDate: dateStr('Follow-up date'),
    dueTime: optTime,
    note: optText(1000, 'Note'),
  }),
  updateFollowUp: z.object({
    dueDate: dateStr('Follow-up date').optional(),
    dueTime: optTime,
    note: optText(1000, 'Note'),
  }),
  completeFollowUp: z.object({
    outcome: optText(1000, 'Outcome'),
    status: z.enum(STATUSES).optional(),
    saleValue: money('Sale value'),
    lostReason: optText(300, 'Reason'),
    next: z
      .object({ dueDate: dateStr('Next follow-up date'), dueTime: optTime, note: optText(1000, 'Note') })
      .nullable()
      .optional(),
  }),
  settings: z.object({
    name: text(120, 'Business name').optional(),
    phone: optText(25, 'Phone'),
    city: optText(80, 'City'),
    timezone: z
      .string()
      .max(60)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown time zone.')
      .optional(),
    countryCode: z.string().regex(/^[0-9]{1,4}$/, 'Country code must be 1-4 digits, e.g. 91.').optional(),
    whatsappTemplate: text(1000, 'WhatsApp message').optional(),
  }),
  createStaff: z.object({ name: text(100, 'Name'), email, password }),
  updateStaff: z.object({ isActive: z.boolean().optional(), password: password.optional() }),
};

module.exports = { schemas, parse, normalizeMobile, uuid, STATUSES, OPEN_STATUSES, SOURCES };
