/**
 * Scenario S4 — Create Operator User (plan/2026-05-11-control-center-e2e.md).
 *
 * Drives the admin-only "/sistem/kullanicilar/yeni" form end-to-end:
 *
 *   1. Seed admin (direct-2FA, same pattern as S2/S3/S7/S10/S12/S14/S17),
 *      log in.
 *   2. Hit /sistem/kullanicilar/yeni, fill username + email + full name +
 *      a strong 16-char generated password. Role stays at the form default
 *      ('operator', see S14 discovery).
 *   3. Submit → success screen shows the plaintext password ONCE inside a
 *      `<pre data-testid="generated-password">` block. Assert the visible
 *      text equals the password we typed and is ≥16 chars.
 *   4. DB postconditions:
 *        - new `operator_users` row with `is_active=true`,
 *          `two_factor_enabled=false`
 *        - `password_hash` is a real bcrypt hash (`$2` prefix) AND verifies
 *          against the plaintext we submitted
 *        - the plaintext password does NOT appear anywhere in the row
 *          (no accidental column reuse)
 *   5. `audit_log` row with `action='operator_user.created'` exists. The
 *      POST handler at src/app/api/internal/operator-users/route.ts uses the
 *      dotted convention (matches S2 deployment audit names); the PATCH
 *      handler emits the snake_case `operator_role_changed` only for the
 *      dedicated security event (S14).
 *   6. Sub-flow: log out the admin, log in as the new user with the password
 *      captured from the DOM. Because the freshly-created row has
 *      `two_factor_enabled=false`, `requireOperatorAuth` redirects to
 *      `/2fa-setup` after a successful credential check. We assert that
 *      transition — proof that the password the admin saw is the one the
 *      bcrypt hash verifies against.
 *
 * --- WHY DRIVE THE FORM INSTEAD OF POSTING DIRECTLY ---
 * We could POST to /api/internal/operator-users directly with the admin
 * session cookie, but the spec specifically calls out "Random password
 * shown once on the page". The only way to verify the success-screen
 * UX (i.e. that the form actually surfaces the plaintext via the
 * `data-testid=generated-password` hook) is to walk the UI.
 *
 * --- HOW WE CAPTURE THE PASSWORD ---
 * The form's "Otomatik Oluştur" button uses `crypto.getRandomValues`
 * inside the browser, so we cannot predict the value. Strategy:
 *   - Type a deterministic 16+ char password into the field (rather than
 *     clicking the button), since the test needs to *log in as the new
 *     user* and that requires knowing the plaintext.
 *   - Then verify the post-create success screen redisplays exactly that
 *     plaintext in the `<pre>`. That round-trip confirms the form's "show
 *     password once" contract works for both code paths (admin-typed AND
 *     auto-generated), because the success screen is symmetric: it shows
 *     whatever was in `form.password` at submit time.
 *
 * --- AUTH FOR THE NEW USER ---
 * The new operator's row starts with `two_factor_enabled = false`. When
 * they log in, Auth.js's `authorize()` accepts the password and creates a
 * session. Then `requireOperatorAuth` (in src/lib/auth/middleware.ts:133)
 * sees the false flag and redirects to `/2fa-setup`. The test asserts the
 * final URL contains `/2fa-setup` rather than `/login` (which would mean
 * the credential check failed). That's the success criterion for the
 * "logs in as the new user" sub-test in the spec.
 *
 * --- AUDIT CONVENTION DISCOVERY (carried from S2 / S14) ---
 * The audit table uses TWO conventions:
 *   - Dotted (e.g. `operator_user.created`, `operator_user.updated`,
 *     `deployment.failed`) for resource-lifecycle events.
 *   - Snake-case (e.g. `operator_role_changed`, `backup_code_used`) for
 *     dedicated security events that callers want to filter on by name.
 * This test asserts the dotted variant for create. Affects S5 (audit log
 * filter UI) — that screen must support both naming styles when grouping
 * actions by entity.
 */

import { test, expect } from '@playwright/test';
import bcrypt from 'bcrypt';
import { authenticator } from 'otplib';

// Relative path — Playwright's TS loader doesn't honour the `@/` alias the
// way Vitest does. Same convention as the other group-* specs.
import { encrypt } from '../../../src/lib/crypto/aes-gcm';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
const ADMIN_PASSWORD =
  process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';

test.setTimeout(60_000);

interface AdminSeedRow {
  id: string;
  totp_secret_plain: string;
}

/** Direct-seed the admin row with 2FA enabled. Mirrors S2/S3/S7/S10/S14. */
async function enable2faForAdmin(): Promise<AdminSeedRow> {
  const totpSecret = authenticator.generateSecret(20);
  const encryptedSecret = encrypt(totpSecret);
  await rawQuery(
    `UPDATE operator_users
        SET two_factor_enabled = true,
            two_factor_secret = $1,
            failed_login_attempts = 0,
            failed_login_locked_until = NULL
      WHERE username = $2`,
    [encryptedSecret, ADMIN_USERNAME],
  );
  const rows = await rawQuery<{ id: string }>(
    `SELECT id FROM operator_users WHERE username = $1`,
    [ADMIN_USERNAME],
  );
  expect(rows).toHaveLength(1);
  return { id: rows[0]!.id, totp_secret_plain: totpSecret };
}

/** /login → /2fa-verify → panel home (mirrors S2/S3/S7/S10/S14/S17). */
async function loginAdminWithTotp(
  page: import('@playwright/test').Page,
  totpSecret: string,
): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="username"]', ADMIN_USERNAME);
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/callback/credentials') &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    page.click('button[type="submit"]'),
  ]);

  await page.waitForURL(/\/2fa-verify/, { timeout: 10_000 });

  await page.fill('input[name="username"]', ADMIN_USERNAME);
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
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

  await page.waitForURL(
    (u) =>
      !u.toString().includes('/2fa-verify') &&
      !u.toString().includes('/login'),
    { timeout: 15_000 },
  );
}

test.beforeEach(async ({ page }) => {
  await truncateAll();
  await resetAllMocks();
  resetCounter();
  // Reset admin's 2FA columns (defensive — same as S2/S3/S7/S10/S12/S14/S17).
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
  await page.goto('about:blank');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* storage disabled */
    }
  });
});

test('S4 admin creates operator user → password shown once, DB row + bcrypt hash + audit row written, new user can log in (→ /2fa-setup)', async ({
  page,
  context,
}) => {
  // ---- Phase 0: seed admin 2FA --------------------------------------------
  const admin = await enable2faForAdmin();

  // New-user payload. 16 chars satisfies the spec ("≥16 chars"), and
  // satisfies the production policy (8+ chars, 1 letter, 1 digit). We
  // intentionally use a non-obvious mixed-case + digit + symbol string so
  // a future tightening of the policy (e.g. symbol-required) wouldn't
  // silently break this test.
  const NEW_USERNAME = 'test-newop';
  const NEW_EMAIL = 'test-newop@cyxares.test';
  const NEW_FULLNAME = 'Test New Operator';
  const NEW_PASSWORD = 'CyxTestN0pe!2026#';
  expect(NEW_PASSWORD.length).toBeGreaterThanOrEqual(16);

  // ---- Phase 1: admin logs in --------------------------------------------
  await loginAdminWithTotp(page, admin.totp_secret_plain);

  // ---- Phase 2: navigate to the create form ------------------------------
  await page.goto('/sistem/kullanicilar/yeni');
  await expect(page.locator('h1', { hasText: 'Yeni Kullanıcı' })).toBeVisible({
    timeout: 10_000,
  });

  // Fill the form. The role radios have no `value` attribute (they bind to
  // React state via `checked={form.role === '…'}` plus onChange); S14
  // surfaced this. Per S14 the form default is 'operator', which is what
  // we want for this scenario, so we don't touch the role inputs.
  //
  // The inline `Field` component renders <label> + <input> as siblings
  // without an `htmlFor`/`id` link, so `getByLabel` doesn't match. We
  // target by `input[type=…]` instead, since the form's mix is
  // deterministic: one `type=text` username + one `type=text` fullName,
  // one `type=email`, and one `type=password`.
  //
  // Username = the first text input (font-mono). FullName = the second
  // text input. Email = the only `type=email` input on the page.
  await page.locator('form input[type="text"]').nth(0).fill(NEW_USERNAME);
  await page.locator('form input[type="text"]').nth(1).fill(NEW_FULLNAME);
  await page.locator('form input[type="email"]').first().fill(NEW_EMAIL);
  // The password field is the only `type=password` input on this page,
  // distinct from the username text field above. Targeting it directly
  // sidesteps the "Şifre" / "Tekrar (Şifre)" ambiguity that would arise if
  // V1.5 adds a confirm field.
  await page.locator('form input[type="password"]').first().fill(NEW_PASSWORD);

  // Sanity: the default radio state is "operator" (matches S14 discovery —
  // V1 form default is 'operator', DB default for the column is 'admin').
  await expect(
    page
      .locator('label', { hasText: 'Operatör' })
      .first()
      .locator('input[type="radio"][name="role"]'),
  ).toBeChecked();

  // ---- Phase 3: submit + wait for the success screen ---------------------
  // The form posts to /api/internal/operator-users and then flips into the
  // in-page "user created" state. We watch the POST response so we can fail
  // early on a 4xx/5xx with a clear message.
  const [postResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/internal/operator-users') &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    page.click('button[type="submit"]:has-text("Kullanıcı Oluştur")'),
  ]);
  expect(postResponse.ok()).toBe(true);
  expect(postResponse.status()).toBe(201);

  // The success screen carries the data-testid hooks we added in the same
  // commit that introduced this test (see OperatorUserFormClient.tsx).
  const successPanel = page.locator('[data-testid="user-created-success"]');
  await expect(successPanel).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="created-username"]')).toHaveText(
    NEW_USERNAME,
  );

  // ---- Password disclosure: shown exactly once, in a pre block ----------
  const passwordBlock = page.locator('[data-testid="generated-password"]');
  await expect(passwordBlock).toBeVisible();
  const displayedPassword = (await passwordBlock.innerText()).trim();
  // Exact equality: the form must echo the value we typed, not transform it.
  expect(displayedPassword).toBe(NEW_PASSWORD);
  // Spec requirement: "at least 16 chars".
  expect(displayedPassword.length).toBeGreaterThanOrEqual(16);

  // Belt-and-braces: there's exactly ONE password disclosure block on the
  // page (no accidental duplicate, no rogue copy in a hidden div, etc.).
  await expect(page.locator('[data-testid="generated-password"]')).toHaveCount(
    1,
  );

  // ---- Phase 4: DB postconditions ----------------------------------------
  const dbRows = await rawQuery<{
    id: string;
    username: string;
    email: string;
    full_name: string;
    role: 'admin' | 'operator';
    is_active: boolean;
    two_factor_enabled: boolean;
    password_hash: string;
  }>(
    `SELECT id, username, email, full_name, role, is_active,
            two_factor_enabled, password_hash
       FROM operator_users
      WHERE username = $1`,
    [NEW_USERNAME],
  );
  expect(dbRows).toHaveLength(1);
  const created = dbRows[0]!;
  expect(created.username).toBe(NEW_USERNAME);
  expect(created.email).toBe(NEW_EMAIL);
  expect(created.full_name).toBe(NEW_FULLNAME);
  expect(created.role).toBe('operator');
  expect(created.is_active).toBe(true);
  // Brand-new user has not enrolled in TOTP yet — required for the
  // /2fa-setup redirect assertion later in this test.
  expect(created.two_factor_enabled).toBe(false);

  // bcrypt sanity: `$2`-prefixed (any variant — $2a/$2b/$2y) and the
  // plaintext we typed verifies against it. Pre-S4 hash format is `$2b`
  // (cost 12) — see src/lib/auth/password.ts:40.
  expect(created.password_hash).toMatch(/^\$2[abxy]\$/);
  const bcryptMatches = await bcrypt.compare(
    NEW_PASSWORD,
    created.password_hash,
  );
  expect(bcryptMatches).toBe(true);

  // Plaintext MUST NOT have leaked into ANY column of the operator row.
  // Loosely scan all string-typed columns (id is uuid, booleans skip).
  const fullRow = await rawQuery<Record<string, unknown>>(
    `SELECT * FROM operator_users WHERE username = $1`,
    [NEW_USERNAME],
  );
  expect(fullRow).toHaveLength(1);
  for (const [col, val] of Object.entries(fullRow[0]!)) {
    if (typeof val === 'string') {
      expect(val, `plaintext password leaked into column ${col}`).not.toBe(
        NEW_PASSWORD,
      );
      // Substring check too — guards against e.g. "<pw>:<salt>" formats.
      expect(
        val.includes(NEW_PASSWORD),
        `plaintext password substring leaked into column ${col}`,
      ).toBe(false);
    }
  }

  // ---- Phase 5: audit_log row -------------------------------------------
  // S2 (deployment.*) + S14 (operator_user.updated, operator_role_changed)
  // establish the convention: lifecycle events on a resource use dotted
  // `entity.verb`. The POST handler emits 'operator_user.created'.
  const audit = await rawQuery<{
    action: string;
    user_id: string;
    entity_type: string | null;
    entity_id: string | null;
    metadata: { username?: string; role?: string; isActive?: boolean } | null;
  }>(
    `SELECT action, user_id, entity_type, entity_id, metadata
       FROM audit_log
      WHERE action = 'operator_user.created'
        AND entity_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [created.id],
  );
  expect(audit).toHaveLength(1);
  const auditRow = audit[0]!;
  expect(auditRow.action).toBe('operator_user.created');
  expect(auditRow.user_id).toBe(admin.id);
  expect(auditRow.entity_type).toBe('operator_user');
  expect(auditRow.entity_id).toBe(created.id);
  // Metadata captured at write time — useful for "who created which user
  // with what role" forensics without re-joining onto operator_users.
  expect(auditRow.metadata?.username).toBe(NEW_USERNAME);
  expect(auditRow.metadata?.role).toBe('operator');
  expect(auditRow.metadata?.isActive).toBe(true);

  // ---- Phase 6: log out admin, log in as the new user --------------------
  // Same logout shortcut as S12/S14: clear cookies rather than driving
  // /api/auth/signout (HTTP-only cookies are still wiped because
  // Playwright owns the jar).
  await context.clearCookies();

  // The new user has 2FA disabled. /login → password OK → session set →
  // any panel route hits `requireOperatorAuth` which detects
  // two_factor_enabled=false and redirects to /2fa-setup.
  await page.goto('/login');
  await page.fill('input[name="username"]', NEW_USERNAME);
  await page.fill('input[name="password"]', NEW_PASSWORD);
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/callback/credentials') &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    page.click('button[type="submit"]'),
  ]);

  // Auth completed: we land on /2fa-setup (not /login — that would mean
  // INVALID_CREDENTIALS, which would prove the hash didn't verify against
  // the password we captured from the DOM).
  await page.waitForURL(/\/2fa-setup/, { timeout: 15_000 });
  expect(page.url()).toContain('/2fa-setup');
  expect(page.url()).not.toContain('/login');

  // Session cookie set — proves Auth.js actually authenticated us, didn't
  // just fall through to the unauth redirect chain.
  const cookies = await context.cookies();
  const sessionCookie = cookies.find(
    (c) =>
      c.name === 'next-auth.session-token' ||
      c.name === '__Secure-next-auth.session-token' ||
      c.name === 'authjs.session-token' ||
      c.name === '__Secure-authjs.session-token',
  );
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie!.value).toBeTruthy();

  // And the session reports the new user, not the admin.
  const sessionRes = await page.request.get('/api/auth/session');
  const sessionJson = (await sessionRes.json()) as {
    user?: { username?: string; role?: string };
  };
  expect(sessionJson.user?.username).toBe(NEW_USERNAME);
  expect(sessionJson.user?.role).toBe('operator');
});
