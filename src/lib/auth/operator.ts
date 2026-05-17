/**
 * Auth.js v5 (next-auth@5.0.0-beta.25) configuration for the operator panel.
 *
 * Wires together:
 *   - Drizzle adapter for PostgreSQL (NOT SQLite — the customer-facing app
 *     uses SQLite, control-center uses Postgres per Doc 17 §2)
 *   - Credentials provider with username + password + optional 2FA
 *   - JWT session strategy, 7-day max age (Doc 17 §3 contract)
 *   - Custom callbacks to surface `role` + `username` on the session object
 *
 * Why JWT and not database sessions:
 *   The control-center is small (≤ 5 operator users). DB-session would add
 *   a query per request for no real benefit; JWT keeps the auth layer
 *   stateless and fits the existing middleware pattern.
 *
 * --- AUDIT LOGGING POLICY ---
 * Each branch in `authorize()` is annotated with the audit action that the
 * CALLER (the route handler invoking `signIn` / `auth`) should write into
 * `audit_log`. We do NOT write inline because the audit row needs the IP
 * and user-agent (which are request-scoped, not credentials-scoped) and
 * the call site has access to those headers.
 *
 *   Suggested audit actions (write from the calling endpoint):
 *     `operator.login.success`     — authorize() returned the user
 *     `operator.login.invalid`     — bad password / unknown username
 *     `operator.login.locked_out`  — within failedLoginLockedUntil window
 *     `operator.login.needs_2fa`   — pwd OK but no TOTP/backup supplied
 *     `operator.login.invalid_totp`— wrong TOTP
 *     `operator.login.backup_code_used` — successful backup-code login
 *     `operator.logout`            — write from a sign-out endpoint
 *
 * --- BRUTE-FORCE PROTECTION (R12) ---
 * After 5 failed attempts within the configured window, the user is locked
 * out for 15 minutes via `failed_login_locked_until`. The atomic SQL update
 * ensures concurrent failures don't race the counter.
 *
 *   `failed_login_attempts` is reset to 0 on every successful login.
 *
 * --- TIMING-ATTACK PROTECTION ---
 * On a username-not-found path we still call `fakeBcryptDelay()` so the
 * response time matches a real-password-mismatch path.
 *
 * --- NEEDS_2FA SIGNAL ---
 * When the password is valid but 2FA is enabled and the request didn't
 * include a TOTP/backup code, we throw with the literal string
 * `'NEEDS_TWO_FACTOR'`. The login route handler catches that, returns the
 * `NEEDS_TWO_FACTOR` error code via `errorResponse`, and the UI redirects
 * to /2fa-verify. Auth.js's CredentialsSignin error class is too coarse
 * to distinguish these cases, so we use `Error.message` as the channel.
 */

import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { eq, sql } from 'drizzle-orm';
import NextAuth, { CredentialsSignin, type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

import { db, getDb } from '@/db/client';
import { operatorUsers } from '@/db/schema';
import { decrypt } from '@/lib/crypto/aes-gcm';

import { verifyAndConsumeBackupCode } from './backup-codes';
import { comparePassword, fakeBcryptDelay } from './password';
import { verifyTotpCode } from './totp';

/**
 * Auth.js v5 throws our symbolic errors back at the client as the URL
 * `?code=` parameter (the `?error=` parameter is always the error TYPE,
 * i.e. `'CredentialsSignin'`). For any custom symbolic code to round-trip
 * to the login page, we must throw a `CredentialsSignin` subclass (or
 * instance) with `code` set — a plain `new Error('LOCKED_OUT')` gets
 * wrapped as `CallbackRouteError` and silently becomes `error=Configuration`
 * client-side, which is the catch-all "something went wrong" path.
 *
 * `code` is exposed in the URL, so do NOT include secrets / PII here.
 */
class CredentialsAuthError extends CredentialsSignin {
  constructor(public override code: string) {
    super();
  }
}

// ---------------------------------------------------------------------------
// Module-augmentation: extend Session/User/JWT with our custom claims
// ---------------------------------------------------------------------------

declare module 'next-auth' {
  /**
   * Returned on `authorize()` and stamped onto the JWT/Session.
   * `username` and `role` are surfaced for fast permission checks in
   * `requireOperatorAuth`.
   */
  interface User {
    username: string;
    role: 'admin' | 'operator';
  }

  interface Session {
    user: {
      id: string;
      username: string;
      role: 'admin' | 'operator';
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role?: 'admin' | 'operator';
    username?: string;
  }
}

// ---------------------------------------------------------------------------
// Brute-force tuning constants (R12)
// ---------------------------------------------------------------------------

/** Lock the account for 15 minutes after this many failed attempts. */
const MAX_FAILED_ATTEMPTS = 5;

/** Lockout duration. */
const LOCKOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Auth.js config
// ---------------------------------------------------------------------------

/**
 * Symbolic error messages thrown out of `authorize()`. The login route
 * handler maps these to typed `ApiBaseError`s when the Credentials
 * provider rejects a sign-in.
 */
export const AUTH_ERRORS = {
  INVALID: 'INVALID_CREDENTIALS',
  LOCKED: 'LOCKED_OUT',
  NEEDS_2FA: 'NEEDS_TWO_FACTOR',
  INVALID_TOTP: 'INVALID_TOTP',
  INVALID_BACKUP: 'INVALID_BACKUP_CODE',
  TWO_FACTOR_NOT_ENABLED: 'TWO_FACTOR_NOT_ENABLED',
} as const;

export const authConfig = {
  // The Drizzle adapter handles the standard Auth.js tables (User, Session,
  // Account, VerificationToken). We use `operator_users` as our domain
  // table; the adapter's tables are unused under JWT strategy but the
  // adapter is still required for type-coherent provider wiring.
  //
  // IMPORTANT: pass the underlying Drizzle instance (`getDb()`), NOT the
  // Proxy-wrapped `db` re-export from `db/client.ts`. The adapter uses
  // Drizzle's `is(value, PgDatabase)` brand check which inspects the
  // prototype chain — the Proxy's empty target `{}` has the wrong
  // prototype and the brand check fails with "Unsupported database type".
  adapter: DrizzleAdapter(getDb()),

  session: {
    strategy: 'jwt' as const,
    maxAge: 60 * 60 * 24 * 7, // 7 days (Doc 17 §3)
  },

  // Auth.js v5 reads NEXTAUTH_SECRET / AUTH_SECRET from env automatically.
  // We don't set `secret` here so the env var is the single source of truth.
  // The `trustHost: true` flag is required for Coolify-fronted Next deployments.
  trustHost: true,

  pages: {
    signIn: '/login',
  },

  providers: [
    Credentials({
      // The Credentials provider's `credentials` config is documentation +
      // a hint to the default signin form. We're using a custom /login
      // page anyway, so these labels are mostly for the auto-generated
      // form fallback.
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
        totpCode: { label: '2FA Code', type: 'text' },
        backupCode: { label: 'Backup Code', type: 'text' },
      },

      async authorize(credentials) {
        const username = typeof credentials?.['username'] === 'string'
          ? credentials['username']
          : '';
        const password = typeof credentials?.['password'] === 'string'
          ? credentials['password']
          : '';
        const totpCode = typeof credentials?.['totpCode'] === 'string'
          ? credentials['totpCode']
          : '';
        const backupCode = typeof credentials?.['backupCode'] === 'string'
          ? credentials['backupCode']
          : '';

        if (!username || !password) {
          // Generic error — no user enumeration leak.
          // AUDIT: caller writes `operator.login.invalid` with reason='missing_fields'.
          throw new CredentialsAuthError(AUTH_ERRORS.INVALID);
        }

        // 1. Look up the user (active only)
        const rows = await db
          .select()
          .from(operatorUsers)
          .where(eq(operatorUsers.username, username))
          .limit(1);

        const user = rows[0];

        // Username unknown OR inactive — burn time so the response is
        // indistinguishable from a wrong-password compare.
        if (!user || !user.isActive) {
          await fakeBcryptDelay();
          // AUDIT: caller writes `operator.login.invalid` with username on the metadata.
          throw new CredentialsAuthError(AUTH_ERRORS.INVALID);
        }

        // 2. Lockout window check — even a correct password is rejected.
        const now = Date.now();
        if (
          user.failedLoginLockedUntil &&
          user.failedLoginLockedUntil.getTime() > now
        ) {
          // AUDIT: caller writes `operator.login.locked_out` with retryAfter metadata.
          throw new CredentialsAuthError(AUTH_ERRORS.LOCKED);
        }

        // 3. Compare password
        const passwordOk = await comparePassword(password, user.passwordHash);
        if (!passwordOk) {
          // Atomically increment the failed-attempt counter. If we hit the
          // threshold, also stamp the lockout window in the same SQL.
          await db
            .update(operatorUsers)
            .set({
              failedLoginAttempts: sql`${operatorUsers.failedLoginAttempts} + 1`,
              failedLoginLockedUntil: sql`
                CASE
                  WHEN ${operatorUsers.failedLoginAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS}
                  THEN NOW() + INTERVAL '${sql.raw(String(LOCKOUT_MS))} milliseconds'
                  ELSE ${operatorUsers.failedLoginLockedUntil}
                END
              `,
            })
            .where(eq(operatorUsers.id, user.id));
          // AUDIT: caller writes `operator.login.invalid` with reason='wrong_password'.
          throw new CredentialsAuthError(AUTH_ERRORS.INVALID);
        }

        // 4. 2FA branch (if enabled on the user)
        if (user.twoFactorEnabled) {
          if (totpCode) {
            // Decrypt the stored TOTP secret. If decryption itself fails
            // (corrupted blob, wrong MASTER_KEY) we treat as TOTP-not-set
            // so we don't leak the storage shape.
            if (!user.twoFactorSecret) {
              throw new CredentialsAuthError(AUTH_ERRORS.TWO_FACTOR_NOT_ENABLED);
            }
            let secretPlain: string;
            try {
              secretPlain = decrypt(user.twoFactorSecret);
            } catch {
              throw new CredentialsAuthError(AUTH_ERRORS.TWO_FACTOR_NOT_ENABLED);
            }
            if (!verifyTotpCode(secretPlain, totpCode)) {
              // Roll the failed-counter for 2FA failure too — same R12 brake.
              await db
                .update(operatorUsers)
                .set({
                  failedLoginAttempts: sql`${operatorUsers.failedLoginAttempts} + 1`,
                })
                .where(eq(operatorUsers.id, user.id));
              // AUDIT: caller writes `operator.login.invalid_totp`.
              throw new CredentialsAuthError(AUTH_ERRORS.INVALID_TOTP);
            }
          } else if (backupCode) {
            const result = await verifyAndConsumeBackupCode(
              backupCode,
              user.twoFactorBackupCodes,
            );
            if (!result.valid) {
              await db
                .update(operatorUsers)
                .set({
                  failedLoginAttempts: sql`${operatorUsers.failedLoginAttempts} + 1`,
                })
                .where(eq(operatorUsers.id, user.id));
              // AUDIT: caller writes `operator.login.invalid_backup_code`.
              throw new CredentialsAuthError(AUTH_ERRORS.INVALID_BACKUP);
            }
            // Consume the code: write the trimmed array back.
            await db
              .update(operatorUsers)
              .set({ twoFactorBackupCodes: result.remainingHashes })
              .where(eq(operatorUsers.id, user.id));
            // AUDIT: caller writes `operator.login.backup_code_used`
            // with metadata { remainingCount: result.remainingHashes.length }.
          } else {
            // Password OK but neither TOTP nor backup code supplied —
            // signal the UI to prompt for 2FA on the next form step.
            // AUDIT: caller writes `operator.login.needs_2fa`.
            throw new CredentialsAuthError(AUTH_ERRORS.NEEDS_2FA);
          }
        }

        // 5. Successful login — reset the brute-force counter and stamp
        //    `last_login_at` in a single update. `last_login_ip` is set by
        //    the route handler (it has the request headers).
        await db
          .update(operatorUsers)
          .set({
            failedLoginAttempts: 0,
            failedLoginLockedUntil: null,
            lastLoginAt: new Date(),
          })
          .where(eq(operatorUsers.id, user.id));

        // AUDIT: caller writes `operator.login.success`.
        return {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.fullName,
          role: user.role,
        };
      },
    }),
  ],

  callbacks: {
    /**
     * Called whenever a JWT is created (sign-in) or read (subsequent
     * requests). We mirror `role` and `username` from the user object
     * onto the token so the session callback can surface them.
     */
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.username = user.username;
      }
      return token;
    },

    /**
     * Called when the client requests session data. We copy the JWT
     * claims into `session.user` so route handlers can read them.
     */
    async session({ session, token }) {
      if (token.sub) {
        session.user.id = token.sub;
      }
      if (token.role) {
        session.user.role = token.role;
      }
      if (token.username) {
        session.user.username = token.username;
      }
      return session;
    },
  },
} satisfies Parameters<typeof NextAuth>[0];

/**
 * Auth.js v5 returns the `handlers`, `auth`, `signIn`, and `signOut`
 * exports from `NextAuth(config)`. The route handler at
 * `/api/internal/auth/[...nextauth]/route.ts` re-exports `handlers.GET` and
 * `handlers.POST`. Server components / route handlers consume `auth()`
 * directly to read the current session.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
