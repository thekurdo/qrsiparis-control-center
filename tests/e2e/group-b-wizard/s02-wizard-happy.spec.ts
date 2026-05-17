/**
 * Scenario S2 — Wizard 7-step Happy Path
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * The largest scenario in the suite: drives the full /musteriler/yeni
 * wizard from Step 1 (restaurant identity) through Step 7 (review +
 * deploy), then waits for the 10-step BullMQ pipeline to finish
 * against WireMock-happy. Asserts every DB transition (tenant row
 * created, deployment row enqueued + run, tenant flipped to active,
 * audit rows emitted).
 *
 * --- WHY 2FA IS DIRECT-SEEDED ---
 * The auth fixture walks through the /2fa-setup wizard on every test
 * — costs ~5s per run. This scenario already takes 30-60s for the
 * pipeline, so we shave time off the front by direct-seeding the
 * admin's 2FA columns and using a custom login helper (mirrors S12
 * and S14 patterns).
 *
 * --- PIPELINE EXPECTATIONS ---
 * The BullMQ deployment worker MUST be running for this test. Steps
 * 03/06/07 hit WireMock at COOLIFY_API_URL (default localhost:58080);
 * steps 04/05/08/09 are still stubs (Phase H7+ implements real SSH);
 * step 10 (POST_DEPLOY) marks tenant active + container_status='running'
 * + emits a `deploy.success` audit row.
 *
 * --- TIMEOUT BUDGET ---
 * Per playwright.config.ts the suite default is 60s; we bump to 120s
 * here because the 10-step pipeline + UI nav + 2 SSE-related polls
 * comfortably exceeds the default on slower boxes. Most CI runs finish
 * in 30-40s.
 */

import { test, expect } from '@playwright/test';
import { authenticator } from 'otplib';

// Relative path (not the `@/` alias) — Playwright's TS loader doesn't
// honour the tsconfig path mapping. Same convention as S12/S14.
import { encrypt } from '../../../src/lib/crypto/aes-gcm';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';
import { createServer } from '../fixtures/server.fixture';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
const ADMIN_PASSWORD =
  process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';

test.setTimeout(120_000);

interface SeedRow {
  id: string;
  username: string;
  totp_secret_plain: string;
}

/**
 * Direct-seed the admin row with 2FA enabled. Re-uses the production
 * AES-GCM helper so the encrypted blob is in the exact shape `authorize()`
 * expects when it later decrypts the secret for TOTP verify.
 *
 * Mirrors S14's helper — returns the plaintext TOTP secret so the test
 * can use `otplib` to generate a real 6-digit code on demand.
 */
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

/**
 * /login → /2fa-verify → submit TOTP → land on the panel home.
 *
 * Identical to S14's helper but inlined here so this spec doesn't
 * depend on cross-file plumbing in case S14 changes.
 */
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
    (u) => !u.toString().includes('/2fa-verify') && !u.toString().includes('/login'),
    { timeout: 15_000 },
  );
}

/**
 * Poll `deployments.status` until it reaches a terminal state or the
 * timeout expires. We pick `success` as the target because that's the
 * happy-path expectation; on `failed` we throw with the captured
 * error_code/error_message so test failures point straight at the
 * pipeline step that broke.
 */
async function waitForDeploymentSuccess(
  deploymentId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  let last: { status: string; error_code: string | null; error_message: string | null } | undefined;
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
    if (last.status === 'failed' || last.status === 'rolled_back' || last.status === 'cancelled') {
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

test.beforeEach(async () => {
  await truncateAll();
  await resetAllMocks();
  resetCounter();
  // Reset the seeded admin's 2FA state — we'll re-seed it inside the
  // test body. Same defensive pattern S12/S14 use so leaks between
  // future tests in this file can't sneak past.
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

test('admin walks 7-step wizard → tenant created → deploy pipeline succeeds → tenant active', async ({
  page,
}) => {
  // ---- Seed phase ----------------------------------------------------------
  const admin = await enable2faForAdmin();
  const server = await createServer();

  // ---- Phase 1: log in ----------------------------------------------------
  await loginWithTotp(page, admin.totp_secret_plain);

  // ---- Phase 2: navigate to the wizard ------------------------------------
  await page.goto('/musteriler/yeni');
  await expect(
    page.locator('h1', { hasText: 'Yeni Müşteri Onboarding' }),
  ).toBeVisible({ timeout: 10_000 });

  // ---- Step 1: Temel Bilgi ------------------------------------------------
  // The auto-slug fills shortCode from restaurantName; we override to a known
  // value so we can assert the DB row afterwards.
  const shortCode = 'lezzet-test';
  const domain = 'lezzet-test.test.local';

  await page.locator('label:has-text("Restoran Adı") + input').fill('Lezzet Test Restoran');
  // Re-fill shortCode AFTER restaurantName so the auto-slug overwrite (which
  // only fires if the field equals the previous auto-slug) doesn't clobber it.
  await page
    .locator('label:has-text("Kısa Kod") + input')
    .fill(shortCode);
  await page.locator('label:has-text("İletişim Adı") + input').fill('Ali Veli');
  await page.locator('label:has-text("Telefon") + input').fill('+905551234567');
  await page.locator('label:has-text("E-posta") + input').fill('test@lezzet.local');
  await page.locator('label:has-text("Şehir") + input').fill('İstanbul');
  // Address is multiline (<textarea>) — anchor the selector accordingly.
  await page.locator('label:has-text("Adres") + textarea').fill('Test Mahallesi No:1');

  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 2: Anlaşma/Sözleşme ------------------------------------------
  // baslangic is the default; we just submit. The tier picker is a fieldset
  // of <label><input type=radio> cards — the default-checked "baslangic" is
  // fine for the happy path. monthlyFeeKurus auto-fills to 80_000.
  // contractStartDate defaults to today.
  // durationMonths defaults to 12.
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 3: Domain ----------------------------------------------------
  await page.locator('#domain').fill(domain);
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 4: Template --------------------------------------------------
  // 'classic' is the default — submit through.
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 5: Modüller --------------------------------------------------
  // Defaults are fine — submit through.
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 6: Sunucu ----------------------------------------------------
  // The auto-selected "Önerilen" server is the one we pre-seeded (it's the
  // only active one). Just submit.
  // Belt-and-braces: pin the click to our server's id in case the auto-pick
  // race changes in future.
  await page.locator(`input[type="radio"][value="${server.id}"]`).check();
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 7: Review/Onay -----------------------------------------------
  // The deploy button is gated behind three required checklist items
  // (DNS/SSL/Container). Tick them, then fire.
  await page.click('label:has-text("DNS yapılandırıldı")');
  await page.click('label:has-text("SSL hazır")');
  await page.click('label:has-text("Container health check geçer")');

  // We wait on the POST /api/internal/deployments response to capture the
  // deploymentId for our poll. The tenants POST fires first; we look at the
  // deployments one because it's the trigger for the pipeline.
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

  // ---- Assert: navigated to the deployment detail page -------------------
  await page.waitForURL(
    new RegExp(`/deployments/${deploymentId}`),
    { timeout: 15_000 },
  );

  // ---- DB: tenants row inserted (status starts onboarding) ---------------
  // Right after the API call but before the worker drains, the tenant row
  // should be `onboarding` / `not_deployed`. The pipeline flips both fields
  // in step 10. We don't assert that intermediate state precisely (race —
  // the worker might've finished already on a fast box); we just verify the
  // row exists with the wizard-input values.
  const tenantRows = await rawQuery<{
    id: string;
    short_code: string;
    restaurant_name: string;
    domain: string;
    contact_phone: string;
    server_id_ref: string;
  }>(
    `SELECT id, short_code, restaurant_name, domain, contact_phone, server_id_ref
       FROM tenants
      WHERE id = $1`,
    [tenantId],
  );
  expect(tenantRows).toHaveLength(1);
  const tenantRow = tenantRows[0]!;
  expect(tenantRow.short_code).toBe(shortCode);
  expect(tenantRow.restaurant_name).toBe('Lezzet Test Restoran');
  expect(tenantRow.domain).toBe(domain);
  expect(tenantRow.contact_phone).toBe('+905551234567');
  expect(tenantRow.server_id_ref).toBe(server.id);

  // ---- DB: deployment row exists in some active state --------------------
  const deployRowsInitial = await rawQuery<{ status: string; tenant_id: string }>(
    `SELECT status, tenant_id FROM deployments WHERE id = $1`,
    [deploymentId],
  );
  expect(deployRowsInitial).toHaveLength(1);
  expect(deployRowsInitial[0]!.tenant_id).toBe(tenantId);
  // status here is one of: pending, in_progress, success — depending on
  // when the worker picks up the job relative to the API call.
  expect(['pending', 'in_progress', 'success']).toContain(
    deployRowsInitial[0]!.status,
  );

  // ---- Wait for the BullMQ worker to finish the pipeline -----------------
  await waitForDeploymentSuccess(deploymentId, 60_000);

  // ---- DB: tenant flipped to active by step10PostDeploy ------------------
  const tenantAfter = await rawQuery<{
    status: string;
    container_status: string;
    container_name: string | null;
  }>(
    `SELECT status, container_status, container_name
       FROM tenants
      WHERE id = $1`,
    [tenantId],
  );
  expect(tenantAfter).toHaveLength(1);
  const after = tenantAfter[0]!;
  expect(after.status).toBe('active');
  expect(after.container_status).toBe('running');
  // Step05/Step10 stamp this — value is `<shortCode>-app` from step05's
  // stub, or `rest-<shortCode>` if step03 was first to set it. Either way
  // it's non-null + non-empty.
  expect(after.container_name).toBeTruthy();

  // ---- DB: audit_log rows for tenant.created + deploy.success ------------
  const auditRows = await rawQuery<{ action: string; entity_id: string | null }>(
    `SELECT action, entity_id
       FROM audit_log
      WHERE (action = 'tenant.created' AND entity_id = $1)
         OR (action = 'deploy.success' AND entity_id = $2)
         OR (action = 'deployment.triggered' AND entity_id = $2)
      ORDER BY created_at ASC`,
    [tenantId, deploymentId],
  );
  // At minimum we expect one tenant.created row + one deployment.triggered
  // row + one deploy.success row. tenant.created is double-written (in-tx
  // + recordAudit) so we might see 4 total — assert ">= 3" rather than "= 3".
  expect(auditRows.length).toBeGreaterThanOrEqual(3);
  const actions = auditRows.map((r) => r.action);
  expect(actions).toContain('tenant.created');
  expect(actions).toContain('deployment.triggered');
  expect(actions).toContain('deploy.success');

  // ---- UI: /musteriler/<id> renders the tenant detail --------------------
  await page.goto(`/musteriler/${tenantId}`);
  // The page renders a tabbed detail view with the restaurant name in the
  // page title region. We pin to the restaurant name as the most
  // distinctive on-page assertion.
  await expect(page.locator('body')).toContainText('Lezzet Test Restoran', {
    timeout: 10_000,
  });
});
