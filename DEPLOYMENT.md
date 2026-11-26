# Deployment guide

The target is **Vercel** for the app and **Neon Postgres** for the database. Both have free tiers. Any PostgreSQL 14+ database works, including Supabase, AWS RDS or a VPS.

## 1. Put the code on GitHub

1. Create a new **private** repository on GitHub, for example `followup-pro`.
2. Upload every file from the zip to the repository root. Use the web uploader's drag-and-drop, or `git push`.
3. Do **not** upload a `.env` file. `.gitignore` already blocks it.

## 2. Create the Vercel project

1. In Vercel, choose **Add New → Project** and import the repository.
2. Vercel detects **Express** automatically from `server.js`. Leave the Build Command, Output Directory and Install Command at their defaults.
3. Don't deploy yet. Add the database and secrets first (steps 3 and 4).

## 3. Add the database (Neon, via Vercel Marketplace)

1. In the Vercel project, open **Storage → Create Database → Neon** (Serverless Postgres).
2. Choose the region closest to your customers. For India that's `aws-ap-south-1` (Mumbai).
3. Connect it to the project for **Production** and **Preview**. Vercel adds `DATABASE_URL` automatically.
4. In **Settings → Functions**, set the function region to the same area, e.g. `bom1` Mumbai. This keeps every database query short.
5. Recommended: give Preview deployments their own Neon branch so testing never touches real customer data.

The app also accepts `POSTGRES_URL` if your integration names it that way.

**Using Supabase instead?** Put the **pooled** connection string in `DATABASE_URL`. If connections fail with `self-signed certificate in certificate chain`, also set `DB_SSL_NO_VERIFY=true`. Traffic stays encrypted; only the certificate-chain check is relaxed.

## 4. Environment variables

In **Settings → Environment Variables**, add:

| Name | Value | Environments |
|---|---|---|
| `JWT_SECRET` | 64 random hex characters (see below) | Production (and a *different* value for Preview) |
| `DATABASE_URL` | added by Neon in step 3 | all |

To generate a secret, run this on any computer with Node installed:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Secrets live only in Vercel's environment settings. The browser code never sees them; the frontend has no keys at all.

Optional variables: `SESSION_DAYS` (default 30), `LOG_LEVEL` (default `info`), `AUTO_MIGRATE` (default `true`), `PG_POOL_MAX` (default 5).

## 5. Deploy

Click **Deploy**. On the first request the app creates its tables automatically. Migrations are versioned, run inside a transaction and are protected by a lock, so parallel cold starts are safe.

Then check:

1. Open `https://<your-app>.vercel.app/api/health`. It should return `{"ok":true,...,"database":"ok"}`.
2. Open the site, create your account, add a test customer, and tap Call and WhatsApp on a phone.
3. Go to **Settings → Data protection**. It shows whether database Row-Level Security is active (see section 7).

From now on, every push to `main` deploys to production and every other branch gets a preview URL. If a deploy goes wrong, use **Instant Rollback** in Vercel.

## 6. Custom domain

Go to **Settings → Domains**, add e.g. `app.yourdomain.in`, and follow the DNS instructions. HTTPS is automatic. The session cookie is `Secure`, `HttpOnly` and `SameSite=Strict` in production.

## 7. Database security hardening (recommended)

Customer data is separated between businesses at three layers:

1. **Application:** every query filters by the signed-in user's business.
2. **Database constraints:** composite foreign keys make it impossible to attach one business's follow-up or enquiry to another business's customer.
3. **Postgres Row-Level Security (RLS):** even a query that forgot its filter only sees the current business's rows.

Layer 3 only works if the database user **does not bypass RLS**. Superusers and roles with `BYPASSRLS` skip it. Some providers' default users are like this, and Settings will then show a warning. Layers 1 and 2 still protect you, but to make RLS active, use a dedicated app role.

**Do this before the first deploy.** In the Neon SQL editor, connected as the default owner:

```sql
CREATE ROLE followup_app LOGIN PASSWORD 'use-a-long-random-password' NOSUPERUSER NOBYPASSRLS;
GRANT ALL ON SCHEMA public TO followup_app;
```

Then change `DATABASE_URL` in Vercel to use `followup_app` and its password, keeping the same host and database. Redeploy. The tables will be created and owned by `followup_app`, and RLS is forced on them. Settings should now say "Database row-level security is active."

If tables already exist under another user, transfer them once with `ALTER TABLE <name> OWNER TO followup_app;` for each table, or start from a fresh database.

## 8. Logging and monitoring

- The app writes **structured JSON logs**: one line per API request with method, path, status, duration and user id, plus warnings for failed logins and errors with a request id. View them in Vercel → **Logs**. Users see the request id in error messages, so you can find the matching log line.
- Passwords, cookies and request bodies are never logged.
- **Uptime:** point a free monitor (UptimeRobot, Better Stack, etc.) at `/api/health`. It returns HTTP 503 when the database is unreachable.
- **Long-term logs and alerts:** add a Vercel **Log Drain** to Better Stack, Datadog or similar, and alert on `"level":"error"`.

## 9. Backups

| Layer | What | How |
|---|---|---|
| Point-in-time restore | Neon keeps a change history and can restore or branch to an earlier moment | Neon console → Restore. Check your plan's restore window; the free tier's is short. |
| Weekly off-site dump | A full SQL copy kept outside Neon | `pg_dump "$DATABASE_URL" -Fc -f followup-$(date +%F).dump` from a trusted machine or a scheduled GitHub Action; keep it in private cloud storage |
| Owner export | Each business can download its own data | Settings → Export to CSV |

**Test a restore at least once:** `pg_restore -d "<empty test database url>" followup-YYYY-MM-DD.dump`, then point a local copy of the app at it.

## 10. Day-two operations

- **Forgotten owner password:** from a trusted machine with production `DATABASE_URL` in `.env`, run `npm run reset-password -- owner@shop.in "NewPassword123"`. All their sessions are signed out.
- **Schema changes:** add a new entry with the next version number to `migrations.js`. Never edit a deployed migration. Deploy; it applies on the next cold start. You can also run `npm run migrate` first and set `AUTO_MIGRATE=false` if you prefer manual control.
- **Rotate `JWT_SECRET`:** change it in Vercel and redeploy. Everyone is signed out once.
- **Rate limiting:** the login lockout (5 failures locks the account for 15 minutes) is enforced in the database. The per-IP limiter is per server instance, so for public launch also add a Vercel Firewall rate-limit rule on `/api/auth/*`.

## 11. Pre-launch checklist

- [ ] `/api/health` returns ok on the production URL
- [ ] `JWT_SECRET` is set, random and different between Production and Preview
- [ ] Settings shows "Database row-level security is active"
- [ ] Custom domain on HTTPS
- [ ] Uptime monitor on `/api/health`
- [ ] First `pg_dump` taken and a restore tested
- [ ] Tested on a real Android phone: Call opens the dialler, WhatsApp opens the chat with the message pre-filled
