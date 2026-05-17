/**
 * Scenario S10 — Server Capacity Exhausted
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * Wizard Step 6 (the server picker) MUST refuse to let an operator assign
 * a new tenant to a server whose live tenant count has hit
 * `maxTenantsTheoretical`. The page's loader (src/app/(panel)/musteriler/yeni/
 * page.tsx) already computes the per-server count and excludes `cancelled`
 * tenants (so freed slots free up capacity); this test pins that the UI
 * surfaces that data correctly:
 *
 *   1. The full server's <input type="radio"> is rendered with `disabled`
 *      so it can't be selected by keyboard or click.
 *   2. A visible "DOLU" badge appears next to the full server's name.
 *   3. The empty server (also capacity-20, 0 tenants) is selectable and
 *      shows `0/20` in the capacity meter.
 *   4. Selecting the empty server lets the wizard complete normally and
 *      the resulting tenants row has `server_id_ref = <empty server id>`.
 *
 * --- WHY WE SEED 20 ACTIVE TENANTS ---
 * The capacity check at src/app/(panel)/musteriler/yeni/page.tsx:38-39
 * excludes only `cancelled` rows. So any non-cancelled status counts
 * (onboarding, active, paused). We use `active` because it's the most
 * realistic "full server" state — onboarding tenants would suggest a
 * stuck deploy and paused tenants are usually transient.
 *
 * --- WHY localStorage IS CLEARED IN BEFOREEACH ---
 * TenantWizardClient mirrors its state to localStorage under
 * `wizard-new-tenant` (7-day TTL). truncateAll() only resets DB tables;
 * a previous run's partially-filled draft can leak into the next test
 * and pre-select the wrong server. Same defensive pattern as S7.
 *
 * --- AUTH PATTERN ---
 * Direct-seeds the admin's 2FA secret (mirrors S2 / S7 / S12 / S14) so
 * the test doesn't pay the ~5s /2fa-setup wizard cost on every run.
 *
 * --- TIMEOUT BUDGET ---
 * Bumped to 120s like S2 because this scenario also drives the full
 * 7-step wizard end-to-end + waits for the BullMQ pipeline on the
 * happy-path leg.
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

test.setTimeout(120_000);

interface SeedRow {
  id: string;
  username: string;
  totp_secret_plain: string;
}

/** Direct-seed the admin row with 2FA enabled (mirrors S2/S7/S14). */
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

/** /login → /2fa-verify → panel home (mirrors S2/S7/S14). */
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
 * Poll `deployments.status` until it reaches a terminal state. Lifted
 * verbatim from S2 — kept inline so this spec doesn't depend on
 * cross-file plumbing if S2 ever evolves.
 */
async function waitForDeploymentSuccess(
  deploymentId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  let last:
    | { status: string; error_code: string | null; error_message: string | null }
    | undefined;
  while (Date.now() - start < timeoutMs) {
    const rows = await rawQuery<{
      status: string;
      error_code: string | null;
      error_message: string | null;
    }>(
      `SELECT status, error_code, error_message
         FROM deployments
        WHERE id = $1`,
      [deploymentId],
    );
    if (rows.length === 0) {
      throw new Error(`deployment ${deploymentId} disappeared`);
    }
    last = rows[0]!;
    if (last.status === 'success') return;
    if (
      last.status === 'failed' ||
      last.status === 'rolled_back' ||
      last.status === 'cancelled'
    ) {
      throw new Error(
        `deployment ${deploymentId} ended with status=${last.status} code=${last.error_code} message=${last.error_message}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `deployment ${deploymentId} did not reach success in ${timeoutMs}ms (last status=${last?.status})`,
  );
}

test.beforeEach(async ({ page }) => {
  await truncateAll();
  await resetAllMocks();
  resetCounter();
  // Reset admin's 2FA columns (defensive — same as S2/S7/S12/S14).
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
  // Wipe wizard draft from previous runs (see file header).
  await page.goto('about:blank');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* storage disabled */
    }
  });
});

test('S10 full server is unselectable in Step 6, empty server is selectable + wizard completes', async ({
  page,
}) => {
  // ---- Seed phase ----------------------------------------------------------
  const admin = await enable2faForAdmin();

  // Two capacity-20 servers — give them deterministic names so we can pin
  // selectors. The `name` is the visible label in Step 6.
  const fullServer = await createServer({
    name: 'vps-full-s10',
    publicIp: '10.10.0.1',
    publicHostname: 'vps-full-s10.test.local',
    maxTenantsTheoretical: 20,
  });
  const emptyServer = await createServer({
    name: 'vps-empty-s10',
    publicIp: '10.10.0.2',
    publicHostname: 'vps-empty-s10.test.local',
    maxTenantsTheoretical: 20,
  });

  // Fill `fullServer` to capacity. The fixture's data factory increments
  // an internal counter so each call yields unique shortCode + domain
  // (`test-tenant-N.test.local`). Status `active` so the count query
  // (which excludes only `cancelled`) sees all 20.
  for (let i = 0; i < 20; i++) {
    await createTenant(fullServer.id, { status: 'active' });
  }

  // Sanity-check the seed before we drive the UI. The page loader runs
  // the same COUNT(*) we expect; if this fails the rest of the test is
  // worthless.
  const seedCheck = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM tenants
      WHERE server_id_ref = $1
        AND status <> 'cancelled'`,
    [fullServer.id],
  );
  expect(seedCheck[0]!.count).toBe('20');

  // ---- Phase 1: log in -----------------------------------------------------
  await loginWithTotp(page, admin.totp_secret_plain);

  // ---- Phase 2: navigate to the wizard ------------------------------------
  await page.goto('/musteriler/yeni');
  await expect(
    page.locator('h1', { hasText: 'Yeni Müşteri Onboarding' }),
  ).toBeVisible({ timeout: 10_000 });

  // ---- Step 1: Temel Bilgi ------------------------------------------------
  // Use distinct values so the resulting tenant row is identifiable.
  const shortCode = 'kapasite-s10';
  const domain = 'kapasite-s10.test.local';

  await page
    .locator('label:has-text("Restoran Adı") + input')
    .fill('Kapasite S10 Test Restoran');
  // Re-fill shortCode AFTER restaurantName so the auto-slug overwrite
  // (which only fires while the field still equals the previous auto-slug)
  // doesn't clobber it. Same trick as S2/S7.
  await page.locator('label:has-text("Kısa Kod") + input').fill(shortCode);
  await page.locator('label:has-text("İletişim Adı") + input').fill('Ali Veli');
  await page.locator('label:has-text("Telefon") + input').fill('+905551234567');
  await page
    .locator('label:has-text("E-posta") + input')
    .fill('test@kapasite.local');
  await page.locator('label:has-text("Şehir") + input').fill('İstanbul');
  await page
    .locator('label:has-text("Adres") + textarea')
    .fill('Test Mahallesi No:10');
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Steps 2-5 (defaults are fine) --------------------------------------
  // Step 2: Anlaşma — defaults submit through.
  await page.click('button[type="submit"]:has-text("İleri")');

  // Step 3: Domain.
  await expect(page.locator('h2', { hasText: 'Domain' })).toBeVisible({
    timeout: 5_000,
  });
  await page.locator('#domain').fill(domain);
  await page.click('button[type="submit"]:has-text("İleri")');

  // Step 4: Şablon — defaults.
  await expect(page.locator('h2', { hasText: 'Şablon' })).toBeVisible({
    timeout: 5_000,
  });
  await page.click('button[type="submit"]:has-text("İleri")');

  // Step 5: Modüller — defaults.
  await expect(page.locator('h2', { hasText: 'Modüller' })).toBeVisible({
    timeout: 5_000,
  });
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 6: Sunucu Ataması — the heart of S10. -------------------------
  await expect(page.locator('h2', { hasText: 'Sunucu Ataması' })).toBeVisible({
    timeout: 5_000,
  });

  // The full server's radio MUST be disabled.
  const fullRadio = page.locator(
    `input[type="radio"][value="${fullServer.id}"]`,
  );
  await expect(fullRadio).toBeVisible();
  await expect(fullRadio).toBeDisabled();

  // The empty server's radio MUST be enabled (and selectable).
  const emptyRadio = page.locator(
    `input[type="radio"][value="${emptyServer.id}"]`,
  );
  await expect(emptyRadio).toBeVisible();
  await expect(emptyRadio).toBeEnabled();

  // The full server's <label> must show the "DOLU" badge. Scoped to the
  // label containing the radio so we don't accidentally match a stray
  // span elsewhere on the page.
  const fullServerLabel = page.locator(
    `label:has(input[type="radio"][value="${fullServer.id}"])`,
  );
  await expect(fullServerLabel).toContainText('DOLU');
  await expect(fullServerLabel).toContainText('20/20');

  // The empty server's <label> must NOT show "DOLU" and should show "0/20".
  const emptyServerLabel = page.locator(
    `label:has(input[type="radio"][value="${emptyServer.id}"])`,
  );
  await expect(emptyServerLabel).not.toContainText('DOLU');
  await expect(emptyServerLabel).toContainText('0/20');
  // The empty server is the only available pick, so it earns "Önerilen".
  await expect(emptyServerLabel).toContainText('Önerilen');

  // Belt-and-braces: try to .check() the full server's radio. Playwright's
  // .check() with `force: true` would bypass the disabled state, so we
  // assert the disabled property survived an attempted click instead.
  // Click the LABEL (which is what the operator actually sees / clicks);
  // because the input has `disabled`, the click should be a noop for
  // selection purposes.
  await fullServerLabel.click({ force: true });
  // The radio must still be unchecked after the click attempt.
  await expect(fullRadio).not.toBeChecked();

  // Now select the empty server.
  await emptyRadio.check();
  await expect(emptyRadio).toBeChecked();
  await expect(fullRadio).not.toBeChecked();

  // Advance to Step 7.
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 7: Review/Onay ------------------------------------------------
  await expect(page.locator('h2', { hasText: 'Özet' })).toBeVisible({
    timeout: 5_000,
  });
  await page.click('label:has-text("DNS yapılandırıldı")');
  await page.click('label:has-text("SSL hazır")');
  await page.click('label:has-text("Container health check geçer")');

  const [tenantsRes, deploymentsRes] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes('/api/internal/tenants') &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    page.waitForResponse(
      (r) =>
        r.url().includes('/api/internal/deployments') &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    page.click('button:has-text("DEPLOY BAŞLAT")'),
  ]);

  expect(tenantsRes.status()).toBe(201);
  expect(deploymentsRes.status()).toBe(201);

  const tenantsJson = (await tenantsRes.json()) as {
    success: boolean;
    data: { tenantId: string };
  };
  const deploymentsJson = (await deploymentsRes.json()) as {
    success: boolean;
    data: { deploymentId: string };
  };
  const tenantId = tenantsJson.data.tenantId;
  const deploymentId = deploymentsJson.data.deploymentId;
  expect(tenantId).toBeTruthy();
  expect(deploymentId).toBeTruthy();

  // Navigated to deploy detail.
  await page.waitForURL(new RegExp(`/deployments/${deploymentId}`), {
    timeout: 15_000,
  });

  // ---- DB: new tenant landed on the EMPTY server, not the full one. ------
  const tenantRows = await rawQuery<{
    id: string;
    short_code: string;
    domain: string;
    server_id_ref: string;
  }>(
    `SELECT id, short_code, domain, server_id_ref FROM tenants WHERE id = $1`,
    [tenantId],
  );
  expect(tenantRows).toHaveLength(1);
  const tenantRow = tenantRows[0]!;
  expect(tenantRow.short_code).toBe(shortCode);
  expect(tenantRow.domain).toBe(domain);
  expect(tenantRow.server_id_ref).toBe(emptyServer.id);
  // The full server should still have its 20 seeded tenants — none of
  // them migrated to the empty server.
  expect(tenantRow.server_id_ref).not.toBe(fullServer.id);

  // ---- Wait for the pipeline to finish, then assert tenant flipped active. -
  await waitForDeploymentSuccess(deploymentId, 60_000);

  const tenantAfter = await rawQuery<{ status: string; server_id_ref: string }>(
    `SELECT status, server_id_ref FROM tenants WHERE id = $1`,
    [tenantId],
  );
  expect(tenantAfter[0]!.status).toBe('active');
  expect(tenantAfter[0]!.server_id_ref).toBe(emptyServer.id);

  // ---- DB: full server still has exactly 20 tenants. ----------------------
  // Sanity check: nothing about the wizard should've touched the full
  // server's roster.
  const fullCount = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM tenants WHERE server_id_ref = $1`,
    [fullServer.id],
  );
  expect(fullCount[0]!.count).toBe('20');
  // Empty server now has exactly 1 (the new tenant we just created).
  const emptyCount = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM tenants WHERE server_id_ref = $1`,
    [emptyServer.id],
  );
  expect(emptyCount[0]!.count).toBe('1');
});
