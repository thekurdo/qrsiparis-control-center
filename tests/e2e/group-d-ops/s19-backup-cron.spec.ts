/**
 * Scenario S19 — Daily Backup Cron
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * The `daily-backup` cron sweeps active tenants and:
 *   1. SSH-connects to the tenant's server (mock client in TEST_MODE=mock)
 *   2. Runs `pg_dump …` on the tenant container; mock dictionary in
 *      `src/lib/ssh/client-mock.ts` returns a canned `'-- mock dump (1
 *      row)\nCREATE TABLE demo (id int);\n'` for any `pg_dump`-prefixed
 *      command.
 *   3. Records an audit row per tenant:
 *        - `backup.completed` on a successful dump (this scenario's path)
 *        - `backup.failed`    on SSH connect/exec/decrypt failure
 *      Metadata: { tenantId, shortCode, filename, backupSize, serverId }
 *
 * 24h idempotency: re-running the cron within 24h must NOT write a
 * second `backup.completed` row for the same tenant. Mirrors S15
 * (contract-expiry) and S16 (schema-drift) — the gate is a pre-SELECT
 * against audit_log.
 *
 * Test seeds 2 active tenants on 1 server. Phases:
 *   1. Invoke `runDailyBackup` directly.
 *   2. Assert two `backup.completed` audit rows (one per tenant), each
 *      with the right metadata shape and a populated `backupSize`.
 *   3. Re-run; assert idempotency: still exactly 2 `backup.completed`
 *      rows, same ids as before.
 *   4. RETENTION sub-phase: pre-seed an audit row dated 31 days ago for
 *      tenant A with action='backup.completed'. After the cron runs,
 *      that row MUST still be present — audit_log is append-only by
 *      trigger (S11), so DELETE is impossible at the DB layer. The
 *      "purge" in the original spec is about backup FILES on disk,
 *      not audit rows. V1 has no `backups` table; the host-side
 *      `scripts/backup-all-tenants.sh` handles file retention via
 *      `find -mtime +30 -delete`. The cron itself is purge-free.
 *
 * --- WHY DIRECT IMPORT OF THE CRON ---
 * Same rationale as S9 / S15 / S16: there's no
 * `/api/internal/crons/[name]/trigger` endpoint in V1 — the scheduler
 * itself is V1.5 (see `src/app/(panel)/sistem/cron/page.tsx`).
 * Playwright's TS loader resolves the `@/` tsconfig alias, so importing
 * `runDailyBackup` from '@/lib/crons/daily-backup' is the simplest way
 * to drive the cron in-process against the same Postgres the dev server
 * uses.
 *
 * --- WHY TWO TENANTS ---
 * One tenant alone wouldn't catch a regression where the cron writes
 * audit rows with the WRONG entity_id (e.g. always tenant A's id even
 * for tenant B's backup). Two tenants give us:
 *   - Two distinct entity_ids to verify pairing
 *   - Two distinct shortCodes in metadata so the filename
 *     `tenant-{shortCode}-{YYYYMMDD}.sql` is independently checkable
 *
 * --- WHY ONE SERVER ---
 * The cron's SSH plumbing is per-tenant via tenant→server JOIN. A
 * second server would test "fleet-wide" iteration but not add coverage
 * over the per-tenant audit row contract, which IS what this scenario
 * pins. S3 already exercises the SSH-client/mock plumbing against
 * multiple servers via the docker-stats route.
 *
 * --- WHY DB-DIRECT (NO BROWSER) ---
 * Like S9 / S11 / S15, this scenario is purely about the cron's
 * behaviour against the DB. Backup audit rows render in /sistem/audit
 * as ordinary rows (already exercised by S5 / S11). No browser would
 * add coverage.
 *
 * --- WHY THE RETENTION SUB-PHASE IS A NEGATIVE-DELETE ASSERT ---
 * The plan spec asks "after cron runs, the >30d row should NOT be
 * deleted." Since audit_log immutability is a hard DB invariant (S11),
 * this is true ALWAYS, not just for the >30d case. We still seed the
 * row and assert its presence post-run because:
 *   (a) it documents the contract that "purge" applies to FILES, not
 *       audit rows, and a future regression that adds a delete to the
 *       cron module would either trip the S11 trigger (caught here)
 *       or be a misguided code path (also caught — the row count
 *       wouldn't match).
 *   (b) it confirms the cron doesn't filter on `created_at` in a way
 *       that ignores old rows for the idempotency gate. The 24h window
 *       intentionally excludes a 31-day-old row, so tenant A's first
 *       run THIS test STILL writes a fresh `backup.completed` row even
 *       though an old one exists. Without this assertion, a future
 *       regression that widens the idempotency window to "ever, not
 *       just 24h" would silently make this test pass but break the
 *       cron contract.
 *
 * --- TIMEOUT BUDGET ---
 * 60s: ~20ms × 2 tenants × 2 runs of mock SSH (~80ms) + DB writes +
 * truncate. Generous to absorb slow-machine first-compile of the
 * cron module via Playwright's TS loader.
 *
 * --- DOWNSTREAM SCENARIOS ---
 * Notes for S13 (lifecycle — pause/resume/cancel): the cron filters on
 * `status='active'`. Pausing or cancelling a tenant flips status away
 * from 'active', so the cron stops attempting backups organically —
 * no separate handler is needed in the lifecycle scenario. S13's
 * cancel test should NOT need to mock out the backup cron; the
 * status flip alone is sufficient. If S13 ever wants to assert "no
 * backup audit rows written after cancel", invoking `runDailyBackup`
 * post-cancel + asserting `result.attempted` excludes the cancelled
 * tenant is the contract.
 */

import { test, expect } from '@playwright/test';

import { runDailyBackup } from '@/lib/crons/daily-backup';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';
import { createServer } from '../fixtures/server.fixture';
import { createActiveTenant } from '../fixtures/tenant.fixture';

test.setTimeout(60_000);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mirror of the cron's filename helper so the test pins the exact same
 * YYYYMMDD UTC stamp the cron will emit. Re-implementing instead of
 * importing keeps the contract assertion explicit: if the cron changes
 * the filename pattern, this test should fail loudly, not adapt silently.
 */
function expectedFilename(shortCode: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `tenant-${shortCode}-${yyyy}${mm}${dd}.sql`;
}

test.beforeEach(async () => {
  // S19 is purely DB-driven (no browser fixture). Wipe shared state so
  // ordering with other tests in the same worker can't bleed audit rows.
  await truncateAll();
  await resetAllMocks();
  resetCounter();
});

test('S19 daily-backup cron writes backup.completed per active tenant, is idempotent on re-run, and does not delete older audit rows (S11 immutability)', async () => {
  // ---- Phase 0: seed a server + 2 active tenants -----------------------
  // createActiveTenant() sets status='active' and container_status='running',
  // which is exactly what the cron filters on. The fixture's
  // `'fake-iv:fake-tag:fake-cipher'` placeholder for sshPrivateKeyEncrypted
  // is fine because TEST_MODE=mock causes the cron to skip decryption
  // (mirrors S3's docker-stats route).
  const server = await createServer({
    name: 'vps-s19',
    publicIp: '10.19.0.1',
    publicHostname: 'vps-s19.test.local',
  });

  const tenantA = await createActiveTenant(server.id, {
    shortCode: 's19-tenant-a',
    domain: 's19-tenant-a.test.local',
  });
  const tenantB = await createActiveTenant(server.id, {
    shortCode: 's19-tenant-b',
    domain: 's19-tenant-b.test.local',
  });

  // Sanity-check the seed (active status + same server) before invoking
  // the cron. If a future fixture default changes status, this surfaces
  // here instead of as a confusing "0 audit rows" later.
  const seed = await rawQuery<{
    id: string;
    short_code: string;
    status: string;
    server_id_ref: string | null;
  }>(
    `SELECT id, short_code, status, server_id_ref
       FROM tenants
      WHERE short_code LIKE 's19-tenant-%'
      ORDER BY short_code ASC`,
  );
  expect(seed).toHaveLength(2);
  for (const row of seed) {
    expect(row.status).toBe('active');
    expect(row.server_id_ref).toBe(server.id);
  }

  // ---- Phase 0.5: seed an OLD audit row for the retention sub-phase ----
  // Action = 'backup.completed', created_at = NOW() - 31 days, tenant A.
  // This row is OUTSIDE the cron's 24h idempotency window, so tenant A
  // should STILL receive a fresh `backup.completed` row from the cron.
  // We assert this old row is present BOTH before AND after the cron
  // runs (audit_log is append-only — see S11 / trigger
  // `tr_audit_log_no_delete`).
  await rawQuery(
    `INSERT INTO audit_log (
       user_id, action, entity_type, entity_id, metadata,
       ip_address, user_agent, created_at
     ) VALUES (
       NULL, 'backup.completed', 'tenant', $1, $2::jsonb,
       'sha256-stub', 'sha256-stub', NOW() - INTERVAL '31 days'
     )`,
    [
      tenantA.id,
      JSON.stringify({
        tenantId: tenantA.id,
        shortCode: tenantA.shortCode,
        filename: 'tenant-s19-tenant-a-old.sql',
        backupSize: 1,
        serverId: server.id,
        note: 'pre-seeded retention row (31 days old)',
      }),
    ],
  );

  const oldRows = await rawQuery<{ id: string; created_at: Date }>(
    `SELECT id, created_at FROM audit_log
      WHERE action = 'backup.completed' AND entity_id = $1
        AND created_at < NOW() - INTERVAL '7 days'
      ORDER BY created_at ASC`,
    [tenantA.id],
  );
  expect(oldRows).toHaveLength(1);
  const oldRowId = oldRows[0]!.id;

  // ---- Phase 1: first cron run ---------------------------------------
  const r1 = await runDailyBackup();
  // 2 tenants attempted; both completed (mock returns canned pg_dump
  // output). 0 skipped (no recent completed row inside the 24h gate;
  // the pre-seeded one is 31 days old). 0 failed.
  expect(r1.attempted).toBe(2);
  expect(r1.completed).toBe(2);
  expect(r1.failed).toBe(0);
  expect(r1.skipped).toBe(0);

  // ---- Phase 2: audit row shape per tenant ---------------------------
  // We deliberately query only rows newer than 1 minute ago so the
  // 31-day-old seed row doesn't show up. The `>= NOW() - 1 minute`
  // bound also catches any clock-skew weirdness between the test
  // process and the DB without being so wide it's meaningless.
  const fresh = await rawQuery<{
    id: string;
    user_id: string | null;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    metadata: Record<string, unknown> | null;
    created_at: Date;
  }>(
    `SELECT id, user_id, action, entity_type, entity_id, metadata, created_at
       FROM audit_log
      WHERE action = 'backup.completed'
        AND created_at >= NOW() - INTERVAL '1 minute'
      ORDER BY entity_id ASC`,
  );
  expect(fresh).toHaveLength(2);

  // Both rows: system-driven (user_id NULL), entity_type='tenant',
  // metadata shape pinned. The order-by on entity_id matches the
  // tenant fixture's insert order indirectly (uuids aren't sortable
  // semantically, but the COUNT==2 + per-tenant lookup below is what
  // actually proves the pairing).
  for (const row of fresh) {
    expect(row.user_id).toBeNull();
    expect(row.action).toBe('backup.completed');
    expect(row.entity_type).toBe('tenant');
    // Metadata required fields:
    expect(typeof row.metadata?.['tenantId']).toBe('string');
    expect(typeof row.metadata?.['shortCode']).toBe('string');
    expect(typeof row.metadata?.['filename']).toBe('string');
    expect(typeof row.metadata?.['backupSize']).toBe('number');
    expect(typeof row.metadata?.['serverId']).toBe('string');
    expect(row.metadata?.['serverId']).toBe(server.id);
    // The mock dump is ~45 bytes of canned text. We assert > 0 rather
    // than == 45 because a future tweak to the mock string shouldn't
    // break this test; the contract is "backup size is captured and
    // positive", not "the exact mock byte count".
    expect(row.metadata?.['backupSize']).toBeGreaterThan(0);
  }

  // Per-tenant lookup: each tenant has its own row, with its own
  // shortCode and filename. We index by entity_id so the assertion
  // doesn't depend on uuid sort order.
  const byTenant = new Map(fresh.map((r) => [r.entity_id, r]));
  const rowA = byTenant.get(tenantA.id);
  const rowB = byTenant.get(tenantB.id);
  expect(rowA).toBeDefined();
  expect(rowB).toBeDefined();
  expect(rowA!.metadata?.['shortCode']).toBe('s19-tenant-a');
  expect(rowA!.metadata?.['tenantId']).toBe(tenantA.id);
  expect(rowA!.metadata?.['filename']).toBe(expectedFilename('s19-tenant-a'));
  expect(rowB!.metadata?.['shortCode']).toBe('s19-tenant-b');
  expect(rowB!.metadata?.['tenantId']).toBe(tenantB.id);
  expect(rowB!.metadata?.['filename']).toBe(expectedFilename('s19-tenant-b'));

  // No `backup.failed` rows in this happy path.
  const failedRows = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log
       WHERE action = 'backup.failed'`,
  );
  expect(failedRows[0]!.count).toBe('0');

  // ---- Phase 3: idempotency — re-run the cron ------------------------
  // Re-running within the 24h window must NOT write second
  // `backup.completed` rows. The cron's pre-SELECT gates on:
  //   action='backup.completed' AND entity_id=t.id
  //     AND created_at >= NOW() - 24h
  // so the second invocation finds the first run's row and skips
  // (returning ok:true + skipped:true rather than re-dumping).
  const r2 = await runDailyBackup();
  expect(r2.attempted).toBe(2);
  expect(r2.completed).toBe(0);
  expect(r2.failed).toBe(0);
  expect(r2.skipped).toBe(2);

  // No new rows for either tenant in the last minute beyond the two
  // already written in Phase 1.
  const fresh2 = await rawQuery<{ id: string; entity_id: string | null }>(
    `SELECT id, entity_id FROM audit_log
      WHERE action = 'backup.completed'
        AND created_at >= NOW() - INTERVAL '1 minute'
      ORDER BY entity_id ASC`,
  );
  expect(fresh2).toHaveLength(2);
  // Same ids as Phase 2 — no fresh inserts on the re-run.
  const freshIds1 = new Set(fresh.map((r) => r.id));
  const freshIds2 = new Set(fresh2.map((r) => r.id));
  expect(freshIds2).toEqual(freshIds1);

  // ---- Phase 4: retention — the 31-day-old row is STILL present -------
  // The cron does NOT purge old audit rows (audit_log is append-only by
  // trigger; S11 enforces this). The "purge" in the original spec is
  // about backup FILES on disk, handled by the host shell script
  // `scripts/backup-all-tenants.sh` (which uses `find -mtime +30
  // -delete`). V1 has no `backups` table, so there is nothing to
  // delete from inside the Node process. This assertion documents
  // that contract.
  const oldStill = await rawQuery<{ id: string; metadata: Record<string, unknown> | null }>(
    `SELECT id, metadata FROM audit_log WHERE id = $1`,
    [oldRowId],
  );
  expect(oldStill).toHaveLength(1);
  expect(oldStill[0]!.id).toBe(oldRowId);
  // The pre-seeded note must still be readable — the row was not
  // modified either (S11 also blocks UPDATE; this is a belt-and-braces
  // assertion that no part of the cron tries to "tag" old rows).
  expect(oldStill[0]!.metadata?.['note']).toBe(
    'pre-seeded retention row (31 days old)',
  );

  // Belt-and-braces: total `backup.completed` rows in the table is now
  // exactly 3 (2 fresh + 1 pre-seeded). Catches a regression where the
  // cron writes a SECOND row for tenant A despite the idempotency
  // gate, or where it accidentally drops the old row.
  const total = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log
       WHERE action = 'backup.completed'`,
  );
  expect(total[0]!.count).toBe('3');

  // ---- Phase 5: backup row ages — the OLD row is OUTSIDE the 24h gate
  // Sanity check: prove the 24h idempotency window did NOT cover the
  // pre-seeded row (which is what allowed tenant A to receive a fresh
  // `backup.completed` in Phase 1 alongside its old one). If a future
  // regression widens the window to "ever", this assertion still
  // passes (the old row is 31 days back, well outside any reasonable
  // window) but Phase 1's `completed === 2` would fail first — so this
  // is documentation, not a strictly load-bearing check.
  const withinDay = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log
       WHERE action = 'backup.completed' AND entity_id = $1
         AND created_at >= NOW() - INTERVAL '24 hours'`,
    [tenantA.id],
  );
  expect(withinDay[0]!.count).toBe('1'); // only the fresh row, not the old one

  const olderThanWeek = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log
       WHERE action = 'backup.completed' AND entity_id = $1
         AND created_at < NOW() - INTERVAL '7 days'`,
    [tenantA.id],
  );
  expect(olderThanWeek[0]!.count).toBe('1'); // only the pre-seeded row
});

test('S19 daily-backup cron skips inactive tenants (paused / cancelled / onboarding)', async () => {
  // Companion test for the status filter. A tenant in any non-'active'
  // status MUST NOT receive a backup attempt — pause and cancel imply
  // the container is stopped, and onboarding tenants have no DB yet.
  // This pins the cron's `where(eq(tenants.status, 'active'))` filter.
  //
  // We use `createTenant` (default status='onboarding') for the
  // onboarding case, and manually UPDATE status for paused/cancelled
  // because the active-tenant fixture only supports the 'active' status.
  const server = await createServer({
    name: 'vps-s19-filter',
    publicIp: '10.19.1.1',
    publicHostname: 'vps-s19-filter.test.local',
  });

  // Build one active + one of each non-active state via raw INSERT.
  // Helper-level: createTenant defaults to 'onboarding' (header comment
  // in tenant.fixture.ts), which is the natural starting status.
  const active = await createActiveTenant(server.id, {
    shortCode: 's19-filter-active',
    domain: 's19-filter-active.test.local',
  });

  // Onboarding (default status from createTenant — but we explicitly
  // call out the fixture's createTenant variant for clarity).
  await rawQuery(
    `INSERT INTO tenants (
       short_code, restaurant_name, contact_name, contact_phone, contact_email,
       city, tier, signed_at, contract_start_date, contract_end_date,
       monthly_fee_kurus, server_id_ref, domain, status, container_status
     ) VALUES ($1,'Onb','C','+90','o@x','Ist','baslangic',
               NOW(),NOW(),NOW()+INTERVAL '365 days',
               50000,$2,$3,'onboarding','not_deployed')`,
    [
      's19-filter-onb',
      server.id,
      's19-filter-onb.test.local',
    ],
  );

  await rawQuery(
    `INSERT INTO tenants (
       short_code, restaurant_name, contact_name, contact_phone, contact_email,
       city, tier, signed_at, contract_start_date, contract_end_date,
       monthly_fee_kurus, server_id_ref, domain, status, container_status
     ) VALUES ($1,'Paused','C','+90','p@x','Ist','baslangic',
               NOW(),NOW(),NOW()+INTERVAL '365 days',
               50000,$2,$3,'paused','stopped')`,
    [
      's19-filter-paused',
      server.id,
      's19-filter-paused.test.local',
    ],
  );

  await rawQuery(
    `INSERT INTO tenants (
       short_code, restaurant_name, contact_name, contact_phone, contact_email,
       city, tier, signed_at, contract_start_date, contract_end_date,
       monthly_fee_kurus, server_id_ref, domain, status, container_status
     ) VALUES ($1,'Cancel','C','+90','c@x','Ist','baslangic',
               NOW(),NOW(),NOW()+INTERVAL '365 days',
               50000,$2,$3,'cancelled','stopped')`,
    [
      's19-filter-cancelled',
      server.id,
      's19-filter-cancelled.test.local',
    ],
  );

  // 4 tenant rows total, 1 active.
  const counts = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM tenants WHERE short_code LIKE 's19-filter-%'`,
  );
  expect(counts[0]!.count).toBe('4');

  const r = await runDailyBackup();
  expect(r.attempted).toBe(1); // only the 'active' tenant
  expect(r.completed).toBe(1);
  expect(r.failed).toBe(0);
  expect(r.skipped).toBe(0);

  // Exactly one audit row written, for the active tenant only.
  const rows = await rawQuery<{ entity_id: string | null }>(
    `SELECT entity_id FROM audit_log
       WHERE action = 'backup.completed'
       ORDER BY created_at ASC`,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.entity_id).toBe(active.id);
});
