/**
 * Scenario S5 — Audit Log Write + Filters
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * Walks the admin through four distinct operator actions, then opens
 * /sistem/audit and asserts the table + filter UI honours the audit_log
 * contract:
 *
 *   1. Admin logs in (direct-seed 2FA, same pattern as S2/S3/S4/S7/S10/S14/S17).
 *   2. Perform 4 distinct actions — each emits a unique audit_log row:
 *        a. POST   /api/internal/operator-users        → operator_user.created
 *        b. UPDATE servers (DB) + audit insert         → server.updated
 *        c. INSERT tenants (DB) + audit insert         → tenant.created
 *        d. DELETE /api/internal/operator-users/[id]   → operator_user.deleted
 *      Actions (b) + (c) are simulated via direct DB writes (with matching
 *      audit-log rows in the canonical dotted convention) because:
 *        - No PATCH /api/internal/servers/[id] route exists in V1 — the
 *          server edit surface ships in V1.5. We still need the row to
 *          exercise the entity_type='server' filter today.
 *        - The tenant create endpoint runs through the 7-step wizard
 *          schema; spinning up a full valid payload here would dwarf the
 *          actual filter assertions. The task spec explicitly calls out
 *          this shortcut: "Create a tenant via the API (or simulate by
 *          inserting + writing audit row)".
 *   3. Navigate to /sistem/audit and assert:
 *        - All 4 rows visible in the audit-log table
 *        - Each row shows timestamp, actor (admin), entity_type, action,
 *          and a summary derived from `metadata`
 *   4. Test filters end-to-end (URL-driven, server-rendered):
 *        - Filter by actor (admin id)              → all 4 rows
 *        - Filter by action `operator_user.created` → only that one row
 *        - Filter by entity_type=`operator_user`   → 2 rows (created+deleted)
 *        - Filter by entity_type=`server`          → 1 row
 *        - Filter by entity_type=`tenant`          → 1 row
 *        - Filter by date range (today only)       → all 4 rows
 *        - Combination filter (action+entityType)  → exactly the matching row
 *   5. Pagination — seed 30 extra `audit_log.bulk_filler` rows so we cross
 *      the PAGE_SIZE=25 boundary. Assert:
 *        - Page 1 shows 25 rows + "Daha Fazla" link is enabled
 *        - Page 2 shows the remainder + "Önceki" link present
 *
 * --- WHY DRIVE THE UI INSTEAD OF QUERYING THE DB ---
 * The DB-level assertions are interesting but trivial — once a row is
 * INSERTed the SELECT WHERE clause matches by definition. The harder
 * surface is the FILTER UI: does the page correctly translate URL search
 * params into WHERE clauses, does the pager preserve filters, does the
 * entity_type dropdown enumerate the right values, etc. The UI is the
 * load-bearing artefact for S5 so we exercise it through Playwright.
 *
 * --- WHY ASSERT NO EDIT/DELETE BUTTONS ---
 * Per S11 (audit immutability — DB trigger `tr_audit_log_immutable`
 * rejects UPDATE/DELETE on audit_log), the audit log surface MUST be
 * read-only. A future regression that adds "Sil" or "Düzenle" buttons
 * here would be invisible to a row-count assertion but immediately
 * caught by the negative assertion in step (3).
 *
 * --- ACTION NAME CONVENTIONS (carried from S2 / S4 / S14) ---
 * Two conventions coexist in `audit_log.action`:
 *   - Dotted (entity.verb)   : `operator_user.created`, `server.updated`,
 *                              `tenant.created`, `operator_user.deleted`,
 *                              `deployment.triggered`, `deployment.failed`.
 *   - Snake_case (security)  : `operator_role_changed`, `backup_code_used`,
 *                              `2fa_enabled`.
 * The filter UI handles BOTH because the action dropdown is populated from
 * `SELECT DISTINCT action FROM audit_log` — anything we INSERT shows up.
 *
 * --- DOWNSTREAM SCENARIOS ---
 * Notes for S11 (audit immutability — UPDATE/DELETE rejected by DB
 * trigger): this test pins the contract that NO edit/delete UI exists on
 * /sistem/audit. S11 should additionally try `UPDATE audit_log` and
 * `DELETE FROM audit_log` directly and assert the trigger rejects them.
 *
 * Notes for S19 (backup cron): the daily-backup job writes audit rows
 * `backup.completed` / `backup.failed`. The action dropdown on
 * /sistem/audit reads distinct values from DB, so those names appear in
 * the facet automatically once the cron writes one — S19 doesn't need
 * the page to add a hard-coded option.
 */

import { test, expect } from '@playwright/test';
import { authenticator } from 'otplib';

// Relative path — Playwright's TS loader doesn't honour the `@/` alias the
// way Vitest does. Same convention as the other group-* specs.
import { encrypt } from '../../../src/lib/crypto/aes-gcm';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';
import { createServer } from '../fixtures/server.fixture';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
const ADMIN_PASSWORD =
  process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';

test.setTimeout(90_000);

interface AdminSeedRow {
  id: string;
  totp_secret_plain: string;
}

/** Direct-seed the admin row with 2FA enabled. Mirrors S2/S3/S4/S7/S10/S14/S17. */
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

/** /login → /2fa-verify → panel home (mirrors S2/S3/S4/S7/S10/S14/S17). */
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
  // Reset admin's 2FA columns (defensive — same as S2/S3/S4/S7/S10/S12/S14/S17).
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

test('S5 audit log captures 4 distinct admin actions; all filter dimensions work in isolation and combined; pagination crosses the 25-row page boundary; UI exposes NO edit/delete controls', async ({
  page,
}) => {
  // ---- Phase 0: seed admin 2FA + initial fleet --------------------------
  const admin = await enable2faForAdmin();

  // Seed a server we'll "edit" in action (b). We use the fixture so the
  // row shape exactly matches what the production form would have written.
  const seededServer = await createServer({
    name: 'vps-s05-edited',
    publicIp: '10.50.0.1',
    publicHostname: 'vps-s05-edited.test.local',
    maxTenantsTheoretical: 20,
    status: 'active',
  });

  // ---- Phase 1: admin logs in -------------------------------------------
  await loginAdminWithTotp(page, admin.totp_secret_plain);

  // ---- Phase 2: emit 4 distinct audit rows ------------------------------
  // (2a) operator_user.created — via real POST endpoint. Re-uses the same
  // password policy + bcrypt path as S4, end-to-end.
  const NEW_USERNAME = 'test-s05-target';
  const NEW_EMAIL = 'test-s05-target@cyxares.test';
  const NEW_FULLNAME = 'Test S05 Target User';
  const NEW_PASSWORD = 'CyxTestS05!2026#';
  const createRes = await page.request.post('/api/internal/operator-users', {
    data: {
      username: NEW_USERNAME,
      email: NEW_EMAIL,
      fullName: NEW_FULLNAME,
      password: NEW_PASSWORD,
      role: 'operator',
      isActive: true,
    },
  });
  expect(createRes.ok()).toBe(true);
  expect(createRes.status()).toBe(201);
  const createJson = (await createRes.json()) as {
    success: boolean;
    data: { id: string };
  };
  const newUserId = createJson.data.id;

  // (2b) server.updated — direct DB write because no PATCH route exists in
  // V1. We update a real column to confirm the audit row corresponds to a
  // real state change (status: active → maintenance).
  await rawQuery(`UPDATE servers SET status = 'maintenance' WHERE id = $1`, [
    seededServer.id,
  ]);
  await rawQuery(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
     VALUES ($1, 'server.updated', 'server', $2, $3::jsonb, $4, $5)`,
    [
      admin.id,
      seededServer.id,
      JSON.stringify({
        changed: ['status'],
        oldStatus: 'active',
        newStatus: 'maintenance',
      }),
      // ip_address + user_agent columns store sha256 hashes (KVKK gate);
      // the production audit writer hashes 'unknown' when the header is
      // absent. We replicate that for parity.
      'sha256-test-ip-hash',
      'sha256-test-ua-hash',
    ],
  );

  // (2c) tenant.created — direct insert + audit row. The wizard's full
  // 7-step payload is exercised by S2; here we only need a tenant row
  // whose audit entry has entity_type='tenant' for the filter test.
  const tenantInsert = await rawQuery<{ id: string }>(
    `INSERT INTO tenants (
       short_code, restaurant_name, contact_name, contact_phone, city, tier,
       signed_at, contract_start_date, contract_end_date, monthly_fee_kurus,
       server_id_ref, domain, status, container_status, config_version,
       schema_version
     ) VALUES (
       's05-test-tenant', 'S05 Test Restoran', 'S05 Contact', '+905550005000',
       'İstanbul', 'baslangic', NOW(), NOW(), NOW() + interval '365 days',
       50000, $1, 's05-test.test.local', 'onboarding', 'not_deployed', 1, 1
     )
     RETURNING id`,
    [seededServer.id],
  );
  const newTenantId = tenantInsert[0]!.id;
  await rawQuery(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
     VALUES ($1, 'tenant.created', 'tenant', $2, $3::jsonb, $4, $5)`,
    [
      admin.id,
      newTenantId,
      JSON.stringify({
        shortCode: 's05-test-tenant',
        tier: 'baslangic',
        domain: 's05-test.test.local',
      }),
      'sha256-test-ip-hash',
      'sha256-test-ua-hash',
    ],
  );

  // (2d) operator_user.deleted — via real DELETE endpoint. The soft-delete
  // toggles is_active=false and writes the audit row in one shot.
  const deleteRes = await page.request.delete(
    `/api/internal/operator-users/${newUserId}`,
  );
  expect(deleteRes.ok()).toBe(true);
  expect(deleteRes.status()).toBe(200);

  // DB sanity: 4 audit rows now exist for our 4 actions. (There may also
  // be unrelated rows from other systems, but those would have entity_id
  // not matching ours so they don't interfere with the per-entity
  // filters tested below.)
  const seedCount = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log
       WHERE action IN ('operator_user.created', 'operator_user.deleted',
                        'server.updated', 'tenant.created')`,
  );
  expect(Number(seedCount[0]!.count)).toBe(4);

  // ---- Phase 3: open audit log page -------------------------------------
  await page.goto('/sistem/audit');
  await expect(page.locator('h1', { hasText: 'Audit Log' })).toBeVisible({
    timeout: 10_000,
  });

  // Table is visible with all 4 rows. We scope to data-testid="audit-row"
  // so any in-page chrome with the word "row" doesn't confuse the count.
  const allRows = page.locator('[data-testid="audit-row"]');
  await expect(allRows).toHaveCount(4);

  // Negative assertion for S11 immutability contract: NO edit/delete UI
  // exists on this surface. The table is read-only by construction.
  // We probe by Turkish copy ("Sil", "Düzenle") and by HTML semantics
  // (no <form> on a per-row dropdown, no DELETE-flavoured buttons).
  // The filter form contains the only button on the page that should be
  // "Filtrele" or "Sıfırla".
  await expect(
    page.locator('[data-testid="audit-log-table"] button:has-text("Sil")'),
  ).toHaveCount(0);
  await expect(
    page.locator(
      '[data-testid="audit-log-table"] button:has-text("Düzenle")',
    ),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="audit-log-table"] a:has-text("Sil")'),
  ).toHaveCount(0);

  // Each of the 4 actions is present in the table (data-action attribute
  // is the canonical anchor — the visible text could be styled away by a
  // future theme change).
  await expect(
    page.locator('[data-testid="audit-row"][data-action="operator_user.created"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="audit-row"][data-action="operator_user.deleted"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="audit-row"][data-action="server.updated"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="audit-row"][data-action="tenant.created"]'),
  ).toHaveCount(1);

  // Per-row content: each row shows timestamp + actor (admin username) +
  // action + entity columns. We inspect the operator_user.created row
  // since it has the richest metadata to render.
  const createdRow = page.locator(
    '[data-testid="audit-row"][data-action="operator_user.created"]',
  );
  await expect(
    createdRow.locator('[data-testid="audit-row-actor"]'),
  ).toContainText(ADMIN_USERNAME);
  await expect(
    createdRow.locator('[data-testid="audit-row-action"]'),
  ).toHaveText('operator_user.created');
  await expect(
    createdRow.locator('[data-testid="audit-row-entity"]'),
  ).toContainText('operator_user');
  // Summary cell shows at least the username key from metadata.
  await expect(
    createdRow.locator('[data-testid="audit-row-summary"]'),
  ).toContainText('username=');
  await expect(
    createdRow.locator('[data-testid="audit-row-summary"]'),
  ).toContainText(NEW_USERNAME);
  // Timestamp cell is non-empty.
  const timeText = await createdRow
    .locator('[data-testid="audit-row-time"]')
    .innerText();
  expect(timeText.trim().length).toBeGreaterThan(0);

  // ---- Phase 4a: filter by actor (admin id) → all 4 rows ----------------
  await page.goto(`/sistem/audit?actor=${admin.id}`);
  await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(4);

  // Every row's actor matches our admin id.
  const actorIds = await page
    .locator('[data-testid="audit-row"]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-actor-id')),
    );
  for (const id of actorIds) {
    expect(id).toBe(admin.id);
  }

  // ---- Phase 4b: filter by action → exactly 1 row -----------------------
  await page.goto('/sistem/audit?action=operator_user.created');
  await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(1);
  await expect(
    page.locator('[data-testid="audit-row"]').first(),
  ).toHaveAttribute('data-action', 'operator_user.created');

  // ---- Phase 4c: filter by entity_type ----------------------------------
  // operator_user: 2 rows (created + deleted)
  await page.goto('/sistem/audit?entityType=operator_user');
  await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(2);
  const opUserActions = await page
    .locator('[data-testid="audit-row"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-action')));
  expect(new Set(opUserActions)).toEqual(
    new Set(['operator_user.created', 'operator_user.deleted']),
  );

  // server: 1 row
  await page.goto('/sistem/audit?entityType=server');
  await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(1);
  await expect(
    page.locator('[data-testid="audit-row"]').first(),
  ).toHaveAttribute('data-action', 'server.updated');

  // tenant: 1 row
  await page.goto('/sistem/audit?entityType=tenant');
  await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(1);
  await expect(
    page.locator('[data-testid="audit-row"]').first(),
  ).toHaveAttribute('data-action', 'tenant.created');

  // ---- Phase 4d: filter by date range (today only) → all 4 -------------
  // Use YYYY-MM-DD anchored on `today` (UTC). The page treats `dateTo` as
  // inclusive end-of-day (`<dateTo+1`) so today=today catches all of
  // today's rows.
  const today = new Date().toISOString().slice(0, 10);
  await page.goto(`/sistem/audit?dateFrom=${today}&dateTo=${today}`);
  await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(4);

  // Filter to yesterday only → 0 rows (the rows we just wrote are dated
  // `today`). This proves the date filter actually constrains.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  await page.goto(
    `/sistem/audit?dateFrom=${yesterday}&dateTo=${yesterday}`,
  );
  await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="audit-empty"]')).toBeVisible();

  // ---- Phase 4e: combined filter (action + entityType) -----------------
  // `operator_user.created` AND entityType=`operator_user` → exactly 1 row.
  // Adding entityType=`server` to the same action → 0 rows (the action's
  // entity_type is `operator_user`, not `server`).
  await page.goto(
    '/sistem/audit?action=operator_user.created&entityType=operator_user',
  );
  await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(1);

  await page.goto(
    '/sistem/audit?action=operator_user.created&entityType=server',
  );
  await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(0);

  // ---- Phase 5: pagination ---------------------------------------------
  // Seed 30 extra rows so total > PAGE_SIZE (25). The action name uses
  // a deliberately throw-away tag (`audit.bulk_filler`) so this seed
  // doesn't collide with anything real. Spread the timestamps across
  // today so the today-only filter still matches them (defensive — if a
  // future test reuses this page with a date filter).
  for (let i = 0; i < 30; i++) {
    await rawQuery(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata, ip_address, user_agent, created_at)
       VALUES ($1, 'audit.bulk_filler', 'filler', $2, $3::jsonb, $4, $5, NOW() - ($6 || ' seconds')::interval)`,
      [
        admin.id,
        `filler-${i}`,
        JSON.stringify({ idx: i }),
        'sha256-test-ip-hash',
        'sha256-test-ua-hash',
        // Spread the rows over ~30 seconds so they all bunch up today
        // but have distinct created_at values for stable ordering.
        String(i + 1),
      ],
    );
  }

  // Page 1: 25 rows (PAGE_SIZE) + Daha Fazla enabled. With 34 total rows
  // (4 originals + 30 filler), the first page should show the 25 most
  // recent — all 30 fillers were inserted AFTER the originals but with
  // descending offsets, so the most recent 25 will include the latest
  // ~25 fillers (some originals may or may not appear on page 1; the
  // exact ordering depends on insert timestamps — we only assert
  // counts + nav controls here).
  await page.goto('/sistem/audit');
  await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(25);
  await expect(page.locator('[data-testid="audit-pager-next"]')).toBeVisible();
  // Total is at least 4 originals + 30 fillers = 34.
  const totalCount = await page
    .locator('[data-testid="audit-total-count"]')
    .getAttribute('data-total');
  expect(Number(totalCount)).toBeGreaterThanOrEqual(34);

  // Click "Daha Fazla" → page 2. Remaining rows = total - 25.
  // With ≥34 rows, page 2 has ≥9 rows. The URL must reflect ?page=2.
  await Promise.all([
    page.waitForURL(/\/sistem\/audit\?(.*&)?page=2/, { timeout: 10_000 }),
    page.locator('[data-testid="audit-pager-next"]').click(),
  ]);
  const page2Count = await page.locator('[data-testid="audit-row"]').count();
  expect(page2Count).toBeGreaterThan(0);
  expect(page2Count).toBeLessThanOrEqual(25);
  // Previous link visible on page 2.
  await expect(page.locator('[data-testid="audit-pager-prev"]')).toBeVisible();

  // Pager preserves active filter when navigating. Visiting page 1 with
  // a filter and clicking next must keep the filter in the URL.
  await page.goto('/sistem/audit?action=audit.bulk_filler');
  // 30 filler rows → page 1 shows 25, page 2 shows 5, "Daha Fazla"
  // visible on page 1.
  await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(25);
  await expect(page.locator('[data-testid="audit-pager-next"]')).toBeVisible();
  await Promise.all([
    page.waitForURL(
      /\/sistem\/audit\?action=audit\.bulk_filler.*page=2/,
      { timeout: 10_000 },
    ),
    page.locator('[data-testid="audit-pager-next"]').click(),
  ]);
  await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(5);
  // All page-2 rows are still bulk_filler — filter was preserved.
  const page2Actions = await page
    .locator('[data-testid="audit-row"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-action')));
  for (const a of page2Actions) {
    expect(a).toBe('audit.bulk_filler');
  }
});
