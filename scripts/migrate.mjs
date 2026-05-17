// Programmatic migration runner that surfaces actual errors instead of letting
// drizzle-kit's CLI swallow them in a spinner.
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL missing');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

try {
  console.log('[migrate] applying migrations from drizzle/migrations ...');
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  console.log('[migrate] done');
} catch (e) {
  console.error('[migrate] FAILED:', e);
  process.exit(1);
} finally {
  await pool.end();
}
