/**
 * Scenario S8 — Pipeline Health-Check Fail → Rollback
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * Drives the same 7-step wizard happy path as S2, but installs a runtime
 * WireMock mapping that causes step07 (HEALTH_CHECK) to see Coolify
 * report `app.status='failed'`. The pipeline must:
 *
 *   1. Raise `HEALTH_CHECK_FAILED`.
 *   2. Run rollback in reverse for steps 06, 05, 04, 03 (the only steps
 *      whose forward() completed before the failure). Each emits
 *      `rollback.start <NAME>` + `rollback.done <NAME>` log lines.
 *   3. Stamp `deployments.status='failed'`, `error_code='HEALTH_CHECK_FAILED'`,
 *      and populate `error_message`.
 *   4. Revert `tenants.status` to `onboarding` (the schema enum does NOT
 *      include `deploy_failed`, so onboarding is the failure terminal
 *      state — see runner.ts:185 + Doc 17 §3.3) and flip
 *      `container_status='error'`.
 *   5. Write `deployment.failed` + `deployment.rollback_completed` audit
 *      rows (dotted naming convention per S2).
 *   6. The `/deployments/[id]` UI must show: red `Hata` status pill,
 *      the `HEALTH_CHECK_FAILED` error code + message, a `Yeniden Dene`
 *      retry button.
 *
 * --- WHY A RUNTIME WIREMOCK MAPPING INSTEAD OF COOLIFY_MOCK_MODE ---
 * The BullMQ worker is launched once at session start with the canonical
 * env (no `COOLIFY_MOCK_MODE`), and restarting it mid-suite means tearing
 * down a long-lived process, which on Windows is racey enough to make the
 * test brittle. Installing a runtime `GET /api/v1/applications/[^/]+`
 * mapping that returns `status='failed'` (without checking `X-Mock-Mode`,
 * so it triggers for the worker's default-mode requests too) is
 * deterministic and survives the test boundary cleanly via
 * `resetCoolifyMappings()` in `afterEach`.
 *
 * The env-var pattern wired into `src/lib/deploy/context.ts` is still
 * useful for future scenarios (S9 stuck / S18 SSE) that need mode
 * stability across a chain of deploys — this scenario just doesn't
 * need it.
 *
 * --- WHY THE ROLLBACK ORDER IS 06 → 05 → 04 → 03 (NOT 06 → 05 → ... → 02) ---
 * step02 (CONFIG_GENERATE) is stamped onto context as a side-effect of
 * step03 (`coolifyUuid` is set in step03's forward only). The forward
 * order is 01, 02, 03, 04, 05, 06, then 07 throws. `runPipeline` rolls
 * back the completed forward steps in reverse, i.e. 06, 05, 04, 03, 02,
 * 01. step01 / step02 rollbacks are noops but still execute. We assert
 * on the four steps that emit observable rollback log lines: 03 (delete
 * coolify app), 05 (would-rm config file), 06 (stop coolify app).
 *
 * --- TIMEOUT BUDGET ---
 * 120s like S2: pipeline up to step07 + rollback for 6 steps. Most CI
 * runs finish in 20-30s because the rollback path skips the slower
 * step04 STUB sleep on the failure leg.
 */

import { test, expect } from '@playwright/test';
import { authenticator } from 'otplib';

// Relative path — Playwright's TS loader doesn't honour the `@/` tsconfig
// path mapping. Same convention as S2/S7/S10/S12/S14.
import { encrypt } from '../../../src/lib/crypto/aes-gcm';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import {
  addCoolifyMapping,
  resetAllMocks,
  resetCoolifyMappings,
} from '../fixtures/mocks';
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

/** Direct-seed the admin row with 2FA enabled. Mirrors S2/S7/S10/S12/S14. */
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

/** /login → /2fa-verify → panel home. Mirrors S2/S7/S10/S12/S14. */
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
 * Poll `deployments.status` until it reaches a terminal state. Returns
 * the final row so the caller can assert on error_code / error_message.
 * Unlike S2's helper, S8 *expects* the failure path so we don't throw
 * on `failed` — we just return whatever the runner persisted.
 */
async function waitForDeploymentTerminal(
  deploymentId: string,
  timeoutMs = 60_000,
): Promise<{
  status: string;
  error_code: string | null;
  error_message: string | null;
  log: string | null;
}> {
  const start = Date.now();
  let last:
    | {
        status: string;
        error_code: string | null;
        error_message: string | null;
        log: string | null;
      }
    | undefined;
  while (Date.now() - start < timeoutMs) {
    const rows = await rawQuery<{
      status: string;
      error_code: string | null;
      error_message: string | null;
      log: string | null;
    }>(
      `SELECT status, error_code, error_message, log
         FROM deployments
        WHERE id = $1`,
      [deploymentId],
    );
    if (rows.length === 0) {
      throw new Error(`deployment ${deploymentId} disappeared`);
    }
    last = rows[0]!;
    if (
      last.status === 'success' ||
      last.status === 'failed' ||
      last.status === 'rolled_back' ||
      last.status === 'cancelled'
    ) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `deployment ${deploymentId} did not reach a terminal state in ${timeoutMs}ms (last status=${last?.status})`,
  );
}

test.beforeEach(async ({ page }) => {
  await truncateAll();
  await resetAllMocks();
  // Drop any runtime mappings left over from a previous test run — the
  // default `resetAllMocks()` only resets scenarios + request journal,
  // not the dynamic mapping list. Critical here because S8 relies on
  // installing a fresh override and we don't want an old one bleeding in.
  await resetCoolifyMappings();
  resetCounter();
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
  // Wizard draft from previous runs would pre-select a stale server,
  // mirroring S7/S10's defensive pattern.
  await page.goto('about:blank');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* storage disabled */
    }
  });
});

test.afterEach(async () => {
  // CRITICAL: drop the runtime mapping S8 installs so the *next* test
  // (S9 stuck-recovery, S17 concurrent-lock, S18 SSE, etc.) doesn't see
  // every getApp response come back as failed. Defensive even if the
  // test failed mid-way — afterEach runs unconditionally.
  await resetCoolifyMappings();
});

test('S8 health-check fails at step 7 → rollback runs in reverse → tenant reverted, audit + UI surface error', async ({
  page,
}) => {
  // ---- Seed phase ----------------------------------------------------------
  const admin = await enable2faForAdmin();
  const server = await createServer();

  // ---- Install the failure mapping ---------------------------------------
  // Priority 1 (higher than the on-disk `06-app-detail.json`'s default
  // priority 5) and no `X-Mock-Mode` constraint, so it intercepts every
  // `GET /api/v1/applications/{uuid}` regardless of whether the worker
  // sent a header. This deterministically drives step07 into the
  // HEALTH_CHECK_FAILED branch without requiring a worker restart.
  //
  // We deliberately scope the urlPathPattern to a single segment so we
  // don't accidentally intercept `/applications/{uuid}/deploy` (which is
  // POST and lives at step06; pattern wouldn't match anyway because of
  // the trailing segment, but explicit is better than implicit).
  const mappingId = await addCoolifyMapping({
    priority: 1,
    request: {
      method: 'GET',
      urlPathPattern: '/api/v1/applications/[^/]+',
    },
    response: {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      jsonBody: {
        uuid: '{{request.pathSegments.[3]}}',
        name: 'test-app',
        domain: 'test.local',
        status: 'failed',
      },
      transformers: ['response-template'],
    },
  });
  expect(mappingId).toBeTruthy();

  // ---- Phase 1: log in ----------------------------------------------------
  await loginWithTotp(page, admin.totp_secret_plain);

  // ---- Phase 2: navigate to the wizard ------------------------------------
  await page.goto('/musteriler/yeni');
  await expect(
    page.locator('h1', { hasText: 'Yeni Müşteri Onboarding' }),
  ).toBeVisible({ timeout: 10_000 });

  // ---- Step 1: Temel Bilgi -----------------------------------------------
  const shortCode = 'lezzet-s08';
  const domain = 'lezzet-s08.test.local';
  await page
    .locator('label:has-text("Restoran Adı") + input')
    .fill('Lezzet S08 Test Restoran');
  // Re-fill shortCode AFTER restaurantName so the auto-slug doesn't
  // overwrite it (same trick as S2/S7/S10).
  await page.locator('label:has-text("Kısa Kod") + input').fill(shortCode);
  await page
    .locator('label:has-text("İletişim Adı") + input')
    .fill('Ali Veli');
  await page.locator('label:has-text("Telefon") + input').fill('+905551234567');
  await page
    .locator('label:has-text("E-posta") + input')
    .fill('test@lezzet-s08.local');
  await page.locator('label:has-text("Şehir") + input').fill('İstanbul');
  await page
    .locator('label:has-text("Adres") + textarea')
    .fill('Test Mahallesi No:8');
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Steps 2-5 (defaults are fine) --------------------------------------
  await page.click('button[type="submit"]:has-text("İleri")');

  await expect(page.locator('h2', { hasText: 'Domain' })).toBeVisible({
    timeout: 5_000,
  });
  await page.locator('#domain').fill(domain);
  await page.click('button[type="submit"]:has-text("İleri")');

  await expect(page.locator('h2', { hasText: 'Şablon' })).toBeVisible({
    timeout: 5_000,
  });
  await page.click('button[type="submit"]:has-text("İleri")');

  await expect(page.locator('h2', { hasText: 'Modüller' })).toBeVisible({
    timeout: 5_000,
  });
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 6: Sunucu -----------------------------------------------------
  await expect(
    page.locator('h2', { hasText: 'Sunucu Ataması' }),
  ).toBeVisible({ timeout: 5_000 });
  await page
    .locator(`input[type="radio"][value="${server.id}"]`)
    .check();
  await page.click('button[type="submit"]:has-text("İleri")');

  // ---- Step 7: Review / Deploy --------------------------------------------
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

  // Navigated to the deploy detail page.
  await page.waitForURL(new RegExp(`/deployments/${deploymentId}`), {
    timeout: 15_000,
  });

  // ---- Wait for terminal state -------------------------------------------
  const terminal = await waitForDeploymentTerminal(deploymentId, 60_000);

  // ---- DB: deployment row stamped failed + correct error code/message ---
  expect(terminal.status).toBe('failed');
  expect(terminal.error_code).toBe('HEALTH_CHECK_FAILED');
  expect(terminal.error_message ?? '').toMatch(/health check|app\.status=failed/i);

  // ---- DB: rollback log lines present ------------------------------------
  // The pipeline runner emits these markers for every step whose forward
  // completed. step07 forward throws so completed[] is steps 01..06; the
  // reverse rollback walks 06 → 05 → 04 → 03 → 02 → 01.
  const log = terminal.log ?? '';
  expect(log).toContain('step.failed');
  expect(log).toContain('rollback.start CONTAINER_START');
  expect(log).toContain('rollback.done CONTAINER_START');
  expect(log).toContain('rollback.start CONFIG_INJECT');
  expect(log).toContain('rollback.start DOCKER_IMAGE_PULL');
  expect(log).toContain('rollback.start COOLIFY_APP_CREATE');
  expect(log).toContain('rollback.done COOLIFY_APP_CREATE');
  // The COOLIFY_APP_CREATE rollback issues `deleteApp(uuid)` against
  // Coolify; verify the log line confirming it ran.
  expect(log).toMatch(/coolify app deleted/i);
  expect(log).toMatch(/rollback\.complete steps=6/);

  // ---- DB: tenant reverted to onboarding + container_status=error -------
  // The schema enum lacks a `deploy_failed` value (see schema.ts:209).
  // The runner reverts to `onboarding` so the operator can drive the
  // wizard again, and flips containerStatus to `error` so the customer
  // detail card surfaces the broken state.
  const tenantAfter = await rawQuery<{
    status: string;
    container_status: string;
  }>(
    `SELECT status, container_status FROM tenants WHERE id = $1`,
    [tenantId],
  );
  expect(tenantAfter).toHaveLength(1);
  expect(tenantAfter[0]!.status).toBe('onboarding');
  expect(tenantAfter[0]!.container_status).toBe('error');

  // ---- DB: audit rows --------------------------------------------------
  // Two rows expected: deployment.failed (always) and
  // deployment.rollback_completed (only when at least one step's forward
  // completed — true here since step01..06 all ran). The tenant.created
  // + deployment.triggered rows from the wizard are also present; we
  // pin those too so a regression that drops them is caught here.
  const auditRows = await rawQuery<{
    action: string;
    entity_id: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT action, entity_id, metadata
       FROM audit_log
      WHERE entity_id IN ($1, $2)
      ORDER BY created_at ASC`,
    [tenantId, deploymentId],
  );
  const actions = auditRows.map((r) => r.action);
  expect(actions).toContain('tenant.created');
  expect(actions).toContain('deployment.triggered');
  expect(actions).toContain('deployment.failed');
  expect(actions).toContain('deployment.rollback_completed');
  // The failure-row metadata MUST carry the error code so ops dashboards
  // can group failures without re-reading the deployments table.
  const failedRow = auditRows.find((r) => r.action === 'deployment.failed');
  expect(failedRow).toBeTruthy();
  expect(failedRow?.metadata?.['errorCode']).toBe('HEALTH_CHECK_FAILED');
  expect(failedRow?.metadata?.['failedStep']).toBe('HEALTH_CHECK');
  // The rollback-completed metadata must list the steps that ran in
  // reverse order (06 → 05 → 04 → 03 → 02 → 01).
  const rbRow = auditRows.find(
    (r) => r.action === 'deployment.rollback_completed',
  );
  expect(rbRow).toBeTruthy();
  const rbSteps = rbRow?.metadata?.['rolledBackSteps'] as
    | string[]
    | undefined;
  expect(rbSteps).toBeDefined();
  expect(rbSteps?.[0]).toBe('CONTAINER_START');
  expect(rbSteps?.length).toBe(6);

  // ---- UI: /deployments/[id] surfaces the failure ------------------------
  // The page might've been rendered before the runner finished stamping
  // the row. Refresh so the server component re-fetches the terminal
  // state, then assert.
  await page.goto(`/deployments/${deploymentId}`);

  // The DeployStatusPill renders the Turkish label `Hata` (failed).
  // It's a <span> with text-red-* styling — pin to the text instead of
  // the class so CSS refactors don't break the test.
  await expect(
    page.locator('span', { hasText: /^Hata$/ }).first(),
  ).toBeVisible({ timeout: 5_000 });
  // The error code panel is a `font-mono uppercase` block rendered when
  // `errorCode` is set (DeploymentDetailClient.tsx:351-358).
  await expect(page.locator('body')).toContainText('HEALTH_CHECK_FAILED');
  // And the error message is rendered alongside it.
  await expect(page.locator('body')).toContainText(/health check|app\.status=failed/i);
  // Retry button MUST be visible (the failed branch renders
  // `Yeniden Dene` per DeploymentDetailClient.tsx:402-408).
  await expect(
    page.locator('button', { hasText: 'Yeniden Dene' }),
  ).toBeVisible();
});
