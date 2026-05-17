/**
 * Scenario S1 — Login + 2FA Setup Happy Path (plan/2026-05-11-control-center-e2e.md).
 *
 * Walks the seeded admin through:
 *   1. POST /login with valid credentials → session cookie established
 *   2. requireOperatorAuth() bounces them to /2fa-setup (two_factor_enabled
 *      starts false after the per-test reset below)
 *   3. POST /api/internal/auth/2fa/init issues a fresh TOTP secret and the
 *      hidden data-totp-secret carrier exposes it to the fixture
 *   4. The fixture generates a real RFC 6238 code via `otplib` and POSTs
 *      it to /api/internal/auth/2fa/verify-setup
 *   5. The wizard shows the 4 plaintext backup codes; fixture clicks
 *      "Onayla ve Devam Et" to land on the panel home
 *
 * Then asserts the DB end-state:
 *   - operator_users.two_factor_enabled  = true
 *   - operator_users.two_factor_secret   IS NOT NULL (encrypted blob)
 *   - operator_users.two_factor_backup_codes  array length = 4
 *   - audit_log has at least one row with action='2fa_enabled' attributed
 *     to the admin
 */

import { test, expect } from '../fixtures/auth.fixture';
import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';

test.beforeEach(async () => {
  await truncateAll();
  await resetAllMocks();
  resetCounter();
  // `truncateAll()` preserves the seeded admin row (it only deletes
  // username LIKE 'test-%'). Reset that row's 2FA state so every run of
  // this test starts from the "first login" state.
  await rawQuery(
    `UPDATE operator_users
        SET two_factor_enabled = false,
            two_factor_secret = NULL,
            two_factor_backup_codes = '{}'::text[],
            failed_login_attempts = 0,
            failed_login_locked_until = NULL
      WHERE username = 'admin'`,
  );
});

test('admin first login walks through 2FA setup, becomes enabled, audit log written', async ({
  loggedInAdmin,
}) => {
  // The loggedInAdmin fixture has already:
  //   - submitted the /login form
  //   - been redirected to /2fa-setup
  //   - scanned the hidden data-totp-secret
  //   - submitted a real TOTP code
  //   - advanced past the backup-codes screen
  //
  // After all that, we should be on a non-/2fa-setup, non-/login URL.
  await expect(loggedInAdmin).toHaveURL(
    /\/$|\/dashboard|\/musteriler|\/sunucular/,
  );

  // ---- DB post-conditions ----
  const operator = await rawQuery<{
    id: string;
    two_factor_enabled: boolean;
    two_factor_secret: string | null;
    two_factor_backup_codes: string[];
  }>(
    `SELECT id, two_factor_enabled, two_factor_secret, two_factor_backup_codes
       FROM operator_users
      WHERE username = 'admin'`,
  );
  expect(operator).toHaveLength(1);
  const adminRow = operator[0]!;

  expect(adminRow.two_factor_enabled).toBe(true);
  expect(adminRow.two_factor_secret).not.toBeNull();
  expect(adminRow.two_factor_backup_codes).toHaveLength(4);

  // Each stored backup code must be the AES-GCM encrypted-blob shape
  // (iv-hex : tag-hex : ct-hex). A plaintext "ABCD-1234" leaking would
  // indicate the encryption wrapper was bypassed.
  for (const code of adminRow.two_factor_backup_codes) {
    expect(code).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  }

  // Same shape check for the TOTP secret — it must be encrypted, not
  // plaintext Base32.
  expect(adminRow.two_factor_secret).toMatch(
    /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/,
  );

  // ---- Audit log ----
  // The schema column is `user_id` (not `actor_user_id`) and the action
  // is the string literal `2fa_enabled` per the verify-setup route.
  const audit = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM audit_log
      WHERE action = '2fa_enabled'
        AND user_id = $1`,
    [adminRow.id],
  );
  expect(parseInt(audit[0]!.count, 10)).toBeGreaterThanOrEqual(1);
});
