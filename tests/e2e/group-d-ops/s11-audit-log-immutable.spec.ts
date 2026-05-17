/**
 * Scenario S11 — Audit Log Immutability
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * The `audit_log` table is append-only. The DB-level contract is:
 *
 *   - INSERT  : allowed (the whole point of an audit log)
 *   - UPDATE  : rejected by trigger `tr_audit_log_no_update` → SQLSTATE
 *               P0001 (RAISE EXCEPTION)
 *   - DELETE  : rejected by trigger `tr_audit_log_no_delete` → SQLSTATE
 *               P0001 (RAISE EXCEPTION)
 *
 * Both triggers route through the same plpgsql function
 * (`reject_audit_modify`) which raises with the message
 * "audit_log is append-only — UPDATE/DELETE rejected".
 *
 * --- WHY A DB TRIGGER INSTEAD OF AN APP-LAYER GUARD ---
 * KVKK gate + Doc 17 §11 require that operator action trails be
 * tamper-evident. A guard in `recordAudit()` would only protect the
 * production code path; an operator with raw DB credentials, an
 * exfiltrated `MASTER_KEY`, or even a buggy migration could still
 * rewrite history. Pushing the check into the DB closes that hole —
 * even `psql` from a logged-in admin cannot UPDATE or DELETE without
 * tripping the trigger.
 *
 * --- WHY THIS TEST GOES DB-DIRECT (NO BROWSER) ---
 * S5 already pins the read-only-UI contract on `/sistem/audit` (no
 * Sil / Düzenle buttons rendered, even for admins). S11's job is the
 * orthogonal DB-level invariant. Driving the trigger directly via
 * `rawQuery()` is the cleanest way to assert it — there's no UI path
 * that can reach UPDATE/DELETE today, so a browser test would be
 * proving the absence of something that doesn't exist.
 *
 * --- WHY S5 + S11 BOTH EXIST ---
 * Different layers, different failure modes:
 *   - S5 catches "someone added a Sil button to the audit page" — UI
 *     regression where the form renders but the DB would still reject.
 *   - S11 catches "someone wrote a DB migration that drops the
 *     trigger" — backend regression where the API would silently allow
 *     the modification.
 * Each test is the safety net for the failure mode the other can't see.
 *
 * --- TRUNCATE NOTE ---
 * BEFORE-FOR-EACH-ROW triggers do not fire on TRUNCATE (PG docs:
 * https://www.postgresql.org/docs/current/sql-createtrigger.html).
 * That's why `truncateAll()` in fixtures/db.ts can still wipe the
 * table between tests without tripping `reject_audit_modify`. We
 * deliberately do NOT cover TRUNCATE in this scenario — it is a
 * privileged DDL-adjacent operation only used by the test fixture.
 *
 * --- DOWNSTREAM SCENARIOS ---
 * Notes for S15/S16/S19 (cron-emitted audit rows — backup, contract
 * expiry, drift detector, deployment stuck recovery): those crons MUST
 * only INSERT into audit_log. Any attempt to UPDATE an existing audit
 * row (e.g. "mark this audit row as superseded") would crash the cron
 * with SQLSTATE P0001. The recordAudit() helper at src/lib/cc/audit.ts
 * is INSERT-only by construction, so the crons that use it are safe.
 */

import { test, expect } from '@playwright/test';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';

test.beforeEach(async () => {
  // Wipe shared mutable state. We do NOT use the auth fixture or hit
  // the dev server — this scenario is purely DB-driven (see header).
  await truncateAll();
  resetCounter();
});

test('S11 audit_log rejects UPDATE and DELETE at the DB layer; INSERT still works; immutability triggers are installed', async () => {
  // ---- Phase 0: confirm the immutability triggers are wired ------------
  // Fail fast with a clear message if the migration was rolled back.
  // We anchor to the *function* (reject_audit_modify) AND the two
  // trigger names so renaming either side of the contract surfaces here.
  const triggers = await rawQuery<{ tgname: string }>(
    `SELECT tgname
       FROM pg_trigger
      WHERE tgrelid = 'audit_log'::regclass
        AND NOT tgisinternal
      ORDER BY tgname`,
  );
  const triggerNames = triggers.map((t) => t.tgname);
  expect(triggerNames).toEqual(
    expect.arrayContaining([
      'tr_audit_log_no_update',
      'tr_audit_log_no_delete',
    ]),
  );

  // The plpgsql function that both triggers route through must also
  // exist. If a future migration drops the function but leaves the
  // triggers in place, INSERT would still work but UPDATE/DELETE would
  // fail with a misleading "function does not exist" error instead of
  // the canonical P0001. Catch that here.
  const fns = await rawQuery<{ proname: string }>(
    `SELECT proname FROM pg_proc WHERE proname = 'reject_audit_modify'`,
  );
  expect(fns).toHaveLength(1);

  // Fetch the seed admin id so the audit row's FK is valid. We could
  // also leave user_id NULL (the column allows it for system writes),
  // but pinning it to an existing operator more closely mirrors the
  // production recordAudit() call site for human actions.
  const adminRows = await rawQuery<{ id: string }>(
    `SELECT id FROM operator_users WHERE username = $1`,
    [ADMIN_USERNAME],
  );
  expect(adminRows).toHaveLength(1);
  const adminId = adminRows[0]!.id;

  // ---- Phase 1: INSERT a baseline audit row ----------------------------
  // Use a deliberately tag-y action name so this row is distinguishable
  // from anything else in the table for the duration of the test.
  const inserted = await rawQuery<{
    id: string;
    action: string;
    created_at: string;
  }>(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
     VALUES ($1, 's11.baseline', 'test', 's11-baseline-entity', $2::jsonb, $3, $4)
     RETURNING id, action, created_at`,
    [
      adminId,
      JSON.stringify({ note: 's11 baseline insert' }),
      'sha256-test-ip-hash',
      'sha256-test-ua-hash',
    ],
  );
  expect(inserted).toHaveLength(1);
  const baselineId = inserted[0]!.id;
  expect(inserted[0]!.action).toBe('s11.baseline');

  // ---- Phase 2: UPDATE must be rejected by tr_audit_log_no_update -----
  // The pg driver throws an Error with `.code === 'P0001'` for
  // RAISE EXCEPTION. We probe both the message (so a future trigger
  // refactor that swaps in a different SQLSTATE still gives us a
  // signal) AND the SQLSTATE code (so a future message reword can't
  // accidentally let a non-rejection slip through).
  const updatePromise = rawQuery(
    `UPDATE audit_log SET action = 'hacked' WHERE id = $1`,
    [baselineId],
  );
  await expect(updatePromise).rejects.toThrow(/audit_log is append-only/);
  try {
    await rawQuery(`UPDATE audit_log SET action = 'hacked-again' WHERE id = $1`, [
      baselineId,
    ]);
    throw new Error('expected UPDATE to throw but it succeeded');
  } catch (e) {
    const err = e as { code?: string; message?: string };
    expect(err.code).toBe('P0001');
    expect(err.message).toMatch(/audit_log is append-only/);
  }

  // Sanity: the row's `action` is still the original value (the trigger
  // fires BEFORE so the heap was never touched). This catches a
  // hypothetical regression where the trigger raises but the change
  // somehow persists (e.g. trigger declared AFTER UPDATE).
  const afterUpdate = await rawQuery<{ action: string }>(
    `SELECT action FROM audit_log WHERE id = $1`,
    [baselineId],
  );
  expect(afterUpdate).toHaveLength(1);
  expect(afterUpdate[0]!.action).toBe('s11.baseline');

  // ---- Phase 3: DELETE must be rejected by tr_audit_log_no_delete -----
  const deletePromise = rawQuery(`DELETE FROM audit_log WHERE id = $1`, [
    baselineId,
  ]);
  await expect(deletePromise).rejects.toThrow(/audit_log is append-only/);
  try {
    await rawQuery(`DELETE FROM audit_log WHERE id = $1`, [baselineId]);
    throw new Error('expected DELETE to throw but it succeeded');
  } catch (e) {
    const err = e as { code?: string; message?: string };
    expect(err.code).toBe('P0001');
    expect(err.message).toMatch(/audit_log is append-only/);
  }

  // Row still present after the failed deletes — BEFORE trigger
  // contract proven for the DELETE side too.
  const afterDelete = await rawQuery<{ id: string }>(
    `SELECT id FROM audit_log WHERE id = $1`,
    [baselineId],
  );
  expect(afterDelete).toHaveLength(1);

  // ---- Phase 4: INSERT still works after the rejected UPDATE/DELETE ---
  // A second row, distinct action tag. We also assert the count of
  // s11.* rows is exactly 2 so an over-zealous trigger that
  // accidentally blocked INSERTs as well (or rolled back the
  // transaction) would surface here.
  const second = await rawQuery<{ id: string; action: string }>(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
     VALUES ($1, 's11.second', 'test', 's11-second-entity', $2::jsonb, $3, $4)
     RETURNING id, action`,
    [
      adminId,
      JSON.stringify({ note: 's11 second insert after rejected mutations' }),
      'sha256-test-ip-hash',
      'sha256-test-ua-hash',
    ],
  );
  expect(second).toHaveLength(1);
  expect(second[0]!.action).toBe('s11.second');

  const s11Rows = await rawQuery<{ id: string; action: string }>(
    `SELECT id, action FROM audit_log WHERE action LIKE 's11.%' ORDER BY created_at ASC`,
  );
  expect(s11Rows).toHaveLength(2);
  expect(s11Rows[0]!.action).toBe('s11.baseline');
  expect(s11Rows[1]!.action).toBe('s11.second');

  // ---- Phase 5: bulk UPDATE / DELETE are also rejected -----------------
  // A trigger that uses FOR EACH ROW fires once per affected row. A
  // future regression to FOR EACH STATEMENT could let single-row
  // UPDATEs through but block multi-row ones (or vice-versa). Probe
  // both shapes so we catch either regression.
  const bulkUpdate = rawQuery(
    `UPDATE audit_log SET entity_id = 'hacked-bulk' WHERE action LIKE 's11.%'`,
  );
  await expect(bulkUpdate).rejects.toThrow(/audit_log is append-only/);

  const bulkDelete = rawQuery(
    `DELETE FROM audit_log WHERE action LIKE 's11.%'`,
  );
  await expect(bulkDelete).rejects.toThrow(/audit_log is append-only/);

  // Both s11 rows are still present and unmodified.
  const finalRows = await rawQuery<{ id: string; action: string; entity_id: string }>(
    `SELECT id, action, entity_id FROM audit_log
      WHERE action LIKE 's11.%' ORDER BY created_at ASC`,
  );
  expect(finalRows).toHaveLength(2);
  expect(finalRows[0]!.entity_id).toBe('s11-baseline-entity');
  expect(finalRows[1]!.entity_id).toBe('s11-second-entity');
});
