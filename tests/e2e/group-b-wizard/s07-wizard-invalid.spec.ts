/**
 * Scenario S7 — Invalid Domain Blocks Wizard
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * Two sub-tests on the /musteriler/yeni wizard's Step 3:
 *
 *   A) Invalid format — operator types a string that fails the hostname
 *      regex (Step3Domain's zod schema). Assertions:
 *        - The inline error <p data-error="domain-format"> renders with a
 *          message matching /geçersiz|invalid|format/i.
 *        - No POST hits /api/internal/tenants while the field is invalid.
 *        - Clicking "İleri" never advances past Step 3.
 *
 *   B) Duplicate domain — a tenant already exists with the chosen domain
 *      (seeded via createTenant). The wizard does NOT check uniqueness
 *      client-side; the regex passes and the form lets the operator march
 *      through all 7 steps. Server-side, the tenants insert hits the
 *      `uq_tenants_domain` unique constraint. Assertions:
 *        - POST /api/internal/tenants returns 409 (CONFLICT).
 *        - The wizard surfaces the error banner and stays on Step 7.
 *        - tenants table still contains only the seeded row (count = 1).
 *        - No `deployments` row was created (the second POST never fires
 *          because the chain bails on the tenants failure).
 *
 * --- WHY localStorage IS CLEARED IN BEFOREEACH ---
 * TenantWizardClient mirrors its state to localStorage under
 * `wizard-new-tenant` (7-day TTL). truncateAll() only resets DB tables —
 * a previous run's partially-filled draft can leak into the next test and
 * pre-populate Step 3 with the prior domain, masking the regression we
 * want to catch. page.evaluate(() => localStorage.clear()) wipes it.
 *
 * --- AUTH PATTERN ---
 * Direct-seeds the admin's 2FA secret (mirrors S2 / S12 / S14) so the
 * test doesn't pay the ~5s /2fa-setup wizard cost on every run.
 */

import { test, expect } from '@playwright/test';
import { authenticator } from 'otplib';

// Relative path — Playwright's TS loader doesn't honour the `@/` tsconfig
// path mapping. Same convention as the rest of the suite.
import { encrypt } from '../../../src/lib/crypto/aes-gcm';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';
import { createServer } from '../fixtures/server.fixture';
import { createTenant } from '../fixtures/tenant.fixture';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
const ADMIN_PASSWORD =
  process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';

test.setTimeout(60_000);

interface SeedRow {
  id: string;
  username: string;
  totp_secret_plain: string;
}

/** Direct-seed the admin row with 2FA enabled (mirrors S2/S14). */
async function enable2faForAdmin(): Promise<SeedRow> {
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

  const rows = await rawQuery<{ id: string; username: string }>(
    `SELECT id, username FROM operator_users WHERE username = $1`,
    [ADMIN_USERNAME],
  );
  expect(rows).toHaveLength(1);
  return { ...rows[0]!, totp_secret_plain: totpSecret };
}

/** /login → /2fa-verify → panel home (mirrors S2/S14). */
async function loginWithTotp(
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

/**
 * Drive the wizard through Steps 1 → 2 with a known set of inputs. Stops
 * after the "İleri" click that lands on Step 3 so the calling test can
 * exercise the domain field directly.
 *
 * shortCode/domain are passed in so each sub-test can use distinct values
 * (avoids collisions between sub-tests even though they share a beforeEach
 * truncate).
 */
async function fillSteps1to2(
  page: import('@playwright/test').Page,
  shortCode: string,
): Promise<void> {
  // --- Step 1 ---------------------------------------------------------------
  await page
    .locator('label:has-text("Restoran Adı") + input')
    .fill('Lezzet Test Restoran');
  await page.locator('label:has-text("Kısa Kod") + input').fill(shortCode);
  await page.locator('label:has-text("İletişim Adı") + input').fill('Ali Veli');
  await page.locator('label:has-text("Telefon") + input').fill('+905551234567');
  await page
    .locator('label:has-text("E-posta") + input')
    .fill('test@lezzet.local');
  await page.locator('label:has-text("Şehir") + input').fill('İstanbul');
  await page
    .locator('label:has-text("Adres") + textarea')
    .fill('Test Mahallesi No:1');
  await page.click('button[type="submit"]:has-text("İleri")');

  // --- Step 2 (defaults are fine) ------------------------------------------
  await page.click('button[type="submit"]:has-text("İleri")');
}

test.beforeEach(async ({ page }) => {
  await truncateAll();
  await resetAllMocks();
  resetCounter();
  // Reset admin's 2FA columns (defensive — same as S2/S12/S14).
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
  // Wipe wizard draft from previous runs. truncateAll() can't reach
  // browser localStorage, and a stale `wizard-new-tenant` envelope will
  // pre-fill Step 3 with an old domain and mask regressions in this spec.
  // Navigating to about:blank first means evaluate() runs on a real
  // execution context (avoids "Execution context destroyed" on cold pages).
  await page.goto('about:blank');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* storage disabled */
    }
  });
});

// ---------------------------------------------------------------------------
// Sub-test A — Invalid domain format blocks Step 3 advancement.
// ---------------------------------------------------------------------------

test('S7-A invalid domain format: inline error shown, no POST, wizard stays on Step 3', async ({
  page,
}) => {
  const admin = await enable2faForAdmin();
  await createServer();

  await loginWithTotp(page, admin.totp_secret_plain);

  // ---- Navigate to the wizard --------------------------------------------
  await page.goto('/musteriler/yeni');
  await expect(
    page.locator('h1', { hasText: 'Yeni Müşteri Onboarding' }),
  ).toBeVisible({ timeout: 10_000 });

  // ---- Drive through Steps 1 → 2 -----------------------------------------
  await fillSteps1to2(page, 'lezzet-invalid');

  // We should be on Step 3 now — the domain input is visible.
  await expect(page.locator('#domain')).toBeVisible({ timeout: 5_000 });

  // ---- Tripwire: any POST to /api/internal/tenants during this sub-test
  //      is a failure (regex validation should block submission). We
  //      install a request listener that pushes URLs into an array and
  //      assert on length === 0 at the end. ------------------------------
  const tenantPosts: string[] = [];
  page.on('request', (req) => {
    if (
      req.method() === 'POST' &&
      req.url().includes('/api/internal/tenants')
    ) {
      tenantPosts.push(req.url());
    }
  });

  // ---- Type an invalid domain --------------------------------------------
  // `--invalid--` fails the hostnameRegex (leading hyphen, no dot, single
  // label). Use type() rather than fill() so we exercise the same input
  // event the operator would trigger; the trim() in onChange means we
  // can't rely on accidental whitespace tricking the regex.
  await page.locator('#domain').fill('--invalid--');

  // Click "İleri" — the form is `noValidate`, so browser-native checks are
  // off. The zod schema in Step3Domain.handleSubmit() should setErrors()
  // and bail without calling onNext().
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Inline error visible with the expected message -------------------
  const inlineError = page.locator('p[data-error="domain-format"]');
  await expect(inlineError).toBeVisible({ timeout: 3_000 });
  await expect(inlineError).toHaveText(/geçersiz|invalid|format/i);

  // ---- Wizard stayed on Step 3 -------------------------------------------
  // The "Domain" header is unique to Step 3; if we'd advanced to Step 4
  // we'd see "Şablon" instead. Belt-and-braces check both.
  await expect(
    page.locator('h2', { hasText: 'Domain' }),
  ).toBeVisible();
  await expect(page.locator('#domain')).toBeVisible();
  // Step 4's heading must NOT be present.
  await expect(page.locator('h2', { hasText: 'Şablon' })).toHaveCount(0);

  // ---- No POST to /api/internal/tenants ----------------------------------
  // Give any in-flight network a brief moment to settle so this assertion
  // catches late-fired requests. 500ms is overkill (handleSubmit is
  // synchronous on the invalid path) but cheap.
  await page.waitForTimeout(500);
  expect(tenantPosts).toEqual([]);

  // ---- DB sanity: no tenants row was created -----------------------------
  const tenantCount = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM tenants`,
  );
  expect(tenantCount[0]!.count).toBe('0');
});

// ---------------------------------------------------------------------------
// Sub-test B — Duplicate domain caught server-side, wizard surfaces 409.
// ---------------------------------------------------------------------------

test('S7-B duplicate domain: server returns 409, wizard shows error, no new tenant or deployment', async ({
  page,
}) => {
  const admin = await enable2faForAdmin();
  const server = await createServer();

  // Pre-seed: a tenant with the domain we'll try to re-use in the wizard.
  // shortCode is left to the fixture so the only collision is on domain.
  const existing = await createTenant(server.id, {
    domain: 'lezzet-test.test.local',
  });
  expect(existing.id).toBeTruthy();

  await loginWithTotp(page, admin.totp_secret_plain);

  // ---- Navigate to wizard -------------------------------------------------
  await page.goto('/musteriler/yeni');
  await expect(
    page.locator('h1', { hasText: 'Yeni Müşteri Onboarding' }),
  ).toBeVisible({ timeout: 10_000 });

  // ---- Steps 1 → 2 — pick a NEW shortCode (only domain should collide). --
  await fillSteps1to2(page, 'lezzet-dup');

  // ---- Step 3 — type the duplicate domain. -------------------------------
  // Client-side this passes the regex (it IS a valid hostname). The
  // collision will only fire on the server-side unique-index check.
  await page.locator('#domain').fill('lezzet-test.test.local');
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 4 — Template (defaults). -------------------------------------
  await expect(page.locator('h2', { hasText: 'Şablon' })).toBeVisible({
    timeout: 5_000,
  });
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 5 — Modüller (defaults). -------------------------------------
  await expect(
    page.locator('h2', { hasText: 'Modüller' }),
  ).toBeVisible({ timeout: 5_000 });
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 6 — Sunucu (pin to our seeded server). -----------------------
  await page
    .locator(`input[type="radio"][value="${server.id}"]`)
    .check();
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 7 — Tick checklist + click DEPLOY BAŞLAT. --------------------
  await expect(page.locator('h2', { hasText: 'Özet' })).toBeVisible({
    timeout: 5_000,
  });
  await page.click('label:has-text("DNS yapılandırıldı")');
  await page.click('label:has-text("SSL hazır")');
  await page.click('label:has-text("Container health check geçer")');

  // ---- Tripwire: no /api/internal/deployments POST should fire (the
  //      chain bails after tenants POST returns 409). ---------------------
  const deploymentPosts: string[] = [];
  page.on('request', (req) => {
    if (
      req.method() === 'POST' &&
      req.url().includes('/api/internal/deployments')
    ) {
      deploymentPosts.push(req.url());
    }
  });

  // Click DEPLOY BAŞLAT and wait for the tenants POST to come back. We
  // assert 409 directly off the response.
  const [tenantsRes] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes('/api/internal/tenants') &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    page.click('button:has-text("DEPLOY BAŞLAT")'),
  ]);

  expect(tenantsRes.status()).toBe(409);
  const tenantsJson = (await tenantsRes.json()) as {
    success: false;
    error: { code: string; message: string };
  };
  expect(tenantsJson.success).toBe(false);
  expect(tenantsJson.error.code).toBe('CONFLICT');

  // ---- UI: error banner visible, still on Step 7. ------------------------
  // TenantWizardClient.deploy() sets submitError on throw; Step7Review
  // renders it inside a <div class="bg-red-900/40 text-red-300 ...">.
  // We match on the role/text instead of the class to keep the selector
  // resilient to styling tweaks.
  await expect(page.getByText(/zaten kayıtlı|domain/i).first()).toBeVisible({
    timeout: 5_000,
  });
  // Step 7's review header should still be visible (we didn't navigate
  // away to /deployments/...).
  await expect(page.locator('h2', { hasText: 'Özet' })).toBeVisible();
  expect(page.url()).toContain('/musteriler/yeni');

  // ---- DB: exactly one tenants row (the pre-seeded one). -----------------
  const tenantRows = await rawQuery<{ id: string; domain: string }>(
    `SELECT id, domain FROM tenants ORDER BY created_at ASC`,
  );
  expect(tenantRows).toHaveLength(1);
  expect(tenantRows[0]!.id).toBe(existing.id);
  expect(tenantRows[0]!.domain).toBe('lezzet-test.test.local');

  // ---- DB: no deployments row was created --------------------------------
  const deployRows = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM deployments`,
  );
  expect(deployRows[0]!.count).toBe('0');

  // ---- Network: no POST to /api/internal/deployments hit the wire --------
  // Give the chain a moment in case there's any straggler — there
  // shouldn't be, because deploy() throws after the tenants response and
  // returns from the try/catch without reaching the deployments fetch.
  await page.waitForTimeout(500);
  expect(deploymentPosts).toEqual([]);
});
