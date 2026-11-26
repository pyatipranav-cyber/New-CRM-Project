'use strict';
// Applies pending database migrations. Usage: npm run migrate
// (The server also applies them automatically on first request unless AUTO_MIGRATE=false.)
const db = require('./db');

db.runMigrations()
  .then((applied) => {
    console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date.');
    return db.close();
  })
  .catch(async (err) => {
    console.error('Migration failed:', err.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
