/**
 * HISTORY_SNAPSHOT — last step of every successful deployment pipeline
 * (initial / config_update / app_update / redeploy / rollback).
 *
 * Appends a row to `deployment_history` capturing the
 * (tenant, deploymentId, app_version, config_snapshot, config_version)
 * tuple after a deploy lands. The rollback pipeline reads these rows in
 * reverse-chronological order to find a target.
 *
 * Idempotency: we INSERT a new row each time. If the pipeline retries
 * step10 (this step's old position) and we end up double-inserting,
 * rollback just sees two snapshots of the same state — harmless. If
 * that ever becomes noisy, we can add a uniq constraint on
 * (tenantId, deploymentId).
 *
 * Failure semantics: snapshotting must NOT fail the deploy. If the
 * INSERT throws (e.g. DB connection blip), we log a warning and return
 * — the deploy itself still counts as success. Rollback may have one
 * fewer target to pick from, but the live system is correct.
 */

import { db } from '@/db/client';
import { deploymentHistory } from '@/db/schema';

import { type PipelineStep } from '../pipeline';

export const stepHistorySnapshot: PipelineStep = {
  name: 'HISTORY_SNAPSHOT',
  async forward(ctx) {
    if (!ctx.tenant.configSnapshot) {
      ctx.log(
        'warn',
        'HISTORY_SNAPSHOT: no configSnapshot to capture (skipping)',
      );
      return;
    }
    try {
      await db.insert(deploymentHistory).values({
        tenantId: ctx.tenant.id,
        deploymentId: ctx.deployment.id,
        appVersion: ctx.deployment.appVersion ?? 'unknown',
        configSnapshot: ctx.tenant.configSnapshot,
        configVersion: ctx.tenant.configVersion ?? 1,
        status: 'success',
      });
      ctx.log(
        'info',
        `HISTORY_SNAPSHOT: captured tenant=${ctx.tenant.shortCode} version=${ctx.tenant.configVersion} appVersion=${ctx.deployment.appVersion}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(
        'warn',
        `HISTORY_SNAPSHOT: insert failed (deploy still counts as success): ${msg}`,
      );
    }
  },
  async rollback(ctx) {
    ctx.log('info', 'HISTORY_SNAPSHOT rollback: noop (snapshots are append-only)');
  },
};
