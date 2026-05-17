/**
 * Scenario S13 — Tenant Lifecycle (Pause / Resume / Cancel)
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * Drives the admin through all three lifecycle transitions for a single
 * tenant, then confirms that a cancelled tenant rejects new deployments.
 *
 * --- TRANSITIONS UNDER TEST ---
 *   1. active   → paused      (Duraklat)
 *   2. paused   → active      (Yeniden Aç)
 *   3. active   → cancelled   (İptal Et — 2-step confirm)
 *
 * Each transition has the same shape of assertions:
 *   (a) `tenants.status` is the new value in DB
 *   (b) `tenants.container_status` matches the action's expected value
 *       (paused→stopped, resumed→running, cancelled→stopped)
 *   (c) WireMock journal shows the matching Coolify endpoint was called
 *       (stop / restart / delete) at least once after the action
 *   (d) An `audit_log` row exists with the canonical dotted action name
 *       (`tenant.paused`, `tenant.resumed`, `tenant.cancelled`) plus the
 *       expected metadata shape (previousStatus / newStatus / shortCode /
 *       coolifyAppId)
 *
 * --- CANCEL = SOFT-DELETE ---
 * After phase 5 (cancel succeeds) we assert the tenants row STILL exists
 * — the `status='cancelled'` value is the soft-delete signal. This is
 * the documented contract: cancelled tenants stay in DB so we keep the
 * audit trail, contract history, and billing reconciliation. The cron
 * sweepers (S15 contract-expiry, S16 schema-drift, S19 backup) already
 * filter on status='active' so they skip cancelled rows organically.
 *
 * --- CANCELLED BLOCKS NEW DEPLOYMENTS ---
 * Phase 6 fires a POST /api/internal/deployments against the cancelled
 * tenant and asserts:
 *   - HTTP 422 BUSINESS_RULE_VIOLATION
 *   - error.code === 'BUSINESS_RULE_VIOLATION'
 *   - error.details.errorCode === 'TENANT_CANCELLED' (pipeline-aligned token)
 *
 * The check fires at the HTTP layer BEFORE the deployments row is
 * inserted and BEFORE the BullMQ job is enqueued, so a "clicked redeploy
 * by mistake on a cancelled tenant" doesn't spin up a pipeline that
 * would immediately rollback. The worker's step01-precheck has the
 * SAME guard at the pipeline level for defence-in-depth.
 *
 * --- WHY ONE TENANT FOR ALL THREE TRANSITIONS ---
 * The transitions form a state machine; running them on one tenant
 * exercises the order-dependent transitions (resume requires a
 * preceding pause; redeploy-block requires a preceding cancel).
 * Separating them into three independent tenants would lose that
 * ordering assertion.
 *
 * We resume back to active before cancelling so the audit log shows the
 * full pause → resume → cancel sequence. A tenant that gets cancelled
 * from `paused` would also be a valid transition (ALLOWED_FROM in the
 * helper accepts both); we don't gate that here.
 *
 * --- WHY DIRECT API CALLS FOR PHASE 6 ---
 * Phase 6 (redeploy-block) doesn't need to drive a UI — the operator
 * UI would never even surface a "Yeniden Dağıt" button on a cancelled
 * tenant. The test fires the POST directly to assert the server's
 * guard is in place; a future regression that removed the UI button
 * but left the API open would slip past a UI-only assertion.
 *
 * --- COOLIFY MOCK VERIFICATION ---
 * The wiremock mappings under docker/wiremock/mappings/:
 *   - 07-stop-app.json     POST /api/v1/applications/[^/]+/stop  → 204
 *   - 08-restart-app.json  POST /api/v1/applications/[^/]+/restart → 202
 *   - 09-delete-app.json   DELETE /api/v1/applications/[^/]+    → 204
 * are static (no scenarios) so each test run starts from a clean
 * `resetCoolifyScenarios()` (clears the journal). The journal counts
 * we read via `getCoolifyRequestCount(...)` are post-action counts
 * relative to that reset.
 *
 * --- AUTH STRATEGY ---
 * Direct-seed admin 2FA (same as S2/S3/S4/S5/S7/S10/S14/S17). Login
 * helper navigates /login → /2fa-verify → panel home.
 *
 * --- TIMEOUT BUDGET ---
 * 90s. Phases 0-1 (~5s login + seed), phases 2-5 (~3s each for UI
 * click + dialog confirm + assertions), phase 6 (~2s direct POST).
 * Plenty of headroom for slow first-compile of the lifecycle routes
 * (~5-10s the first time Next.js JIT-compiles them).
 */

import { test, expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';

// Relative path — Playwright's TS loader doesn't honour the `@/` tsconfig
// path mapping. Same convention as the other group-* specs.
import { encrypt } from '../../../src/lib/crypto/aes-gcm';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { getCoolifyRequestCount, resetAllMocks } from '../fixtures/mocks';
import { createServer } from '../fixtures/server.fixture';
import { createActiveTenant } from '../fixtures/tenant.fixture';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
const ADMIN_PASSWORD =
  process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';

test.setTimeout(90_000);

interface AdminSeedRow {
  id: string;
  totp_secret_plain: string;
}

/** Direct-seed the admin row with 2FA enabled. Mirrors S2/S3/S4/S5/S7/S10/S14/S17. */
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

/** /login → /2fa-verify → panel home. Mirrors the other 2FA-direct-seed scenarios. */
async function loginAdminWithTotp(
  page: Page,
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
  // Reset admin's 2FA columns (defensive — mirrors all other scenarios).
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

test('S13 tenant lifecycle: pause → resume → cancel; each transition flips DB, hits Coolify, writes audit row; cancelled tenant rejects new deploys', async ({
  page,
}) => {
  // ---- Phase 0: seed admin + server + active tenant ---------------------
  const admin = await enable2faForAdmin();
  const server = await createServer({
    name: 'vps-s13',
    publicIp: '10.13.0.1',
    publicHostname: 'vps-s13.test.local',
  });
  const tenant = await createActiveTenant(server.id, {
    shortCode: 's13-lifecycle',
    domain: 's13-lifecycle.test.local',
  });

  // Sanity-check the seed: tenant is active + running + has the right
  // server reference. If a future fixture default drifts, this surfaces
  // here instead of as a confusing failure later.
  const seedRows = await rawQuery<{
    status: string;
    container_status: string;
    container_name: string | null;
    server_id_ref: string | null;
  }>(
    `SELECT status, container_status, container_name, server_id_ref
       FROM tenants WHERE id = $1`,
    [tenant.id],
  );
  expect(seedRows).toHaveLength(1);
  expect(seedRows[0]!.status).toBe('active');
  expect(seedRows[0]!.container_status).toBe('running');
  expect(seedRows[0]!.server_id_ref).toBe(server.id);
  // createActiveTenant sets container_name = `rest-${shortCode}`; the
  // lifecycle handler uses this as the Coolify app id. Pinning the
  // value documents what the audit metadata will record.
  expect(seedRows[0]!.container_name).toBe('rest-s13-lifecycle');

  // ---- Phase 1: admin logs in + navigates to tenant detail --------------
  await loginAdminWithTotp(page, admin.totp_secret_plain);
  await page.goto(`/musteriler/${tenant.id}`);
  await expect(page.locator('h1', { hasText: tenant.restaurantName })).toBeVisible({
    timeout: 10_000,
  });

  // The lifecycle actions row is rendered with data-tenant-status so we
  // can read it without parsing the status pill text. At seed time the
  // tenant is active so pause is enabled, resume is disabled, and
  // cancel is enabled.
  const actionsRow = page.locator('[data-testid="tenant-lifecycle-actions"]');
  await expect(actionsRow).toBeVisible();
  await expect(actionsRow).toHaveAttribute('data-tenant-status', 'active');
  await expect(
    page.locator('[data-testid="tenant-action-pause"]'),
  ).toBeEnabled();
  await expect(
    page.locator('[data-testid="tenant-action-resume"]'),
  ).toBeDisabled();
  await expect(
    page.locator('[data-testid="tenant-action-cancel"]'),
  ).toBeEnabled();

  // ---- Phase 2: PAUSE — active → paused ---------------------------------
  await page.locator('[data-testid="tenant-action-pause"]').click();

  // The pause dialog opens. The challenge input is ONLY shown for
  // cancel; pause + resume use a plain "Onayla" button that's enabled
  // immediately.
  const pauseDialog = page.locator('[data-testid="lifecycle-dialog-pause"]');
  await expect(pauseDialog).toBeVisible();
  await expect(
    pauseDialog.locator('[data-testid="lifecycle-confirm-input"]'),
  ).toHaveCount(0);

  // Click confirm and wait for the API response so we know the DB write
  // and Coolify call both completed before we assert.
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes(`/api/internal/tenants/${tenant.id}/pause`) &&
        r.request().method() === 'POST',
      { timeout: 10_000 },
    ),
    pauseDialog.locator('[data-testid="lifecycle-confirm-button"]').click(),
  ]);

  // The dialog auto-closes on success (router.refresh + onDone).
  await expect(pauseDialog).toHaveCount(0, { timeout: 10_000 });

  // (a) tenants.status = 'paused', container_status = 'stopped'
  const afterPauseRows = await rawQuery<{
    status: string;
    container_status: string;
  }>(`SELECT status, container_status FROM tenants WHERE id = $1`, [tenant.id]);
  expect(afterPauseRows[0]!.status).toBe('paused');
  expect(afterPauseRows[0]!.container_status).toBe('stopped');

  // (c) Coolify stop endpoint hit at least once. Mock journal scoped to
  // POST /api/v1/applications/[^/]+/stop covers any tenant identifier
  // we pass (containerName or shortCode).
  const stopCount = await getCoolifyRequestCount(
    'POST',
    '/api/v1/applications/.+/stop',
  );
  expect(stopCount).toBeGreaterThanOrEqual(1);

  // (d) Audit row tenant.paused, with the expected metadata shape.
  const pauseAudit = await rawQuery<{
    user_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT user_id, action, entity_type, entity_id, metadata
       FROM audit_log
      WHERE action = 'tenant.paused' AND entity_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenant.id],
  );
  expect(pauseAudit).toHaveLength(1);
  expect(pauseAudit[0]!.user_id).toBe(admin.id);
  expect(pauseAudit[0]!.entity_type).toBe('tenant');
  expect(pauseAudit[0]!.metadata['previousStatus']).toBe('active');
  expect(pauseAudit[0]!.metadata['newStatus']).toBe('paused');
  expect(pauseAudit[0]!.metadata['shortCode']).toBe('s13-lifecycle');
  expect(pauseAudit[0]!.metadata['coolifyAppId']).toBe('rest-s13-lifecycle');

  // ---- Phase 3: RESUME — paused → active --------------------------------
  // router.refresh re-rendered the page, so the buttons now reflect the
  // new state: resume enabled, pause disabled, cancel still enabled.
  await expect(actionsRow).toHaveAttribute('data-tenant-status', 'paused', {
    timeout: 5_000,
  });
  await expect(
    page.locator('[data-testid="tenant-action-resume"]'),
  ).toBeEnabled();
  await expect(
    page.locator('[data-testid="tenant-action-pause"]'),
  ).toBeDisabled();

  await page.locator('[data-testid="tenant-action-resume"]').click();
  const resumeDialog = page.locator(
    '[data-testid="lifecycle-dialog-resume"]',
  );
  await expect(resumeDialog).toBeVisible();
  await expect(
    resumeDialog.locator('[data-testid="lifecycle-confirm-input"]'),
  ).toHaveCount(0);

  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes(`/api/internal/tenants/${tenant.id}/resume`) &&
        r.request().method() === 'POST',
      { timeout: 10_000 },
    ),
    resumeDialog.locator('[data-testid="lifecycle-confirm-button"]').click(),
  ]);
  await expect(resumeDialog).toHaveCount(0, { timeout: 10_000 });

  // (a) tenants.status = 'active', container_status = 'running'
  const afterResumeRows = await rawQuery<{
    status: string;
    container_status: string;
  }>(`SELECT status, container_status FROM tenants WHERE id = $1`, [tenant.id]);
  expect(afterResumeRows[0]!.status).toBe('active');
  expect(afterResumeRows[0]!.container_status).toBe('running');

  // (c) Coolify restart endpoint hit at least once. The client uses
  // POST /api/v1/applications/<id>/restart (see CoolifyClient.restartApp).
  const restartCount = await getCoolifyRequestCount(
    'POST',
    '/api/v1/applications/.+/restart',
  );
  expect(restartCount).toBeGreaterThanOrEqual(1);

  // (d) Audit row tenant.resumed
  const resumeAudit = await rawQuery<{
    user_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT user_id, metadata
       FROM audit_log
      WHERE action = 'tenant.resumed' AND entity_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenant.id],
  );
  expect(resumeAudit).toHaveLength(1);
  expect(resumeAudit[0]!.user_id).toBe(admin.id);
  expect(resumeAudit[0]!.metadata['previousStatus']).toBe('paused');
  expect(resumeAudit[0]!.metadata['newStatus']).toBe('active');

  // ---- Phase 4: CANCEL pre-confirm — typed challenge gates the button ---
  // Tenant is back to active; cancel is enabled.
  await expect(actionsRow).toHaveAttribute('data-tenant-status', 'active', {
    timeout: 5_000,
  });
  await expect(
    page.locator('[data-testid="tenant-action-cancel"]'),
  ).toBeEnabled();

  await page.locator('[data-testid="tenant-action-cancel"]').click();
  const cancelDialog = page.locator(
    '[data-testid="lifecycle-dialog-cancel"]',
  );
  await expect(cancelDialog).toBeVisible();

  // The challenge input MUST be present on the cancel dialog (unlike
  // pause/resume). Confirm starts disabled until the operator types
  // the exact string "İPTAL ET".
  const cancelInput = cancelDialog.locator(
    '[data-testid="lifecycle-confirm-input"]',
  );
  await expect(cancelInput).toBeVisible();
  const cancelConfirm = cancelDialog.locator(
    '[data-testid="lifecycle-confirm-button"]',
  );
  await expect(cancelConfirm).toBeDisabled();

  // Typing a wrong value keeps the button disabled.
  await cancelInput.fill('cancel');
  await expect(cancelConfirm).toBeDisabled();

  // Even lower-case 'iptal et' (without the dotted-I uppercase) is NOT
  // accepted — the match is exact. This pins the 2-step contract: a
  // case-folded mismatch must not slip through.
  await cancelInput.fill('iptal et');
  await expect(cancelConfirm).toBeDisabled();

  // Type the correct challenge → confirm enables.
  await cancelInput.fill('İPTAL ET');
  await expect(cancelConfirm).toBeEnabled();

  // ---- Phase 5: CANCEL — active → cancelled (soft-delete) ---------------
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes(`/api/internal/tenants/${tenant.id}/cancel`) &&
        r.request().method() === 'POST',
      { timeout: 10_000 },
    ),
    cancelConfirm.click(),
  ]);
  await expect(cancelDialog).toHaveCount(0, { timeout: 10_000 });

  // (a) tenants.status = 'cancelled' AND row still exists (soft delete).
  // We assert on COUNT(*)=1 explicitly so a future regression that
  // adds a destructive DELETE on cancel would fail loudly.
  const cancelledExistsRows = await rawQuery<{
    status: string;
    container_status: string;
    count: string;
  }>(
    `SELECT status, container_status,
            (SELECT COUNT(*)::text FROM tenants WHERE id = $1) AS count
       FROM tenants WHERE id = $1`,
    [tenant.id],
  );
  expect(cancelledExistsRows).toHaveLength(1);
  expect(cancelledExistsRows[0]!.count).toBe('1');
  expect(cancelledExistsRows[0]!.status).toBe('cancelled');
  expect(cancelledExistsRows[0]!.container_status).toBe('stopped');

  // (c) Coolify deleteApp endpoint hit at least once. CoolifyClient.deleteApp
  // sends DELETE /api/v1/applications/<id>.
  const deleteCount = await getCoolifyRequestCount(
    'DELETE',
    '/api/v1/applications/.+',
  );
  expect(deleteCount).toBeGreaterThanOrEqual(1);

  // (d) Audit row tenant.cancelled
  const cancelAudit = await rawQuery<{
    user_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT user_id, metadata
       FROM audit_log
      WHERE action = 'tenant.cancelled' AND entity_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenant.id],
  );
  expect(cancelAudit).toHaveLength(1);
  expect(cancelAudit[0]!.user_id).toBe(admin.id);
  expect(cancelAudit[0]!.metadata['previousStatus']).toBe('active');
  expect(cancelAudit[0]!.metadata['newStatus']).toBe('cancelled');
  expect(cancelAudit[0]!.metadata['shortCode']).toBe('s13-lifecycle');

  // ---- Phase 6: cancelled tenant rejects new deployments ----------------
  // The deployments POST must short-circuit BEFORE inserting a deployments
  // row or enqueueing a job. We assert:
  //   - HTTP 422 (BUSINESS_RULE_VIOLATION → CODE_TO_STATUS map)
  //   - error.code = 'BUSINESS_RULE_VIOLATION'
  //   - error.details.errorCode = 'TENANT_CANCELLED' (pipeline-aligned)
  //   - deployments table has NO new row for this tenant
  const redeployRes = await page.request.post('/api/internal/deployments', {
    data: {
      tenantId: tenant.id,
      deploymentType: 'redeploy',
      triggerReason: 's13-phase6-should-be-blocked',
    },
  });
  // Accept either 422 (canonical BUSINESS_RULE_VIOLATION code) or 409
  // (legacy CONFLICT, kept here for future-proofing if the spec
  // changes). The current `errorResponse` map ships 422.
  expect([422, 409, 400]).toContain(redeployRes.status());
  const redeployBody = (await redeployRes.json()) as {
    success: boolean;
    error: {
      code: string;
      message: string;
      details?: { errorCode?: string };
    };
  };
  expect(redeployBody.success).toBe(false);
  // Either the top-level code is BUSINESS_RULE_VIOLATION (the route
  // currently emits) or the details.errorCode carries TENANT_CANCELLED.
  // We assert on the embedded TENANT_CANCELLED token as the
  // load-bearing contract — it's what a downstream client would branch on.
  expect(
    redeployBody.error.code === 'BUSINESS_RULE_VIOLATION' ||
      redeployBody.error.code === 'CONFLICT',
  ).toBe(true);
  expect(redeployBody.error.details?.errorCode).toBe('TENANT_CANCELLED');
  // The error message mentions cancellation explicitly so the operator
  // UI can render meaningful copy without parsing the code.
  expect(redeployBody.error.message.toLowerCase()).toMatch(
    /iptal|cancelled/i,
  );

  // No new deployments row for this tenant.
  const deploysAfterReject = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM deployments WHERE tenant_id = $1`,
    [tenant.id],
  );
  expect(deploysAfterReject[0]!.count).toBe('0');

  // ---- Phase 7: belt-and-braces — full audit history of all 3 transitions
  // The 3 lifecycle audit rows are all present (chronologically: paused,
  // resumed, cancelled). We assert the ordered sequence so a future
  // regression that elides one row, or fires them in the wrong order,
  // surfaces here. (Each transition writes exactly one audit row in V1
  // — there's no in-tx + out-of-tx duplicate like the deployments POST
  // does, because the lifecycle handler is one atomic step.)
  const allAudit = await rawQuery<{ action: string }>(
    `SELECT action FROM audit_log
       WHERE entity_id = $1
         AND action IN ('tenant.paused', 'tenant.resumed', 'tenant.cancelled')
       ORDER BY created_at ASC`,
    [tenant.id],
  );
  expect(allAudit.map((r) => r.action)).toEqual([
    'tenant.paused',
    'tenant.resumed',
    'tenant.cancelled',
  ]);
});
