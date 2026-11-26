# FollowUp Pro: product and architecture

## 1. Honest assessment

**Is the need real?** Yes. Showrooms lose sales because nobody calls the customer back. But owners do not see this as a software problem. They "solve" it with a register, a WhatsApp chat or memory. The real competitor is **the free WhatsApp Business app and a notebook**, not other CRMs.

**Will they pay?** Low-ticket shops (kirana, general stores) will not. High-ticket, long-decision showrooms will, **if they can see the money recovered**: two-wheelers and cars, furniture, electronics and appliances, tiles and sanitaryware, jewellery, mobiles. A realistic price is ₹299–799 per shop per month. Free and paid tools already exist (Privyr has a free plan, Zoho Bigin has a free tier, TeleCRM is around ₹599/user/month). The edge has to be **faster and simpler for walk-ins**, not more features.

**What kills it, in order:**

1. **Data-entry friction.** If adding a walk-in takes more than about 15 seconds, staff stop by day three. The Add Customer form needs three fields and one tap for the date.
2. **No push reminder.** A list only works if someone opens it. This MVP has no SMS/WhatsApp/push alerts. Automated WhatsApp needs the paid WhatsApp Business API and is not faked here. Phase 2: free web-push or a daily digest.
3. **Distribution.** At ₹500/month, online ads will cost more than a customer is worth. It needs feet on the street, one city and one vertical at a time.
4. **Churn after the novelty fades.** The "Sales won this month" number exists so the owner can see the tool paying for itself.

**Deliberately not built:** billing, inventory, quotations, campaigns, AI features, lead assignment, and automated messaging.

**Simplest sellable version:** a 10-second add, the Today list, one-tap Call/WhatsApp, "Done and set the next date", and the value-won number. Everything else is secondary.

## 2. Stack and why

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js + Express 5 | Boring and well understood. Vercel deploys `server.js` as one function with zero config, so no `api/` folder is needed and the flat file layout works. |
| Database | PostgreSQL (Neon on Vercel; any Postgres works) | Relational data, transactions, constraints and Row-Level Security; real backups |
| DB access | `pg` with hand-written SQL | No ORM magic; every query is visible and checkable for tenant filtering |
| Validation | zod | One schema per endpoint, server-side, with field-level messages |
| Auth | bcrypt (cost 11) + JWT in an httpOnly, SameSite=Strict cookie | Stateless and serverless-friendly; revocable via `token_version` |
| Frontend | Vanilla JS single-page app, no build step | Six screens do not justify a framework and build pipeline; nothing can break at build time. Move to React if the UI grows past about 15 screens. |
| Styling | Hand-written CSS, self-hosted Inter, Lucide icons | No CDN calls, so the Content Security Policy can be strict (`'self'` only) |

## 3. Architecture

```
Browser (client.js SPA, hash routes)
   │  fetch /api/*  (session cookie + X-Requested-With header)
   ▼
Vercel Function: server.js (Express)
   ├─ helmet: strict CSP, HSTS, frame-deny, no-sniff
   ├─ CSRF guard: custom header + Origin check on mutations
   ├─ ensureMigrated(): versioned migrations, once per instance, advisory-locked
   ├─ /api/auth/*      routes-auth.js     (rate-limited, account lockout)
   ├─ requireAuth      verifies JWT, then re-loads user (active? token_version?)
   ├─ routes-app.js    dashboard, enquiries, customers, follow-ups
   └─ routes-settings.js  business settings, team, CSV export (owner-only parts)
   │
   ▼  db.withTenant(businessId): BEGIN; set_config('app.business_id'); …; COMMIT
PostgreSQL (RLS forced on tenant tables)
```

## 4. Data model

```
businesses 1─* users            (role: owner | staff)
businesses 1─* customers        UNIQUE(business_id, mobile): repeat visitors are linked
customers  1─* enquiries        status: new | interested | follow_up | converted | lost
enquiries  1─* follow_ups       status: pending | done | cancelled
enquiries  1─* status_history   every status change, who and when
schema_migrations               applied versions
```

Key decisions:

- **Status belongs to the enquiry, not the customer.** One person can buy a sofa and still be deciding on a dining set.
- **The next follow-up date is derived** as the earliest pending follow-up. It is never stored twice, so it cannot drift out of sync.
- **Closing** an enquiry (converted or lost) cancels its pending follow-ups automatically. **Lost requires a reason**, which is valuable data for the owner.
- **Composite foreign keys** `(id, business_id)` mean the database itself refuses to link records across businesses.
- **Money** is `numeric(14,2)`. **Due dates** are `date` plus an optional `time`, and "today" is computed in the business's time zone.

## 5. API

All endpoints are JSON under `/api`. Mutations need the header `X-Requested-With: FollowUpPro`.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Public; database check |
| POST | `/auth/signup`, `/auth/login`, `/auth/logout` | Rate-limited; lockout after 5 failures |
| GET | `/auth/me` | Current user and business |
| POST | `/auth/change-password` | Signs out other devices |
| GET | `/dashboard` | Stats, overdue, due today, no-next-step |
| GET | `/enquiries?status=&q=&page=` | `status`: open, all, or a single status; search by name, mobile or product |
| POST | `/enquiries` | Creates or links the customer, the enquiry and the first follow-up in one transaction |
| GET / PATCH / DELETE | `/enquiries/:id` | DELETE is owner-only |
| POST | `/enquiries/:id/status` | Writes history; closing cancels pending follow-ups |
| POST | `/enquiries/:id/follow-ups` | Only for open enquiries; no past dates |
| PATCH | `/customers/:id` | Name, mobile (unique per business), notes |
| GET | `/follow-ups?view=overdue\|today\|upcoming\|done` | |
| POST | `/follow-ups/:id/complete` | Outcome, optional status change, optional next follow-up, all in one transaction |
| PATCH | `/follow-ups/:id` | Reschedule |
| POST | `/follow-ups/:id/cancel` | |
| GET / PATCH | `/settings` | PATCH is owner-only |
| GET / POST / PATCH | `/team`, `/team/:id` | Owner-only mutations; deactivating signs the user out immediately |
| GET | `/export.csv` | Owner-only; protected against formula injection |

Errors use the shape `{ error: { code, message, details: { fields } } }`. Database internals are never leaked.

## 6. Security summary

- Passwords are hashed with bcrypt, with the same timing whether or not an account exists, and a generic error message.
- Sessions use an HS256 JWT in an `HttpOnly; Secure; SameSite=Strict` cookie. The user is re-validated on every request, so deactivation or a password change works immediately.
- CSRF: SameSite=Strict, plus a required custom header (forcing a CORS preflight that is never granted), plus an Origin check.
- XSS: all user text is rendered with `textContent`, and a strict CSP allows no inline scripts or third-party origins.
- SQL injection: parameterised queries only; IDs are validated as UUIDs; LIKE wildcards are escaped.
- Tenant isolation: app-level filters, composite foreign keys and forced Row-Level Security.
- Request body limit is 50 KB. Responses send no `x-powered-by` header and API responses are `Cache-Control: no-store`.
- No secrets exist in the frontend. `.env` is git-ignored.

## 7. Screens

1. **Sign in / Create account.** A brand panel shows a sample call list; one simple form.
2. **Today.** A one-sentence summary ("Call 4 customers today, 2 are overdue."), the three main actions, a metrics band and the call list (overdue, then due today) with Call, WhatsApp and Log buttons. Side panels show sales won this month and "No next step".
3. **Customers.** Search, status filter chips and a paged list.
4. **Customer detail.** Call, WhatsApp and Edit; status bar; facts; follow-ups with Log outcome, Reschedule and Cancel; history; other enquiries; owner delete.
5. **Follow-ups.** Overdue, Today, Upcoming and Done tabs.
6. **Settings.** Business details, WhatsApp template with live preview, team, account, CSV export and data-protection status.
7. **Sheets.** Add customer, Add follow-up (with customer search), Log outcome ("what happens next?"), Reschedule, Mark converted or lost, Edit, and confirmations.

The desktop layout uses a sidebar. On mobile there is a bottom tab bar with a centre "+" button, and sheets slide up from the bottom.

## 8. Roadmap

- **Phase 1 (this MVP):** everything above.
- **Phase 2 (retention):**
  - web-push reminders when follow-ups are due, using the free Web Push API
  - a morning digest to the owner
  - assigning leads to staff, with a per-salesperson view
  - CSV import from an existing register
- **Phase 3 (only once shops are paying):**
  - WhatsApp Business API for templated reminders sent to the owner's own staff
  - monthly "recovered sales" report
  - multi-branch support
