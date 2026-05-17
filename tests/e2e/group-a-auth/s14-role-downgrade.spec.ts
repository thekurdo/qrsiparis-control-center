/**
 * Scenario S14 — Operator Role Downgrade (plan/2026-05-11-control-center-e2e.md).
 *
 * Walks two distinct browser sessions against the same DB:
 *
 *   1. Admin session (seeded `admin`, password from DEFAULT_OPERATOR_PASSWORD)
 *      logs in, navigates to /sistem/kullanicilar/[id], and edits a freshly
 *      created test operator (started as `role=admin`) down to `role=operator`.
 *      The PATCH succeeds, the form redirects back to the list, and the DB
 *      row reflects the new role.
 *
 *   2. The same admin signs out; we re-enter the panel as the now-downgraded
 *      operator and try to hit /musteriler/yeni — which gates on
 *      `requireOperatorAuth(['admin'])` in
 *      `src/app/(panel)/musteriler/yeni/page.tsx`. The helper does NOT render
 *      a 403 page; it issues a server-side `redirect('/')`, so the browser
 *      lands on the dashboard. We assert that and confirm we never see the
 *      tenant wizard.
 *
 *   3. Audit-log row written: `operator_role_changed` with the admin as
 *      `user_id`, the downgraded operator as `entity_id`, and the
 *      old/new role pair in `metadata`. This is the dedicated security
 *      event we added in the same commit that introduced this test (the
 *      existing `operator_user.updated` row still gets written too — see
 *      the PATCH handler).
 *
 * --- 2FA STRATEGY ---
 * Both users (admin AND the fresh test operator) are direct-seeded with 2FA
 * enabled before the test drives the UI. This skips the /2fa-setup wizard
 * on first login (which would otherwise force us to walk through QR + 6-digit
 * verify + backup-code-confirm for EACH user). Tests are I/O bound on
 * Playwright steps; cutting two wizards saves ~10 seconds per run.
 *
 * The pattern mirrors S12's `seedAdmin2faWithCodes`: encrypt a real TOTP
 * secret with AES-GCM via the production crypto helper and write it into
 * the row, then flip `two_factor_enabled = true`. `requireOperatorAuth`
 * accepts that state and lets the user reach the panel after the
 * /2fa-verify step (where the fixture types a fresh `otplib`-generated code).
 *
 * --- WHY THE 403 IS A REDIRECT, NOT A 403 PAGE ---
 * See `src/lib/auth/middleware.ts` line ~137: a role mismatch calls
 * `redirect('/')`. There is no `/forbidden` route in V1. The assertion is
 * therefore "URL is the panel home, NOT /musteriler/yeni" — which proves
 * the operator was denied the admin-only surface. We also check that the
 * tenant-wizard's distinctive page content is NOT visible.
 */

import { test, expect } from '@playwright/test';
import { authenticator } from 'otplib';

// Relative path (not the `@/` alias) — Playwright's TS loader doesn't honour
// the tsconfig path mapping the way Vitest does. Same convention as S12.
import { encrypt } from '../../../src/lib/crypto/aes-gcm';

import { operatorData, resetCounter, TEST_PASSWORD, TEST_PASSWORD_HASH } from '../fixtures/data';
import { rawQuery, truncateAll } from '../fixtures/db';
import { resetAllMocks } from '../fixtures/mocks';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
const ADMIN_PASSWORD =
  process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';

interface SeedRow {
  id: string;
  username: string;
  role: 'admin' | 'operator';
  totp_secret_plain: string;
}

/**
 * Direct-seed an existing operator_users row with 2FA enabled. Re-uses the
 * production AES-GCM helper so the encrypted blob is in the exact shape
 * `authorize()` expects when it later decrypts the secret for TOTP verify.
 *
 * Returns the plaintext TOTP secret so the test can use `otplib` to generate
 * a real 6-digit code on demand.
 */
async function enable2faForUser(username: string): Promise<SeedRow> {
  const totpSecret = authenticator.generateSecret(20);
  const encryptedSecret = encrypt(totpSecret);

  await rawQuery(
    `UPDATE operator_users
        SET two_factor_enabled = true,
            two_factor_secret = $1,
            failed_login_attempts = 0,
            failed_login_locked_until = NULL
      WHERE username = $2`,
    [encryptedSecret, username],
  );

  const rows = await rawQuery<{
    id: string;
    username: string;
    role: 'admin' | 'operator';
  }>(
    `SELECT id, username, role
       FROM operator_users
      WHERE username = $1`,
    [username],
  );
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  return { ...row, totp_secret_plain: totpSecret };
}

/**
 * Create a fresh operator row with role='admin' and 2FA disabled. The
 * caller flips 2FA on via `enable2faForUser` once it has the username.
 *
 * We start the user as admin because the test's whole point is to verify
 * an admin-to-operator downgrade. The fixture-level operatorData() factory
 * defaults to role='operator', so we override that here.
 */
async function createFreshOperator(): Promise<{
  id: string;
  username: string;
}> {
  const op = operatorData({ role: 'admin' });
  await rawQuery(
    `INSERT INTO operator_users
       (username, email, full_name, password_hash, role, two_factor_enabled, is_active)
     VALUES ($1, $2, $3, $4, 'admin', false, true)`,
    [op.username, op.email, op.fullName, TEST_PASSWORD_HASH],
  );
  const [row] = await rawQuery<{ id: string; username: string }>(
    `SELECT id, username FROM operator_users WHERE username = $1`,
    [op.username],
  );
  expect(row).toBeDefined();
  return row!;
}

/**
 * /login → /2fa-verify → submit TOTP → land on the panel.
 *
 * Mirrors the auth fixture's login helper but routes through the TOTP
 * branch directly (we always have the plaintext secret at hand because
 * the test seeded it itself).
 */
async function loginWithTotp(
  page: import('@playwright/test').Page,
  username: string,
  password: string,
  totpSecret: string,
): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/callback/credentials') &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    page.click('button[type="submit"]'),
  ]);

  // Password gate clears, authorize() throws NEEDS_TWO_FACTOR → /2fa-verify.
  await page.waitForURL(/\/2fa-verify/, { timeout: 10_000 });

  // /2fa-verify re-prompts for username + password (security: no client-side
  // persistence). Re-type them, then submit the TOTP code.
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.fill('input[name="code"]', authenticator.generate(totpSecret));

  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/callback/credentials') &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    page.click('button[type="submit"]'),
  ]);

  // Wait until we leave the 2FA flow entirely.
  await page.waitForURL(
    (u) => !u.toString().includes('/2fa-verify') && !u.toString().includes('/login'),
    { timeout: 15_000 },
  );
}

test.beforeEach(async () => {
  await truncateAll();
  await resetAllMocks();
  resetCounter();
  // Reset the seeded admin row to a known baseline. enable2faForUser will
  // flip 2FA on in the test body — doing it here would leak between tests
  // if we ever add a second `test(...)` in this file.
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

test('admin downgrades operator role; downgraded user is denied /musteriler/yeni and audit row is written', async ({
  page,
  context,
}) => {
  // ---- Seed phase --------------------------------------------------------
  const adminRow = await enable2faForUser(ADMIN_USERNAME);
  const freshOp = await createFreshOperator();
  const opRow = await enable2faForUser(freshOp.username);

  // Sanity: starting role is admin.
  const beforeRoleRows = await rawQuery<{ role: 'admin' | 'operator' }>(
    `SELECT role FROM operator_users WHERE id = $1`,
    [opRow.id],
  );
  expect(beforeRoleRows[0]!.role).toBe('admin');

  // ---- Phase 1: admin logs in + edits the operator's role ---------------
  await loginWithTotp(page, ADMIN_USERNAME, ADMIN_PASSWORD, adminRow.totp_secret_plain);

  await page.goto(`/sistem/kullanicilar/${opRow.id}`);

  // The edit form mounts with the current values populated. We only need to
  // click the "Operatör" radio — everything else stays the same.
  //
  // The form's radio inputs do NOT have a `value="operator"` attribute (they
  // bind to React state via `checked={form.role === 'operator'}` + an
  // onChange handler — see OperatorUserFormClient.tsx). The discriminator is
  // the label text wrapping each radio. Click the LABEL — clicks bubble into
  // the contained <input type="radio"> and trigger the onChange.
  await page.locator('label', { hasText: 'Operatör' }).first().click();
  // Belt-and-braces: confirm the form now considers itself "operator" by
  // checking the radio's runtime `checked` state via the labelled-by row.
  await expect(
    page
      .locator('label', { hasText: 'Operatör' })
      .first()
      .locator('input[type="radio"][name="role"]'),
  ).toBeChecked();

  // The Kaydet button submits the PATCH. The component then router.push()'s
  // back to /sistem/kullanicilar — we wait on the URL transition.
  await Promise.all([
    page.waitForURL(/\/sistem\/kullanicilar(?:$|\?)/, { timeout: 15_000 }),
    page.click('button[type="submit"]:has-text("Kaydet")'),
  ]);

  // No error banner — if the PATCH had failed the form would have shown a
  // red [role="alert"] and stayed on the edit URL.
  expect(page.url()).toContain('/sistem/kullanicilar');
  expect(page.url()).not.toContain(`/sistem/kullanicilar/${opRow.id}`);

  // ---- DB: role persisted -----------------------------------------------
  const afterRoleRows = await rawQuery<{ role: 'admin' | 'operator' }>(
    `SELECT role FROM operator_users WHERE id = $1`,
    [opRow.id],
  );
  expect(afterRoleRows[0]!.role).toBe('operator');

  // ---- DB: audit_log carries the dedicated role-change event ------------
  // Snake-case convention matches S12's `backup_code_used`. Metadata holds
  // the old/new role pair so forensics queries don't need a JOIN-back.
  const audit = await rawQuery<{
    action: string;
    user_id: string;
    entity_type: string | null;
    entity_id: string | null;
    metadata: {
      username?: string;
      oldRole?: string;
      newRole?: string;
    } | null;
  }>(
    `SELECT action, user_id, entity_type, entity_id, metadata
       FROM audit_log
      WHERE action = 'operator_role_changed'
        AND entity_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [opRow.id],
  );
  expect(audit).toHaveLength(1);
  const row = audit[0]!;
  expect(row.action).toBe('operator_role_changed');
  expect(row.user_id).toBe(adminRow.id);
  expect(row.entity_type).toBe('operator_user');
  expect(row.entity_id).toBe(opRow.id);
  expect(row.metadata?.oldRole).toBe('admin');
  expect(row.metadata?.newRole).toBe('operator');

  // ---- Phase 2: log out the admin, log in as the downgraded operator ----
  // Clear cookies rather than driving /api/auth/signout — same shortcut S12
  // uses. Auth.js cookies are HTTP-only, but `context.clearCookies()` wipes
  // them all regardless of HttpOnly status because Playwright owns the jar.
  await context.clearCookies();

  await loginWithTotp(
    page,
    opRow.username,
    TEST_PASSWORD,
    opRow.totp_secret_plain,
  );

  // Sanity: session is for the right user with the new role.
  const sessionRes = await page.request.get('/api/auth/session');
  const sessionJson = (await sessionRes.json()) as {
    user?: { username?: string; role?: string };
  };
  expect(sessionJson.user?.username).toBe(opRow.username);
  expect(sessionJson.user?.role).toBe('operator');

  // ---- Phase 3: protected route should redirect away --------------------
  // `requireOperatorAuth(['admin'])` -> redirect('/'). Next.js streams the
  // redirect during the server render, so by the time the page resolves
  // we're already on '/'.
  await page.goto('/musteriler/yeni');

  // Final URL must NOT be /musteriler/yeni. Accept either the panel home
  // ('/') or any other place the middleware bounces to — what matters is
  // the operator did NOT reach the admin-only wizard.
  await expect.poll(() => new URL(page.url()).pathname, {
    timeout: 10_000,
  }).not.toBe('/musteriler/yeni');

  // Belt-and-braces: the wizard's distinctive H1 text should not be on
  // screen. The tenant wizard renders a multi-step form starting with the
  // restaurant-name field; the dashboard renders "Genel Durum".
  await expect(page.locator('h1', { hasText: 'Genel Durum' })).toBeVisible();
});
