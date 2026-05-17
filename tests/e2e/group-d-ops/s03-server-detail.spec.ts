/**
 * Scenario S3 — Server Detail Page (plan/2026-05-11-control-center-e2e.md).
 *
 * Walks the seeded admin through the fleet list + a single-server detail
 * page, asserting the IMPL §1.PB3 / Doc 17 §3.5 surface:
 *
 *   1. Pre-seed: 3 servers — two active, one in maintenance.
 *   2. Admin logs in (direct-seed 2FA, same pattern as S2/S7/S10/S17).
 *   3. Navigate to /sunucular and assert:
 *        - All 3 server rows visible
 *        - Each row has the correct status badge (active / maintenance)
 *        - The "Yeni Sunucu Ekle" button is visible (admin can see it)
 *   4. Click into one of the active servers' detail page and assert:
 *        - Capacity bar shows `0/<maxTenantsTheoretical>` (empty server)
 *        - Tenant list section renders the empty-state copy
 *        - Last health-check section shows "Bilinmiyor" (no probe has run)
 *        - The live SSH `docker stats` panel finishes its roundtrip and
 *          renders the canned mock output (Name=qrsiparis-demo, CPU=4.5%,
 *          MemUsage="320MiB / 768MiB", MemPerc=41.67%, NetIO="12.4MB / 8.1MB").
 *
 * --- WHY THE 3-ROW SHAPE ---
 * Two active + one maintenance exercises both branches of the
 * HealthBadge / status-pill component without needing a separate test:
 *   - active rows must NOT render "Bakımda"
 *   - maintenance row must render "Bakımda"
 *
 * --- WHY THE EMPTY-CAPACITY DETAIL ---
 * The capacity widget is also indirectly tested by S10 (a 20/20 server),
 * so here we pin the bottom of the range. `data-tenant-count=0 /
 * data-tenant-capacity=20` is what the detail page must emit.
 *
 * --- WHY ASSERT THE MOCK STATS BY VALUE ---
 * Because the test runs against `TEST_MODE=mock` (set in .env), the SSH
 * client returns the same canned JSON every time. Asserting on the exact
 * values (rather than just "panel is visible") catches a regression where
 * the panel hides errors and renders empty cells.
 *
 * --- AUTH PATTERN ---
 * Direct-seeds the admin's 2FA secret (mirrors S2/S7/S10/S12/S14/S17) so
 * the test doesn't pay the ~5s /2fa-setup wizard cost on every run.
 *
 * --- TIMEOUT BUDGET ---
 * 60s is generous: ~5s login + ~5s for list page render + ~5s for detail
 * page + ~5s for the mock SSH roundtrip (which is ~50ms in practice).
 *
 * Notes for S19 (backup cron — uses SSH `pg_dump` / `tar`):
 *   The same `getSshClient()` plumbing services both this route and S19's
 *   cron job. If the docker-stats route works end-to-end here, S19 can
 *   rely on the SSH mock + connection layer being functional.
 */

import { test, expect } from '@playwright/test';
import { authenticator } from 'otplib';

// Relative path — Playwright's TS loader doesn't honour the `@/` alias.
import { encrypt } from '../../../src/lib/crypto/aes-gcm';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';
import { createServer } from '../fixtures/server.fixture';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
const ADMIN_PASSWORD =
  process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';

test.setTimeout(60_000);

/** Mirror of S2/S7/S10/S17's 2FA direct-seed helper. */
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

/** /login → /2fa-verify → panel home (mirrors S2/S7/S10/S17). */
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
  // Reset admin's 2FA columns (defensive — same as S2/S7/S10/S12/S14/S17).
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

test('S3 server list shows all servers with correct status badges + Yeni Sunucu Ekle visible; detail page renders capacity, tenants, last health-check (Bilinmiyor), and live SSH docker stats', async ({
  page,
}) => {
  // ---- Phase 0: seed three servers (2 active, 1 maintenance) -------------
  const admin = await enable2faForAdmin();

  const active1 = await createServer({
    name: 'vps-s03-active-a',
    publicIp: '10.30.0.1',
    publicHostname: 'vps-s03-active-a.test.local',
    maxTenantsTheoretical: 20,
    status: 'active',
  });
  const active2 = await createServer({
    name: 'vps-s03-active-b',
    publicIp: '10.30.0.2',
    publicHostname: 'vps-s03-active-b.test.local',
    maxTenantsTheoretical: 20,
    status: 'active',
  });
  const maintenance = await createServer({
    name: 'vps-s03-maintenance',
    publicIp: '10.30.0.3',
    publicHostname: 'vps-s03-maintenance.test.local',
    maxTenantsTheoretical: 20,
    status: 'maintenance',
  });

  // Sanity-check the seed before we drive the UI.
  const seedCount = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM servers`,
  );
  expect(seedCount[0]!.count).toBe('3');

  // ---- Phase 1: log in ----------------------------------------------------
  await loginWithTotp(page, admin.totp_secret_plain);

  // ---- Phase 2: navigate to /sunucular -----------------------------------
  await page.goto('/sunucular');
  await expect(page.locator('h1', { hasText: 'Sunucular' })).toBeVisible({
    timeout: 10_000,
  });

  // All 3 server rows visible.
  const rows = page.locator('[data-testid="server-row"]');
  await expect(rows).toHaveCount(3);

  // Each row anchors to a specific server id; lookup the row for each
  // seeded server and assert its status badge text.
  const active1Row = page.locator(`[data-server-id="${active1.id}"]`);
  const active2Row = page.locator(`[data-server-id="${active2.id}"]`);
  const maintenanceRow = page.locator(`[data-server-id="${maintenance.id}"]`);

  await expect(active1Row).toBeVisible();
  await expect(active2Row).toBeVisible();
  await expect(maintenanceRow).toBeVisible();

  // Status data attribute reflects DB row.
  await expect(active1Row).toHaveAttribute('data-server-status', 'active');
  await expect(active2Row).toHaveAttribute('data-server-status', 'active');
  await expect(maintenanceRow).toHaveAttribute(
    'data-server-status',
    'maintenance',
  );

  // Badge text per row. We scope to each row so a stray "Bakımda" elsewhere
  // doesn't accidentally match the active rows.
  await expect(active1Row.locator('[data-testid="server-status-badge"]')).toHaveAttribute(
    'data-status',
    'active',
  );
  await expect(active2Row.locator('[data-testid="server-status-badge"]')).toHaveAttribute(
    'data-status',
    'active',
  );
  await expect(maintenanceRow.locator('[data-testid="server-status-badge"]')).toHaveAttribute(
    'data-status',
    'maintenance',
  );
  await expect(
    maintenanceRow.locator('[data-testid="server-status-badge"]'),
  ).toContainText('Bakımda');
  // The active rows MUST NOT show the "Bakımda" copy in their badge.
  await expect(active1Row.locator('[data-testid="server-status-badge"]')).not.toContainText(
    'Bakımda',
  );
  await expect(active2Row.locator('[data-testid="server-status-badge"]')).not.toContainText(
    'Bakımda',
  );

  // "Yeni Sunucu Ekle" button is visible to admin.
  const newServerButton = page.locator('[data-testid="new-server-button"]');
  await expect(newServerButton).toBeVisible();
  await expect(newServerButton).toHaveText(/Yeni Sunucu Ekle/);

  // ---- Phase 3: click into active1 to land on detail page ----------------
  await Promise.all([
    page.waitForURL(new RegExp(`/sunucular/${active1.id}`), {
      timeout: 10_000,
    }),
    active1Row.click(),
  ]);

  // Server name in the H1 — confirms we landed on the right row.
  await expect(
    page.locator('h1', { hasText: 'vps-s03-active-a' }),
  ).toBeVisible({ timeout: 10_000 });

  // Capacity card: 0/20.
  const capacity = page.locator('[data-testid="capacity-card"]');
  await expect(capacity).toBeVisible();
  await expect(capacity).toHaveAttribute('data-tenant-count', '0');
  await expect(capacity).toHaveAttribute('data-tenant-capacity', '20');
  await expect(
    page.locator('[data-testid="capacity-text"]'),
  ).toContainText('0/20');

  // Tenant list — empty state (no tenants on this server).
  await expect(page.locator('[data-testid="tenant-list"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="tenant-list-empty"]'),
  ).toBeVisible();

  // Last health-check section — server has never been probed, must show
  // "Bilinmiyor" copy.
  await expect(page.locator('[data-testid="last-health-check"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="last-health-check-unknown"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="last-health-check-unknown"]'),
  ).toContainText('Bilinmiyor');

  // ---- Phase 4: docker stats panel ---------------------------------------
  // Panel exists and finishes its roundtrip.
  await expect(page.locator('[data-testid="docker-stats-panel"]')).toBeVisible();

  // Wait for the SSH roundtrip to render values. The mock returns
  // synchronously after ~20ms; budget 10s for slow-machine first-compile.
  await expect(page.locator('[data-testid="docker-stats-name"]')).toHaveText(
    'qrsiparis-demo',
    { timeout: 10_000 },
  );
  await expect(page.locator('[data-testid="docker-stats-cpu"]')).toHaveText(
    '4.5%',
  );
  await expect(
    page.locator('[data-testid="docker-stats-mem-usage"]'),
  ).toHaveText('320MiB / 768MiB');
  await expect(
    page.locator('[data-testid="docker-stats-mem-perc"]'),
  ).toHaveText('41.67%');
  await expect(page.locator('[data-testid="docker-stats-netio"]')).toHaveText(
    '12.4MB / 8.1MB',
  );

  // Error banner must NOT appear when the mock succeeds.
  await expect(
    page.locator('[data-testid="docker-stats-error"]'),
  ).toHaveCount(0);
});
