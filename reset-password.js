'use strict';
// Emergency password reset for any account (e.g. an owner who forgot theirs).
// Usage: npm run reset-password -- owner@example.com "NewPassword123"
// Run it from a trusted machine with DATABASE_URL pointing at production.
const db = require('./db');
const { hashPassword } = require('./auth');

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password || password.length < 8) {
    console.error('Usage: npm run reset-password -- <email> <new-password (min 8 chars)>');
    process.exit(1);
  }
  const hash = await hashPassword(password);
  const { rowCount } = await db.query(
    `UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL,
            token_version = token_version + 1, updated_at = now()
      WHERE lower(email) = lower($1)`,
    [email.trim(), hash]
  );
  console.log(rowCount ? `Password reset for ${email}. All their sessions were signed out.` : `No user found with email ${email}.`);
  await db.close();
  process.exit(rowCount ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Failed:', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
