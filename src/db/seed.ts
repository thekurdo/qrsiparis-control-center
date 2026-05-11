/**
 * QrSiparis Control Center — DB seed script (Phase H1).
 *
 * Run via: `pnpm db:seed`
 *
 * Idempotent — checks for an existing default operator user before inserting.
 * Use this to bootstrap the very first Cyxares account on a fresh database.
 *
 * Required env vars:
 *   - DATABASE_URL              Postgres connection string
 *   - DEFAULT_OPERATOR_USER     Username (default: 'admin')
 *   - DEFAULT_OPERATOR_EMAIL    Email (required if seeding)
 *
 * Optional env vars:
 *   - DEFAULT_OPERATOR_PASSWORD If set, used as initial password.
 *                               If unset, a random 24-char password is
 *                               generated and printed to stdout (one-time).
 *   - DEFAULT_OPERATOR_NAME     Full name (default: 'Cyxares Admin')
 *
 * Security notes:
 *   - 2FA is NOT enabled at seed time. Cyxares enables 2FA at first login
 *     via the /2fa-setup screen (Phase H2). Until then, the random password
 *     is the sole credential — store it in a password manager, don't reuse.
 *   - The seeded password hash uses bcrypt cost 12 (Auth.js v5 default).
 *   - This script is safe to re-run: if the user exists, it logs and exits
 *     0 without touching the row.
 */

import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

import { closePool, getDb } from './client';
import { operatorUsers } from './schema';

const BCRYPT_COST = 12;
const RANDOM_PASSWORD_LEN = 24;

function generateRandomPassword(): string {
  // 24 URL-safe chars sourced from a crypto-strong RNG. Avoids ambiguous
  // characters by using base64url which excludes '+' '/' '='.
  return crypto.randomBytes(18).toString('base64url').slice(0, RANDOM_PASSWORD_LEN);
}

async function main(): Promise<void> {
  const username = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
  const email = process.env['DEFAULT_OPERATOR_EMAIL'];
  const fullName = process.env['DEFAULT_OPERATOR_NAME'] ?? 'Cyxares Admin';
  const presetPassword = process.env['DEFAULT_OPERATOR_PASSWORD'];

  if (!email) {
    throw new Error(
      '[seed] DEFAULT_OPERATOR_EMAIL is required. Set it in `.env` and re-run.',
    );
  }

  const db = getDb();

  const existing = await db
    .select({ id: operatorUsers.id, username: operatorUsers.username })
    .from(operatorUsers)
    .where(eq(operatorUsers.username, username))
    .limit(1);

  if (existing.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[seed] Operator user "${username}" already exists (id=${existing[0]!.id}). Skipping.`,
    );
    return;
  }

  const password = presetPassword ?? generateRandomPassword();
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  const [created] = await db
    .insert(operatorUsers)
    .values({
      username,
      email,
      fullName,
      passwordHash,
      // Backup codes intentionally empty until 2FA is enabled in Phase H2.
      twoFactorBackupCodes: [],
      twoFactorEnabled: false,
      role: 'admin',
      isActive: true,
    })
    .returning({ id: operatorUsers.id, username: operatorUsers.username });

  // eslint-disable-next-line no-console
  console.log(`[seed] Created operator user id=${created!.id} username=${created!.username}`);

  if (!presetPassword) {
    // eslint-disable-next-line no-console
    console.log(
      `[seed] Initial password (store in password manager, this is shown ONCE):\n  ${password}\n` +
        `[seed] Sign in at /login then set up 2FA at /2fa-setup.`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log('[seed] Used DEFAULT_OPERATOR_PASSWORD from env (no random password generated).');
  }
}

void main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
