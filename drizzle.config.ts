import type { Config } from 'drizzle-kit';

if (!process.env['DATABASE_URL']) {
  // Allow generation without env (e.g. CI dry-run); but warn the user.
  // eslint-disable-next-line no-console
  console.warn(
    '[drizzle.config] DATABASE_URL not set. drizzle-kit migrate/studio will fail until it is provided.',
  );
}

export default {
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://invalid-placeholder',
  },
  strict: true,
  verbose: true,
} satisfies Config;
