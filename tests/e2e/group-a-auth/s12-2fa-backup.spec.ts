/**
 * Scenario S12 — 2FA Backup Code Consumption (plan/2026-05-11-control-center-e2e.md).
 *
 * Builds on the S1 enrolment flow (which writes 4 encrypted backup codes
 * onto the admin row) and the S6 CredentialsAuthError refactor (which
 * surfaces symbolic codes like `INVALID_BACKUP_CODE` to the page).
 *
 * Strategy: seed-direct rather than walk-the-setup-wizard.
 *
 *   Why: the production helper `generateBackupCodes()` returns BOTH the
 *   plaintext codes AND the encrypted-bcrypt hashes ready for column write.
 *   Calling it from the test gives us the exact codes the operator would
 *   have seen on the /2fa-setup screen — no need to intercept the
 *   verify-setup response (more E2E-purist but flakier — Playwright's
 *   `waitForResponse` races the form submit on slow boxes).
 *
 *   Plus an AES-GCM encrypted TOTP secret (we don't actually use TOTP in
 *   this scenario, but the row's `two_factor_enabled = true` + null
 *   `two_factor_secret` would crash `authorize()` if the user accidentally
 *   typed a TOTP code — populate it for realism).
 *
 * What the test asserts:
 *   1. Backup-code-typed login completes successfully (URL leaves
 *      /2fa-verify, session cookie is set).
 *   2. The consumed code is REMOVED from `two_factor_backup_codes`
 *      (array length 4 → 3, one-time-use property of R12-compliant
 *      backup codes).
 *   3. An audit_log row with `action='backup_code_used'` is written for
 *      the admin user (the inline write inside `authorize()` — see
 *      `src/lib/auth/operator.ts` after S12 fixed the "caller writes"
 *      comment to actually call recordAudit() at the consume site).
 *   4. Replaying the SAME code is rejected: the UI shows the
 *      INVALID_BACKUP_CODE Turkish banner and the URL stays on
 *      /2fa-verify. The remaining-3 array still has 3 codes (the
 *      already-consumed code can't be "consumed again").
 *
 * Why a separate test for the replay rather than chaining: keeping the
 * happy path and the replay rejection as two parallel cases lets each
 * fail independently and produces clearer Playwright reports. They share
 * the same beforeEach so each starts from a fresh 4-code seed.
 *
 * --- DB CHECK CONSTRAINT GOTCHA ---
 * The original `ck_operator_users_backup_codes_count` required
 * `array_length = 4` whenever 2FA was enabled. That made backup-code
 * consumption impossible — the UPDATE that trimmed the array tripped the
 * constraint and rolled the transaction back. Migration 0001
 * (`tearful_calypso`) loosens it to `<= 4` so codes can be consumed down
 * to zero. Without that change this whole test is impossible to pass.
 */

import { test, expect } from '@playwright/test';
import bcrypt from 'bcrypt';
import { authenticator } from 'otplib';

// Relative path (not the `@/` alias) because Playwright's TS loader
// doesn't honour the alias config in tsconfig.json the way Vitest does.
// All sibling E2E specs in this directory use the same convention.
import { encrypt } from '../../../src/lib/crypto/aes-gcm';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
const ADMIN_PASSWORD =
  process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';

/**
 * bcrypt cost MUST match `BCRYPT_COST` in `src/lib/auth/backup-codes.ts`.
 * If the production module raises this constant we'd start writing
 * higher-cost hashes here and the test would still pass, but the cost
 * would drift from prod — keep them in sync.
 */
const BCRYPT_COST = 8;

/**
 * Four hand-rolled plaintext backup codes in the `XXXX-NNNN` format that
 * `formatBackupCode` produces (4 letters from SAFE_ALPHA, dash, 4 digits
 * from SAFE_DIGIT — neither `I O 0 1` because they look like 1/0/I/O).
 *
 * We don't randomise these because:
 *   - The test runs in CI with a deterministic seed expected
 *   - On failure these literals show up in Playwright traces verbatim,
 *     making "wrong code typed" diagnosable at a glance
 *   - The real entropy comes from the bcrypt salt + AES-GCM IV which the
 *     test re-randomises every time via `bcrypt.hash` and `encrypt`
 */
const FIXED_BACKUP_CODES = ['ABCD-2345', 'EFGH-3456', 'JKMN-4567', 'PQRS-5678'];

interface AdminRow {
  id: string;
  two_factor_enabled: boolean;
  two_factor_secret: string | null;
  two_factor_backup_codes: string[];
}

/**
 * Run a full 2FA-enabled seed on the admin row:
 *   - bcrypt-hash + AES-encrypt each plaintext backup code
 *   - generate a fresh TOTP secret + encrypt it (we won't TOTP in this
 *     test but `authorize()` reads the column when twoFactorEnabled=true
 *     even on the backup-code branch — null-secret triggers
 *     TWO_FACTOR_NOT_ENABLED on a typo'd code)
 *   - flip twoFactorEnabled=true in a single UPDATE so the CHECK
 *     constraint sees a consistent state
 *
 * Returns the freshly-seeded admin row so the caller can grab the id for
 * post-condition audit-log queries.
 */
async function seedAdmin2faWithCodes(plaintextCodes: string[]): Promise<AdminRow> {
  // bcrypt-hash in parallel — same as production's generateBackupCodes()
  // does (Promise.all over the 4-code array).
  const hashes = await Promise.all(
    plaintextCodes.map((code) => bcrypt.hash(code, BCRYPT_COST)),
  );
  // Then AES-GCM each hash. Encrypt is synchronous in lib/crypto/aes-gcm.ts.
  const encryptedHashes = hashes.map((h) => encrypt(h));

  // A real RFC 6238 secret (32 Base32 chars from a 20-byte seed). We don't
  // use it but `authorize()` may still decrypt it on the TOTP branch.
  const totpSecret = authenticator.generateSecret(20);
  const encryptedSecret = encrypt(totpSecret);

  await rawQuery(
    `UPDATE operator_users
        SET two_factor_enabled = true,
            two_factor_secret = $1,
            two_factor_backup_codes = $2::text[],
            failed_login_attempts = 0,
            failed_login_locked_until = NULL
      WHERE username = $3`,
    [encryptedSecret, encryptedHashes, ADMIN_USERNAME],
  );

  const rows = await rawQuery<AdminRow>(
    `SELECT id, two_factor_enabled, two_factor_secret, two_factor_backup_codes
       FROM operator_users
      WHERE username = $1`,
    [ADMIN_USERNAME],
  );
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.two_factor_enabled).toBe(true);
  expect(row.two_factor_backup_codes).toHaveLength(4);
  return row;
}

/**
 * Step 1: from the login page, submit username + password. The credentials
 * provider's `authorize()` sees `twoFactorEnabled=true` + no TOTP/backup
 * code in the payload and throws NEEDS_TWO_FACTOR — /login redirects to
 * /2fa-verify with `?username=admin`.
 *
 * We wait on the next-auth callback POST so we know the form actually
 * ran (without waiting we could see /login briefly and then race the
 * router.push to /2fa-verify).
 */
async function passwordStepToVerifyPage(
  page: import('@playwright/test').Page,
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
  // /login.onSubmit pushes to /2fa-verify on NEEDS_TWO_FACTOR.
  await page.waitForURL(/\/2fa-verify/, { timeout: 10_000 });
}

/**
 * Step 2: on /2fa-verify, click "Yedek Kod Kullan" (the toggle inside the
 * form — not the submit button), then type a backup code into the `code`
 * input. We re-fill username + password because the verify page doesn't
 * preserve them across the navigation (security — passwords aren't
 * persisted client-side).
 *
 * `expectSuccess` short-circuits the assertion mode:
 *   - true  → wait for the URL to leave /2fa-verify (login completes)
 *   - false → wait for the form's role=alert banner to show
 *             (INVALID_BACKUP_CODE replay path)
 */
async function submitBackupCode(
  page: import('@playwright/test').Page,
  code: string,
  expectSuccess: boolean,
): Promise<void> {
  // The verify page is reached via NEEDS_TWO_FACTOR; the toggle button
  // labelled "Yedek Kod Kullan" flips the input mode.
  await page.click('button:has-text("Yedek Kod Kullan")');

  // Re-fill the form. The username comes from the query param so the
  // input is already populated, but re-typing is idempotent and the
  // password is always blank.
  await page.fill('input[name="username"]', ADMIN_USERNAME);
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await page.fill('input[name="code"]', code);

  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/callback/credentials') &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    page.click('button[type="submit"]'),
  ]);

  if (expectSuccess) {
    await page.waitForURL((u) => !u.toString().includes('/2fa-verify'), {
      timeout: 15_000,
    });
  } else {
    // Stay on /2fa-verify and surface the INVALID_BACKUP_CODE banner.
    expect(page.url()).toContain('/2fa-verify');
    const alert = page.locator('form [role="alert"]');
    await expect(alert).toBeVisible();
  }
}

test.beforeEach(async () => {
  await truncateAll();
  await resetAllMocks();
  resetCounter();
  // Baseline: clear ALL transient auth state. The 2FA columns then get
  // re-seeded inside each test via `seedAdmin2faWithCodes` with the
  // specific codes that test cares about.
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

test('admin logs in with a backup code → code is consumed (4 → 3) + audit_log row written', async ({
  page,
}) => {
  const seeded = await seedAdmin2faWithCodes(FIXED_BACKUP_CODES);

  // The code we'll spend. Anything in the 4-element list will do; we
  // pick the first one for predictability in failure reports.
  const codeToConsume = FIXED_BACKUP_CODES[0]!;

  // ---- Drive the UI: /login → /2fa-verify → backup-code submit ----
  await passwordStepToVerifyPage(page);
  await submitBackupCode(page, codeToConsume, /* expectSuccess */ true);

  // ---- Session cookie set (authentication actually completed) ----
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find(
    (c) =>
      c.name === 'next-auth.session-token' ||
      c.name === '__Secure-next-auth.session-token' ||
      c.name === 'authjs.session-token' ||
      c.name === '__Secure-authjs.session-token',
  );
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie!.value).toBeTruthy();

  // ---- DB: array length is now 3 (one code consumed atomically) ----
  const afterRows = await rawQuery<AdminRow>(
    `SELECT id, two_factor_enabled, two_factor_secret, two_factor_backup_codes
       FROM operator_users
      WHERE username = $1`,
    [ADMIN_USERNAME],
  );
  const after = afterRows[0]!;
  expect(after.two_factor_enabled).toBe(true);
  expect(after.two_factor_backup_codes).toHaveLength(3);

  // ---- DB: audit_log row written with the canonical action name ----
  // operator.ts writes this inline (the Auth.js v5 handler owns the
  // POST and can't be intercepted by an outer route handler). Action
  // string is the literal `'backup_code_used'` — matches the spec text.
  const audit = await rawQuery<{
    action: string;
    user_id: string;
    entity_type: string | null;
    entity_id: string | null;
    metadata: { username?: string; remainingCount?: number } | null;
  }>(
    `SELECT action, user_id, entity_type, entity_id, metadata
       FROM audit_log
      WHERE action = 'backup_code_used'
        AND user_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [seeded.id],
  );
  expect(audit).toHaveLength(1);
  expect(audit[0]!.action).toBe('backup_code_used');
  expect(audit[0]!.entity_type).toBe('operator_user');
  expect(audit[0]!.entity_id).toBe(seeded.id);
  // Metadata carries the remaining count so a forensics query can
  // identify the "all 4 burned" path without a join back.
  expect(audit[0]!.metadata?.remainingCount).toBe(3);
});

test('replay of an already-consumed backup code is rejected', async ({ page }) => {
  await seedAdmin2faWithCodes(FIXED_BACKUP_CODES);

  const codeToReuse = FIXED_BACKUP_CODES[1]!;

  // ---- First login: consume the code legitimately ----
  await passwordStepToVerifyPage(page);
  await submitBackupCode(page, codeToReuse, /* expectSuccess */ true);

  // Confirm consumption landed.
  const mid = (
    await rawQuery<AdminRow>(
      `SELECT id, two_factor_enabled, two_factor_secret, two_factor_backup_codes
         FROM operator_users
        WHERE username = $1`,
      [ADMIN_USERNAME],
    )
  )[0]!;
  expect(mid.two_factor_backup_codes).toHaveLength(3);

  // ---- Log out: clear the session cookie so we can re-enter the
  //      password step on a fresh browser context. We don't bother with
  //      a real /api/auth/signout call — clearing cookies is faster and
  //      what most server-driven E2E suites do for logout. ----
  await page.context().clearCookies();

  // ---- Second login attempt with the SAME code: must be rejected ----
  await passwordStepToVerifyPage(page);
  await submitBackupCode(page, codeToReuse, /* expectSuccess */ false);

  // ---- DB: count is still 3 (no further consumption) ----
  const afterReplay = (
    await rawQuery<AdminRow>(
      `SELECT id, two_factor_enabled, two_factor_secret, two_factor_backup_codes
         FROM operator_users
        WHERE username = $1`,
      [ADMIN_USERNAME],
    )
  )[0]!;
  expect(afterReplay.two_factor_backup_codes).toHaveLength(3);

  // ---- Banner text: must surface the INVALID_BACKUP_CODE-mapped string ----
  // ERROR_MESSAGES[INVALID_BACKUP_CODE] = 'Yedek kod hatalı veya kullanılmış.'
  // (see src/app/(auth)/2fa-verify/page.tsx).
  await expect(page.locator('form [role="alert"]')).toContainText(
    /Yedek kod hatalı|kullanılmış/i,
  );

  // ---- Still on /2fa-verify, no session cookie issued for the failed
  //      replay (operator.ts throws INVALID_BACKUP before the success
  //      branch where cookies would be set). ----
  expect(page.url()).toContain('/2fa-verify');
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find(
    (c) =>
      c.name === 'next-auth.session-token' ||
      c.name === '__Secure-next-auth.session-token' ||
      c.name === 'authjs.session-token' ||
      c.name === '__Secure-authjs.session-token',
  );
  expect(sessionCookie).toBeUndefined();
});
