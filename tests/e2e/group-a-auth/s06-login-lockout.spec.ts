/**
 * Scenario S6 — Login Lockout After 5 Failed Attempts (plan/2026-05-11-control-center-e2e.md).
 *
 * Exercises the R12 brute-force protection wired into the Credentials
 * provider in `src/lib/auth/operator.ts`:
 *
 *   1. Counter increments: 5 wrong-password submissions push
 *      `failed_login_attempts` from 0 → 5.
 *   2. After the 5th attempt, `failed_login_locked_until` is stamped to
 *      `NOW() + 15 minutes` (a future timestamp).
 *   3. A 6th attempt with the CORRECT password is still rejected while
 *      the lockout window is open — the UI surfaces the Turkish
 *      "kilitlendi" banner and no session cookie is set.
 *   4. Simulating clock-passage by manually rewinding
 *      `failed_login_locked_until` to the past lets a correct-password
 *      submission succeed; both the counter and the lock are cleared,
 *      and the user leaves /login (admin still has 2FA disabled so the
 *      middleware then bounces them to /2fa-setup — which is fine,
 *      we only assert "left /login").
 *
 * Why we drive this through the browser instead of calling `authorize()`
 * directly: we want to confirm the UI shows the lockout banner, that
 * the LOCKED_OUT symbolic error round-trips through next-auth, and that
 * no session cookie leaks on the locked-and-correct-password path.
 *
 * Why we keep 2FA disabled on the admin row for the whole test: every
 * failed attempt has to hit the password gate (step 3 of `authorize()`),
 * not the 2FA gate. If 2FA were enabled the counter would also tick on
 * missing/invalid TOTP, muddying what we're asserting about R12.
 */

import { test, expect } from '@playwright/test';
import { rawQuery, truncateAll } from '../fixtures/db';
import { resetAllMocks } from '../fixtures/mocks';
import { resetCounter } from '../fixtures/data';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
const ADMIN_PASSWORD =
  process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';
const WRONG_PASSWORD = 'definitely-not-the-admin-password';

interface AdminRow {
  failed_login_attempts: number;
  failed_login_locked_until: Date | null;
  two_factor_enabled: boolean;
}

async function readAdminRow(): Promise<AdminRow> {
  const rows = await rawQuery<AdminRow>(
    `SELECT failed_login_attempts, failed_login_locked_until, two_factor_enabled
       FROM operator_users
      WHERE username = $1`,
    [ADMIN_USERNAME],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/**
 * Submit the /login form with the supplied credentials and wait for the
 * page to settle (either the error banner appears or we navigate away).
 *
 * We intentionally don't assert any URL/text here — the test bodies
 * verify what they care about after this returns.
 */
async function attemptLogin(
  page: import('@playwright/test').Page,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="username"]', ADMIN_USERNAME);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    // Wait for the next-auth callback POST to come back. The login page
    // uses `redirect: false` so we stay on /login regardless of result;
    // listening on the request finishing is the most reliable signal
    // for "the form was processed".
    page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/callback/credentials') &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    page.click('button[type="submit"]'),
  ]);
}

test.beforeEach(async () => {
  await truncateAll();
  await resetAllMocks();
  resetCounter();

  // Reset the seeded admin row to a known-clean state for THIS scenario:
  //   - 2FA disabled so failed attempts hit the password gate only
  //   - counter at 0, lock cleared
  //
  // We do NOT reset the password hash — `truncateAll` preserves the seed
  // admin and the password is whatever `DEFAULT_OPERATOR_PASSWORD` was at
  // seed-time (= 'AdminTest123!' per .env).
  await rawQuery(
    `UPDATE operator_users
        SET two_factor_enabled = false,
            two_factor_secret = NULL,
            two_factor_backup_codes = '{}'::text[],
            failed_login_attempts = 0,
            failed_login_locked_until = NULL
      WHERE username = $1`,
    [ADMIN_USERNAME],
  );
});

test('5 failed logins lock the admin for 15min; correct password rejected during the window; lock clears on next successful login', async ({
  page,
}) => {
  // Sanity: starting state is what we set in beforeEach.
  const before = await readAdminRow();
  expect(before.failed_login_attempts).toBe(0);
  expect(before.failed_login_locked_until).toBeNull();
  expect(before.two_factor_enabled).toBe(false);

  // ---------------------------------------------------------------------
  // Phase 1 — 5 wrong-password submissions, counter ticks 1..5.
  // ---------------------------------------------------------------------
  // The login form's error banner is the only [role="alert"] inside the
  // <form>. Next.js itself injects an empty `#__next-route-announcer__`
  // [role="alert"] at the document root for route changes — we scope to
  // `form [role="alert"]` to skip it.
  const formAlert = page.locator('form [role="alert"]');

  for (let i = 1; i <= 5; i++) {
    await attemptLogin(page, WRONG_PASSWORD);

    // Stay on /login (redirect: false keeps us here).
    expect(page.url()).toContain('/login');

    // Error banner is rendered.
    await expect(formAlert).toBeVisible();

    const row = await readAdminRow();
    expect(row.failed_login_attempts).toBe(i);

    if (i < 5) {
      // Pre-threshold: lock NOT yet set.
      expect(row.failed_login_locked_until).toBeNull();
    } else {
      // 5th failure: lock should be stamped to roughly now + 15min.
      expect(row.failed_login_locked_until).not.toBeNull();
      const lockedUntilMs = new Date(row.failed_login_locked_until!).getTime();
      const nowMs = Date.now();
      // Future, by at least 14 minutes and at most 16 minutes.
      const minDelta = 14 * 60 * 1000;
      const maxDelta = 16 * 60 * 1000;
      expect(lockedUntilMs - nowMs).toBeGreaterThanOrEqual(minDelta);
      expect(lockedUntilMs - nowMs).toBeLessThanOrEqual(maxDelta);
    }
  }

  // ---------------------------------------------------------------------
  // Phase 2 — 6th attempt with the CORRECT password while still locked.
  //   Must be rejected. The LOCKED_OUT symbolic error from authorize()
  //   maps to the Turkish "geçici olarak kilitlendi" banner in
  //   `src/app/(auth)/login/page.tsx`.
  // ---------------------------------------------------------------------
  await attemptLogin(page, ADMIN_PASSWORD);

  expect(page.url()).toContain('/login');

  await expect(formAlert).toBeVisible();
  await expect(formAlert).toHaveText(/kilitlendi|locked/i);

  // No session cookie set during the locked window.
  const cookies = await page.context().cookies();
  const sessionCookies = cookies.filter(
    (c) =>
      c.name === 'next-auth.session-token' ||
      c.name === '__Secure-next-auth.session-token' ||
      c.name === 'authjs.session-token' ||
      c.name === '__Secure-authjs.session-token',
  );
  expect(sessionCookies).toHaveLength(0);

  // DB state unchanged by the locked-and-correct attempt — the lock
  // window short-circuits BEFORE the password compare runs, so the
  // counter must still be exactly 5 (not 6) and the lock still in the
  // future.
  const locked = await readAdminRow();
  expect(locked.failed_login_attempts).toBe(5);
  expect(locked.failed_login_locked_until).not.toBeNull();
  expect(new Date(locked.failed_login_locked_until!).getTime()).toBeGreaterThan(
    Date.now(),
  );

  // ---------------------------------------------------------------------
  // Phase 3 — simulate lockout expiry by rewinding the timestamp into
  //   the past, then submit the correct password. authorize() will let
  //   the password compare proceed, succeed, and the post-success branch
  //   clears `failed_login_attempts` + `failed_login_locked_until` in
  //   one update.
  // ---------------------------------------------------------------------
  await rawQuery(
    `UPDATE operator_users
        SET failed_login_locked_until = NOW() - INTERVAL '1 minute'
      WHERE username = $1`,
    [ADMIN_USERNAME],
  );

  await attemptLogin(page, ADMIN_PASSWORD);

  // After a successful auth the next-auth callback returns a redirect
  // URL the client navigates to. Admin still has 2FA disabled here, so
  // the middleware will send us to /2fa-setup. That's fine — we only
  // require that we LEFT /login.
  await page.waitForURL((u) => !u.toString().includes('/login'), {
    timeout: 15_000,
  });
  expect(page.url()).not.toContain('/login');

  // DB end-state: counter zeroed, lock cleared.
  const after = await readAdminRow();
  expect(after.failed_login_attempts).toBe(0);
  expect(after.failed_login_locked_until).toBeNull();
});
