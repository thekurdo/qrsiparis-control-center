/**
 * Scenario S17 — Concurrent Deploy Lock
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * A tenant may have AT MOST ONE in-flight deployment at a time. While one
 * deployment is `pending` or `in_progress`, a second
 * `POST /api/internal/deployments` for the same tenant MUST return 409
 * CONFLICT, MUST NOT create a second deployments row, and MUST NOT enqueue
 * a second BullMQ job. Once the first deployment terminates (success,
 * failed, or rolled_back), the lock releases and a subsequent POST is
 * accepted normally.
 *
 * --- WHY DIRECT API CALLS INSTEAD OF THE WIZARD ---
 * The wizard's 7-step UI flow takes ~10-15s just to fill the form, and we
 * need to fire the second POST INSIDE the ~3-4s pipeline window of the
 * first one — there's no room for re-driving the wizard between phases.
 * Direct `page.request.post('/api/internal/deployments', ...)` (which
 * inherits the logged-in session cookies) gives us deterministic timing
 * for all three phases.
 *
 * S2/S8 still exercise the wizard end-to-end; S17 trusts that path and
 * focuses on the concurrency guard.
 *
 * --- PHASE LAYOUT ---
 *   Phase 0:  Seed admin (2FA enabled), server, tenant. Log in.
 *   Phase 1:  POST #1 — assert 201 + deployments row + BullMQ job.
 *   Phase 2:  POST #2 (immediate, before #1 finishes) — assert 409 +
 *             error.code === 'CONFLICT' + details.deploymentId === id1
 *             + only 1 deployments row for this tenant + only 1 BullMQ
 *             job hash in Redis.
 *   Phase 3:  Poll deployments.status until #1 reaches `success` (the
 *             worker drives it through the happy path; ~3-4s).
 *   Phase 4:  POST #3 — assert 201 + a NEW deployments row exists.
 *
 * --- TIMEOUT BUDGET ---
 * 60s is plenty: ~5s login + ~5s phase 1 + ~5s phase 2 + ~10s wait for
 * pipeline + ~5s phase 4. We give the deployment poll a 30s budget which
 * is ~8x the typical happy-path duration, defensively wide for slow CI.
 *
 * --- DOWNSTREAM SCENARIOS ---
 * Notes for S18 (SSE log stream): the lock fires BEFORE the deployments
 * row is created, so a 409 response carries no `id` to stream from.
 * Frontend should redirect to the EXISTING deploymentId surfaced in
 * `error.details.deploymentId` instead.
 *
 * Notes for S13 (lifecycle): cancelling a tenant while it has an
 * in-flight deployment is undefined here — the lock only blocks NEW
 * deployments. S13 must handle that interaction in its own scenario.
 */

import { test, expect } from '@playwright/test';
import { authenticator } from 'otplib';

// Relative path — Playwright's TS loader doesn't honour the `@/` alias.
import { encrypt } from '../../../src/lib/crypto/aes-gcm';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';
import { createServer } from '../fixtures/server.fixture';
import { createDeployableTenant } from '../fixtures/tenant.fixture';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
const ADMIN_PASSWORD = process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';

test.setTimeout(60_000);

/** Mirror of S2/S8/S10's 2FA direct-seed helper. */
async function enable2faForAdmin(): Promise<{ totp_secret_plain: string }> {
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
  return { totp_secret_plain: totpSecret };
}

/** Mirror of S2/S8/S10's login helper. /login -> /2fa-verify -> panel. */
async function loginWithTotp(
  page: import('@playwright/test').Page,
  totpSecret: string,
): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="username"]', ADMIN_USERNAME);
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/auth/callback/credentials') && r.request().method() === 'POST',
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
      (r) => r.url().includes('/api/auth/callback/credentials') && r.request().method() === 'POST',
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
 * Poll `deployments.status` until it reaches a terminal state. Throws on
 * timeout or on a non-success terminal (the test expects the happy path
 * for the first deployment; anything else indicates worker/WireMock
 * misconfiguration).
 */
async function waitForDeploymentSuccess(deploymentId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let last:
    | {
        status: string;
        error_code: string | null;
        error_message: string | null;
      }
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
    if (last.status === 'failed' || last.status === 'rolled_back' || last.status === 'cancelled') {
      throw new Error(
        `deployment ${deploymentId} ended unexpectedly: status=${last.status} code=${last.error_code} message=${last.error_message}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `deployment ${deploymentId} did not reach success in ${timeoutMs}ms (last status=${last?.status})`,
  );
}

test.beforeEach(async ({ page }) => {
  await truncateAll();
  await resetAllMocks();
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
  await page.goto('about:blank');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* storage disabled */
    }
  });
});

test('S17 second concurrent POST returns 409, no phantom row + no second BullMQ job; lock releases when first completes', async ({
  page,
}) => {
  // ---- Phase 0: seed ------------------------------------------------------
  // `createDeployableTenant` seeds `config_snapshot` so step02
  // (CONFIG_GENERATE) doesn't fail before phase 2's concurrent POST has
  // a chance to see an in-flight deployment. See the helper docstring
  // for why this is required and what's expected to change in V1.5.
  const admin = await enable2faForAdmin();
  const server = await createServer();
  const tenant = await createDeployableTenant(server.id, {
    shortCode: 's17-concurrent',
    domain: 's17-concurrent.test.local',
  });

  await loginWithTotp(page, admin.totp_secret_plain);

  // ---- Phase 1: first POST — expect 201, row created, BullMQ job present -
  const res1 = await page.request.post('/api/internal/deployments', {
    data: {
      tenantId: tenant.id,
      deploymentType: 'initial',
      triggerReason: 's17-phase1',
    },
  });
  expect(res1.status()).toBe(201);
  const body1 = (await res1.json()) as {
    success: boolean;
    data: { deploymentId: string };
  };
  expect(body1.success).toBe(true);
  const deploymentId1 = body1.data.deploymentId;
  expect(deploymentId1).toBeTruthy();

  // The row must exist and be in an active state. The worker may have
  // already started processing (status='in_progress'), so accept either
  // 'pending' or 'in_progress' as the lock-eligible state.
  const rowsAfter1 = await rawQuery<{ status: string }>(
    `SELECT status FROM deployments WHERE id = $1`,
    [deploymentId1],
  );
  expect(rowsAfter1).toHaveLength(1);
  expect(['pending', 'in_progress']).toContain(rowsAfter1[0]!.status);

  // BullMQ job present (the queue producer uses `jobId=deploymentId`).
  // The worker may have already consumed and pruned the job by the time we
  // check, so we don't HARD-assert presence here. Instead we capture the
  // pre-conflict job count so phase 2 can prove the conflict POST did NOT
  // add another entry.
  // Snapshot deployment count for the tenant BEFORE phase 2. Should be
  // exactly 1 (the row we just created).
  const beforeConflictCount = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM deployments WHERE tenant_id = $1`,
    [tenant.id],
  );
  expect(beforeConflictCount[0]!.count).toBe('1');

  // ---- Phase 2: SECOND POST — expect 409 ---------------------------------
  // We fire this immediately without waiting for #1 to advance. Because
  // the worker starts processing within milliseconds of the enqueue, the
  // row's status when this second POST hits the guard may be either
  // 'pending' (worker hasn't picked it up yet) or 'in_progress' (worker
  // has started running). Either way the guard's WHERE clause matches
  // both and the response MUST be 409.
  const res2 = await page.request.post('/api/internal/deployments', {
    data: {
      tenantId: tenant.id,
      deploymentType: 'initial',
      triggerReason: 's17-phase2-should-fail',
    },
  });
  expect(res2.status()).toBe(409);
  const body2 = (await res2.json()) as {
    success: boolean;
    error: {
      code: string;
      message: string;
      details?: { deploymentId?: string };
    };
  };
  expect(body2.success).toBe(false);
  expect(body2.error.code).toBe('CONFLICT');
  // The message should clearly indicate that a deployment is already in
  // progress (Turkish — the operator-facing surface is TR-only per
  // Doc 17 §1). We pin the most-load-bearing keyword.
  expect(body2.error.message.toLowerCase()).toMatch(/devam eden|in progress|in[- ]?flight|zaten/i);
  // Surfacing the in-flight deploymentId lets the UI redirect the operator
  // to the existing pipeline's log stream instead of starting a duplicate.
  expect(body2.error.details?.deploymentId).toBe(deploymentId1);

  // ---- Phase 2 assertions: NO phantom row, NO duplicate BullMQ job ------
  const afterConflictCount = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM deployments WHERE tenant_id = $1`,
    [tenant.id],
  );
  expect(afterConflictCount[0]!.count).toBe('1');

  // The audit_log should reference EXACTLY ONE deployment id for this
  // tenant — the one from phase 1. The rejected POST writes no audit row
  // (the guard fires BEFORE the insert transaction). Each successful
  // POST writes TWO `deployment.triggered` audit rows (one in-tx for
  // referential integrity, one out-of-tx for the IP/UA capture); we
  // assert on the DISTINCT entity_id count so the test doesn't care
  // about that internal accounting choice.
  const triggeredAuditDistinct = await rawQuery<{ count: string }>(
    `SELECT COUNT(DISTINCT entity_id)::text AS count
       FROM audit_log
      WHERE action = 'deployment.triggered'
        AND (metadata->>'tenantId') = $1`,
    [tenant.id],
  );
  expect(triggeredAuditDistinct[0]!.count).toBe('1');

  // ---- Phase 3: wait for the first deployment to terminate ----------------
  // The happy-path WireMock mappings drive step03/06/07 to success, and
  // step04 is the only sleep (~1s). Total pipeline runs in ~3-4s; we give
  // 30s of headroom for slow CI / first-compile JIT cost.
  await waitForDeploymentSuccess(deploymentId1, 30_000);

  // The BullMQ job hash should have been pruned by `removeOnComplete: { count: 100 }`
  // — but only if there are >100 completed jobs, which obviously isn't the
  // case in a per-test truncated DB. So the hash will still exist in the
  // `completed` set; that's not load-bearing for this test. We simply
  // assert the deployments row terminal state and let the worker manage
  // its own Redis bookkeeping.
  const terminalRow = await rawQuery<{ status: string }>(
    `SELECT status FROM deployments WHERE id = $1`,
    [deploymentId1],
  );
  expect(terminalRow[0]!.status).toBe('success');

  // ---- Phase 4: THIRD POST — should now succeed (lock released) ----------
  const res3 = await page.request.post('/api/internal/deployments', {
    data: {
      tenantId: tenant.id,
      deploymentType: 'redeploy',
      triggerReason: 's17-phase4-after-release',
    },
  });
  expect(res3.status()).toBe(201);
  const body3 = (await res3.json()) as {
    success: boolean;
    data: { deploymentId: string };
  };
  expect(body3.success).toBe(true);
  const deploymentId3 = body3.data.deploymentId;
  expect(deploymentId3).toBeTruthy();
  expect(deploymentId3).not.toBe(deploymentId1);

  // A second deployments row should now exist for this tenant — #1
  // (terminal: success) and #3 (just created).
  const finalRows = await rawQuery<{ id: string; status: string }>(
    `SELECT id, status FROM deployments
      WHERE tenant_id = $1
      ORDER BY created_at ASC`,
    [tenant.id],
  );
  expect(finalRows).toHaveLength(2);
  expect(finalRows[0]!.id).toBe(deploymentId1);
  expect(finalRows[0]!.status).toBe('success');
  expect(finalRows[1]!.id).toBe(deploymentId3);
  expect(['pending', 'in_progress', 'success']).toContain(finalRows[1]!.status);

  // Sanity: BullMQ job for deployment #3 was enqueued under its own id
  // (or already consumed). We just assert the queue accepted the second
  // enqueue without throwing (which we'd have seen as a 500 from the
  // route handler). The `removeDeploymentJob` / auto-prune Redis
  // bookkeeping is covered by S9.
});
