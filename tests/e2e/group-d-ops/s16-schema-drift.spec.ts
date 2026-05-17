/**
 * Scenario S16 — Schema Drift Detection
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * The `tenant-schema-drift-detector` cron compares each tenant's reported
 * `schema_version` against the control-center's
 * `EXPECTED_TENANT_SCHEMA_VERSION` (currently 3). For each tenant whose
 * version is BEHIND expected (`tenant.schema_version < EXPECTED`) AND is
 * not `cancelled`, the cron writes an audit row:
 *
 *   action      = 'tenant.schema_drift'
 *   entity_type = 'tenant'
 *   entity_id   = <tenant.id>
 *   user_id     = NULL  (system action)
 *   metadata    = { shortCode, tenantVersion, expectedVersion, status }
 *
 * Idempotency: a re-run within 24h MUST NOT write a second row for the
 * same tenant (mirrors S15's 24h gate).
 *
 * Tenant detail UI: `/musteriler/[id]` shows a warning banner whenever
 * `tenant.schema_version < EXPECTED` (and status != 'cancelled'). The
 * banner is computed inline from the tenant row — it does NOT require the
 * cron to have run, so operators see the drift state immediately on
 * navigation even between cron ticks.
 *
 * Test seeds 2 tenants on a fresh server:
 *   - Tenant A : schema_version = 2 → DRIFTED (expected = 3)
 *   - Tenant B : schema_version = 3 → IN-SYNC, no flag
 *
 * Phases:
 *   1. Invoke `runSchemaDriftDetector` directly.
 *   2. Assert one audit row (tenant A only), full metadata shape.
 *   3. Assert NO row for tenant B (in-sync) and NO row for tenant A on a
 *      negative entity_id probe (defensive — same shape as S15).
 *   4. Log in admin via the seeded 2FA flow, navigate to
 *      `/musteriler/<tenantA.id>` and assert the drift banner is visible.
 *   5. Navigate to `/musteriler/<tenantB.id>` and assert NO drift banner.
 *   6. Re-run the cron and assert idempotency: still exactly one row.
 *
 * --- WHY DIRECT IMPORT OF THE CRON ---
 * Same rationale as S9 (stuck recovery) and S15 (contract expiry): there
 * is no `/api/internal/crons/[name]/trigger` endpoint in V1 — the
 * scheduler itself is V1.5, see `src/app/(panel)/sistem/cron/page.tsx`.
 * Playwright's TS loader resolves the `@/` tsconfig alias (S15 imports
 * `runContractExpiry` the same way), so importing
 * `runSchemaDriftDetector` from '@/lib/crons/tenant-schema-drift-detector'
 * is the simplest way to drive the cron in-process against the same
 * Postgres the dev server uses.
 *
 * --- WHY 2 / 3 INSTEAD OF 1 / 3 ---
 * Boundary at the *just-below-expected* version is more useful than a
 * far-below one:
 *   - 2 catches "the cron used `<=` instead of `<`" regressions (would
 *     fail because tenant B at v3 should NOT be flagged).
 *   - 3 catches "the cron used `<=` instead of `<`" regressions from the
 *     other direction (would fail because tenant B at v3 WOULD be flagged).
 * A v1 tenant would also work but doesn't add coverage over v2.
 *
 * --- WHY ACTIVE STATUS ---
 * The cron excludes `cancelled` (those tenants will not receive a
 * migration). Onboarding/active/paused are all legitimate drift
 * candidates — the very R18 case is a paused tenant that missed a
 * migration. Tests use `createActiveTenant()` for predictability; a
 * separate cancellation-exclusion test would be its own scenario.
 *
 * --- WHY BROWSER FOR THE BANNER ---
 * Unlike S15 (purely DB-driven) the UI surface here IS a new contract.
 * The banner's existence on /musteriler/[id] for a drifting tenant —
 * and its ABSENCE for an in-sync one — is the load-bearing assertion
 * for the operator-visibility side of the scenario. Hitting the page
 * via Playwright is the only way to prove the React server component
 * renders the alert div with the right `role="alert"` and metadata.
 *
 * --- AUTH PATTERN ---
 * Direct-seeds the admin's 2FA secret (mirrors S2/S3/S4/S5/S7/S10/S14/S17)
 * so the test doesn't pay the ~5s /2fa-setup wizard cost every run.
 *
 * --- TIMEOUT BUDGET ---
 * 90s: ~10s cron + ~5s login + ~5s for two detail-page navigations + slack
 * for first-compile warmup on the route.
 *
 * --- DOWNSTREAM SCENARIOS ---
 * Notes for S19 (backup cron): same audit-row + 24h idempotency pattern.
 * The backup cron should write `backup.completed` / `backup.failed` rows
 * and gate re-runs the same way `recordAudit()` is INSERT-only by
 * construction (S11), so the cron family is uniformly tamper-evident.
 *
 * Notes for S13 (lifecycle — pause/resume/cancel): a drifting tenant
 * SHOULD still be pause-able (lifecycle and schema versions are
 * orthogonal — pausing is what often CAUSES drift, since the container
 * stops receiving migrations). The resume path, however, is the V1.5
 * pre-check site for this cron — IMPL §4 calls out "block resume until
 * drift cleared", which S13's resume scenario should pin once the
 * pre-check is wired.
 */

import { test, expect } from '@playwright/test';
import { authenticator } from 'otplib';

import {
  EXPECTED_TENANT_SCHEMA_VERSION,
  runSchemaDriftDetector,
} from '@/lib/crons/tenant-schema-drift-detector';

// Relative path — convention matches the other group-* specs (S3/S5).
import { encrypt } from '../../../src/lib/crypto/aes-gcm';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';
import { createServer } from '../fixtures/server.fixture';
import { createActiveTenant } from '../fixtures/tenant.fixture';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
const ADMIN_PASSWORD =
  process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';

test.setTimeout(90_000);

/** Mirror of S3/S5's 2FA direct-seed helper. */
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

/** /login → /2fa-verify → panel home (mirrors S3/S5). */
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

test.beforeEach(async ({ page }) => {
  await truncateAll();
  await resetAllMocks();
  resetCounter();
  // Reset admin's 2FA columns (defensive — same as S3/S5).
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

test('S16 schema-drift cron flags only the v2 tenant, UI shows banner on drifting tenant detail page, and the cron is idempotent on re-run', async ({
  page,
}) => {
  // Make sure the test is wired to the same EXPECTED version the cron
  // ships with. If a future bump changes the constant, this assertion
  // shows up first instead of a confusing "expected 0 got 1" later.
  expect(EXPECTED_TENANT_SCHEMA_VERSION).toBe(3);

  // ---- Phase 0: seed a server + 2 tenants with different schema versions
  const admin = await enable2faForAdmin();
  const server = await createServer({ name: 'vps-s16' });

  const tenantA = await createActiveTenant(server.id, {
    shortCode: 's16-tenant-a',
    domain: 's16-tenant-a.test.local',
    schemaVersion: 2, // one behind — DRIFTED
  });
  const tenantB = await createActiveTenant(server.id, {
    shortCode: 's16-tenant-b',
    domain: 's16-tenant-b.test.local',
    schemaVersion: 3, // matches expected — IN-SYNC
  });

  // Sanity-check the seed.
  const seed = await rawQuery<{
    id: string;
    short_code: string;
    schema_version: number;
    status: string;
  }>(
    `SELECT id, short_code, schema_version, status
       FROM tenants
      WHERE short_code LIKE 's16-tenant-%'
      ORDER BY short_code ASC`,
  );
  expect(seed).toHaveLength(2);
  expect(seed[0]!.schema_version).toBe(2);
  expect(seed[0]!.status).toBe('active');
  expect(seed[1]!.schema_version).toBe(3);
  expect(seed[1]!.status).toBe('active');

  // ---- Phase 1: first cron run ----------------------------------------
  const r1 = await runSchemaDriftDetector();
  expect(r1.flagged).toBe(1);
  expect(r1.tenantIds).toEqual([tenantA.id]);

  // ---- Phase 2: audit log shape ---------------------------------------
  // Scope to the canonical action name so any other audit rows the system
  // may have written do not interfere with the count.
  const auditRows1 = await rawQuery<{
    id: string;
    user_id: string | null;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id, user_id, action, entity_type, entity_id, metadata
       FROM audit_log
      WHERE action = 'tenant.schema_drift'
      ORDER BY created_at ASC`,
  );
  expect(auditRows1).toHaveLength(1);
  const row = auditRows1[0]!;
  // userId is null — this is a system-driven cron, not an operator action.
  expect(row.user_id).toBeNull();
  expect(row.action).toBe('tenant.schema_drift');
  expect(row.entity_type).toBe('tenant');
  expect(row.entity_id).toBe(tenantA.id);
  // Metadata carries everything ops needs at a glance: tenant id (via
  // short_code), tenant's reported version, the expected version we
  // compared against, and the tenant's lifecycle status.
  expect(row.metadata?.['shortCode']).toBe('s16-tenant-a');
  expect(row.metadata?.['tenantVersion']).toBe(2);
  expect(row.metadata?.['expectedVersion']).toBe(EXPECTED_TENANT_SCHEMA_VERSION);
  expect(row.metadata?.['status']).toBe('active');

  // Negative assertion: no row for tenant B (in-sync). Probe by entity_id
  // (not just count) so a future cron that writes some other tenant-scoped
  // audit row doesn't accidentally pass this.
  const bRows = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log
       WHERE action = 'tenant.schema_drift' AND entity_id = $1`,
    [tenantB.id],
  );
  expect(bRows[0]!.count).toBe('0');

  // ---- Phase 3: log in and navigate to tenant A detail page -----------
  // The banner is computed inline from `tenant.schemaVersion <
  // EXPECTED_TENANT_SCHEMA_VERSION`, so even if the cron hadn't yet run
  // the banner would still be visible. Asserting on it after the cron is
  // a slightly stricter check but the same pass/fail outcome — we're
  // really pinning the page-side comparison logic here.
  await loginWithTotp(page, admin.totp_secret_plain);

  await page.goto(`/musteriler/${tenantA.id}`);
  await expect(
    page.locator('h1', { hasText: tenantA.restaurantName }),
  ).toBeVisible({ timeout: 10_000 });

  const driftBanner = page.locator('[data-testid="schema-drift-banner"]');
  await expect(driftBanner).toBeVisible();
  await expect(driftBanner).toHaveAttribute('role', 'alert');
  // The banner exposes data attributes so a future i18n change to the
  // copy doesn't silently break this assertion.
  await expect(driftBanner).toHaveAttribute('data-tenant-version', '2');
  await expect(driftBanner).toHaveAttribute(
    'data-expected-version',
    String(EXPECTED_TENANT_SCHEMA_VERSION),
  );
  // Copy sanity check — must mention "drift" (or its TR equivalent
  // "Şema sürüm uyumsuzluğu") so an operator can grok it at a glance.
  await expect(driftBanner).toContainText(/Şema sürüm uyumsuzluğu/);

  // ---- Phase 4: tenant B detail page must NOT show the banner ---------
  await page.goto(`/musteriler/${tenantB.id}`);
  await expect(
    page.locator('h1', { hasText: tenantB.restaurantName }),
  ).toBeVisible({ timeout: 10_000 });
  // toHaveCount(0) is strictly stronger than not.toBeVisible(): a banner
  // rendered with display:none would still pass not.toBeVisible() and
  // mask a regression where the banner is unconditionally in the DOM
  // and hidden via CSS. Pin "the element does not exist".
  await expect(
    page.locator('[data-testid="schema-drift-banner"]'),
  ).toHaveCount(0);

  // ---- Phase 5: idempotency — re-run the cron -------------------------
  // Re-running within the 24h window must NOT write a second row for
  // tenant A. The cron's pre-SELECT gates on:
  //   action='tenant.schema_drift'
  //   entity_id=t.id
  //   created_at >= NOW() - 24h
  // so the second invocation finds the first row and skips.
  const r2 = await runSchemaDriftDetector();
  expect(r2.flagged).toBe(0);
  expect(r2.tenantIds).toEqual([]);

  // ---- Phase 6: assert no second row appeared -------------------------
  const auditRows2 = await rawQuery<{ id: string; entity_id: string | null }>(
    `SELECT id, entity_id FROM audit_log
      WHERE action = 'tenant.schema_drift'
      ORDER BY created_at ASC`,
  );
  expect(auditRows2).toHaveLength(1);
  expect(auditRows2[0]!.id).toBe(row.id); // same row, not a new one
  expect(auditRows2[0]!.entity_id).toBe(tenantA.id);

  // Belt-and-braces: total count of tenant.schema_drift rows in the table
  // is exactly 1 (catches a hypothetical regression where the cron
  // somehow flagged tenant B on the re-run).
  const total = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log
       WHERE action = 'tenant.schema_drift'`,
  );
  expect(total[0]!.count).toBe('1');
});
