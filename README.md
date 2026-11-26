# FollowUp Pro

Never miss a customer follow-up. FollowUp Pro helps shop and showroom owners record every enquiry (walk-in, phone, WhatsApp, online) in about 10 seconds. Each morning it shows exactly who to contact, with one tap to call or open WhatsApp.

## What it does

- **Today screen:** overdue and due-today calls, six key numbers, sales won this month, and a list of **open customers with no next step** (the leak this product exists to plug).
- **Customers:** search by name, mobile or product, and filter by status (New, Interested, Follow-up, Converted, Lost).
- **Customer detail:** Call (`tel:`) and WhatsApp (official `wa.me` click-to-chat with a pre-filled message) buttons, a status bar, follow-up timeline and status history.
- **Follow-ups:** Overdue / Today / Upcoming / Done tabs. Logging an outcome asks "what happens next?", so no customer silently drops off the list.
- **Repeat customers:** the same mobile number is linked to the same customer, never duplicated.
- **Team:** the owner adds staff accounts. Staff work leads; only the owner changes settings, exports data or deletes records.
- **Your data:** the owner can export everything to CSV at any time.

WhatsApp and Call buttons only **open** WhatsApp or the phone dialler. Nothing is sent automatically, and the app never claims it was.

## Quick start (local)

Requirements: Node.js 20+ and a PostgreSQL 14+ database.

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL and JWT_SECRET
npm run migrate             # creates tables (also happens automatically on first request)
npm run dev                 # http://localhost:3000
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run locally with auto-reload (reads `.env`) |
| `npm start` | Run the server |
| `npm run migrate` | Apply pending database migrations |
| `npm test` | Full end-to-end API test suite against `DATABASE_URL`. **Use a dev database, never production.** |
| `npm run reset-password -- email "NewPass123"` | Emergency password reset for any account |

## Files

The project is intentionally flat: every file sits at the root and there are no folders.

| File | Purpose |
|---|---|
| `server.js` | Express app: security headers, CSRF check, static files, API mounting, error handling. Vercel detects this automatically. |
| `routes-auth.js` | Sign up, sign in, sign out, change password |
| `routes-app.js` | Dashboard, enquiries, customers, follow-ups |
| `routes-settings.js` | Business settings, team, CSV export |
| `auth.js` | Password hashing, sessions, permission checks, rate limiting |
| `db.js` | Postgres pool, transactions, tenant context for Row-Level Security, migration runner |
| `migrations.js` | Versioned database schema |
| `validation.js` | Server-side input validation (zod) and phone number normalisation |
| `errors.js`, `logger.js` | Error types and structured JSON logging |
| `index.html`, `styles.css`, `client.js`, `icons.js` | The web app (no build step) |
| `inter.woff2`, `favicon.svg`, `manifest.webmanifest` | Font (self-hosted Inter, OFL licence), icon, install manifest |
| `migrate.js`, `reset-password.js`, `test.js` | Command-line tools |
| `DEPLOYMENT.md` | Step-by-step production deployment, backups, monitoring |
| `ARCHITECTURE.md` | Product assessment, architecture, schema, API, security, roadmap |

Icons: Lucide (ISC licence). Font: Inter (SIL Open Font Licence).
