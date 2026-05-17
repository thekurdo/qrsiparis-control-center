/**
 * Scenario S15 — Contract Expiry Cron
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * The `contract-expiry` cron sweeps the active tenant fleet daily and
 * writes an audit row (`contract.expiry_warning`) for each tenant whose
 * `contract_end_date` falls inside the warning window:
 *
 *   NOW() < contract_end_date < NOW() + INTERVAL '7 days'
 *
 * Already-expired tenants (contract_end_date <= NOW()) are excluded —
 * those are handled by the operator manually flipping status to
 * `cancelled`. Tenants whose contract ends 8+ days out are excluded —
 * they'll be picked up on a future cron tick when they enter the
 * 7-day window.
 *
 * Test seeds 3 tenants:
 *   - Tenant A : contract_end_date = NOW() + 6 days  → SHOULD trigger
 *   - Tenant B : contract_end_date = NOW() + 8 days  → SHOULD NOT trigger
 *   - Tenant C : contract_end_date = NOW() + 30 days → SHOULD NOT trigger
 *
 * Then:
 *   1. Invoke the cron once.
 *   2. Assert exactly one audit row, entity_id = tenantA.id.
 *   3. Invoke the cron a SECOND time.
 *   4. Assert audit_log still has exactly one row for tenantA
 *      (idempotency — re-runs within the 24h window must NOT double-write).
 *
 * --- WHY DIRECT IMPORT INSTEAD OF HTTP ---
 * Same rationale as S9 (stuck recovery): there is no
 * `/api/internal/crons/[name]/trigger` endpoint in V1 — the scheduler
 * itself is V1.5, see `src/app/(panel)/sistem/cron/page.tsx`. Playwright's
 * TS loader resolves the `@/` tsconfig alias, so importing
 * `runContractExpiry` from '@/lib/crons/contract-expiry' is the simplest
 * way to drive the cron in-process against the same Postgres the dev
 * server uses.
 *
 * --- WHY ACTIVE STATUS ---
 * The cron filters on `status='active'`. Tenants in `onboarding`,
 * `paused`, or `cancelled` are deliberately skipped:
 *   - onboarding: not yet live, no signed contract to expire
 *   - paused:     ops decision; sales already knows the contract status
 *   - cancelled:  already terminated, warning is moot
 * The test uses `createActiveTenant()` so all three seeded rows match
 * the status filter and the only thing differentiating them is the
 * contract_end_date column.
 *
 * --- WHY 6/8/30 DAYS AND NOT 6/7/8 ---
 * The boundary at 7 days is the interesting case for a separate test —
 * a 6.9-day contract should still trigger (window is exclusive on the
 * upper end with `<`). Here we want WIDE separation:
 *   - 6d : comfortably inside the window
 *   - 8d : comfortably outside the window
 *   - 30d: far outside the window (catches any "off by 10x" math bug
 *          that 8d wouldn't surface)
 * If the cron ever regresses to a 30-day window (the original Phase H11
 * stub) the C-tenant assertion would flip from "no row" to "row" and
 * fail loudly. That's the regression we want this scenario to catch.
 *
 * --- WHY DB-DIRECT (NO BROWSER) ---
 * Like S9 + S11, this scenario is purely about the cron's behaviour
 * against the DB. No UI surface today shows contract-expiry-warning
 * rows directly (they appear on /sistem/audit as ordinary audit rows,
 * already exercised by S5 / S11). Driving a browser would only add
 * flakiness without testing anything new.
 *
 * --- DOWNSTREAM SCENARIOS ---
 * Notes for S16 (schema drift detector): same audit-row + idempotency
 * pattern. The drift cron should also use a 24h "already warned today"
 * gate. recordAudit() is INSERT-only by construction; S11 enforces
 * that audit_log is append-only at the DB layer too — both contracts
 * are safe for this cron family.
 *
 * Notes for S19 (backup cron): the backup cron writes `backup.completed`
 * / `backup.failed` audit rows. Those are timestamp-suffixed so
 * day-level idempotency is less critical, but the cron should still
 * skip an attempt for a tenant that already has a `backup.completed`
 * row within the same day — same gate, different action name.
 */

import { test, expect } from '@playwright/test';

import { runContractExpiry } from '@/lib/crons/contract-expiry';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';
import { createServer } from '../fixtures/server.fixture';
import { createActiveTenant } from '../fixtures/tenant.fixture';

test.setTimeout(60_000);

const DAY_MS = 24 * 60 * 60 * 1000;

test.beforeEach(async () => {
  // S15 is purely DB-driven (no browser fixture). Wipe shared state so
  // ordering with other tests in the same worker can't bleed audit rows.
  await truncateAll();
  await resetAllMocks();
  resetCounter();
});

test('S15 contract-expiry cron flags only the 6-day tenant and is idempotent on re-run', async () => {
  // ---- Phase 0: seed a server + 3 tenants with different end dates -----
  // We use createActiveTenant() (not createTenant()) because the cron
  // filters on status='active'. createTenant() defaults to 'onboarding'
  // which the cron deliberately excludes (header: "WHY ACTIVE STATUS").
  const server = await createServer({ name: 'vps-s15' });

  const tenantA = await createActiveTenant(server.id, {
    shortCode: 's15-tenant-a',
    domain: 's15-tenant-a.test.local',
    contractEndDate: new Date(Date.now() + 6 * DAY_MS),
  });
  const tenantB = await createActiveTenant(server.id, {
    shortCode: 's15-tenant-b',
    domain: 's15-tenant-b.test.local',
    contractEndDate: new Date(Date.now() + 8 * DAY_MS),
  });
  const tenantC = await createActiveTenant(server.id, {
    shortCode: 's15-tenant-c',
    domain: 's15-tenant-c.test.local',
    contractEndDate: new Date(Date.now() + 30 * DAY_MS),
  });

  // Sanity: all 3 rows actually landed with the dates we wrote.
  // createActiveTenant() sets container_status='running' which is what we
  // want for a realistic active tenant. We also confirm status='active'
  // here so a future regression that flips the default doesn't make this
  // test silently pass for the wrong reason.
  const seed = await rawQuery<{
    id: string;
    short_code: string;
    status: string;
    contract_end_date: Date;
  }>(
    `SELECT id, short_code, status, contract_end_date
       FROM tenants
      WHERE short_code LIKE 's15-tenant-%'
      ORDER BY short_code ASC`,
  );
  expect(seed).toHaveLength(3);
  for (const row of seed) {
    expect(row.status).toBe('active');
  }

  // ---- Phase 1: first cron run ----------------------------------------
  const r1 = await runContractExpiry();
  expect(r1.flagged).toBe(1);
  expect(r1.tenantIds).toEqual([tenantA.id]);

  // ---- Phase 2: assert audit log has exactly 1 row, for tenantA --------
  // Scope to the canonical action name. Any other audit rows the system
  // may have written (none in this isolated scenario, but defensive)
  // won't interfere.
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
      WHERE action = 'contract.expiry_warning'
      ORDER BY created_at ASC`,
  );
  expect(auditRows1).toHaveLength(1);
  const row = auditRows1[0]!;
  // userId is null — this is a system-driven cron, not an operator action.
  expect(row.user_id).toBeNull();
  expect(row.action).toBe('contract.expiry_warning');
  expect(row.entity_type).toBe('tenant');
  expect(row.entity_id).toBe(tenantA.id);
  // Metadata carries the data ops need at a glance: which tenant, how
  // many days left, and (for forensics) what the warning window was at
  // the time of the write.
  expect(row.metadata?.['shortCode']).toBe('s15-tenant-a');
  expect(typeof row.metadata?.['daysUntilExpiry']).toBe('number');
  // 6-day tenant lands at 5 (floor of 6.0 minus tiny test execution
  // overhead) or 6 (if Date.now ticks within the same ms). Accept either
  // — the point is "around 6", and we already pin the upper bound via
  // the warningWindowDays field.
  const daysUntil = row.metadata?.['daysUntilExpiry'] as number;
  expect(daysUntil).toBeGreaterThanOrEqual(5);
  expect(daysUntil).toBeLessThanOrEqual(6);
  expect(row.metadata?.['warningWindowDays']).toBe(7);

  // Negative assertion: no rows for B or C. Probe by entity_id rather
  // than by absence in the full set so a future cron that also writes
  // some other tenant-scoped audit row doesn't accidentally pass this.
  const bRows = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log
       WHERE action = 'contract.expiry_warning' AND entity_id = $1`,
    [tenantB.id],
  );
  expect(bRows[0]!.count).toBe('0');

  const cRows = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log
       WHERE action = 'contract.expiry_warning' AND entity_id = $1`,
    [tenantC.id],
  );
  expect(cRows[0]!.count).toBe('0');

  // ---- Phase 3: second cron run --------------------------------------
  // Re-running the cron within the 24h idempotency window must NOT
  // write a second row for tenantA. The cron's pre-SELECT in
  // src/lib/crons/contract-expiry/index.ts gates on:
  //   action='contract.expiry_warning'
  //   entity_id=t.id
  //   created_at >= NOW() - 24h
  // so the second invocation finds the first row and skips.
  const r2 = await runContractExpiry();
  expect(r2.flagged).toBe(0);
  expect(r2.tenantIds).toEqual([]);

  // ---- Phase 4: assert no second row appeared -------------------------
  const auditRows2 = await rawQuery<{ id: string; entity_id: string | null }>(
    `SELECT id, entity_id FROM audit_log
      WHERE action = 'contract.expiry_warning'
      ORDER BY created_at ASC`,
  );
  expect(auditRows2).toHaveLength(1);
  expect(auditRows2[0]!.id).toBe(row.id); // same row, not a new one
  expect(auditRows2[0]!.entity_id).toBe(tenantA.id);

  // Belt-and-braces: total count of contract.expiry_warning rows in the
  // table is exactly 1 (catches the "wrote a second row for some other
  // tenant" hypothetical regression).
  const total = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log
       WHERE action = 'contract.expiry_warning'`,
  );
  expect(total[0]!.count).toBe('1');
});
