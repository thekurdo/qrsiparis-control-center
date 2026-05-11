/**
 * Step 06 — CONTAINER_START (Phase H6 STUB).
 *
 * Real implementation (Phase H7):
 *   - Coolify HTTP API: POST /applications/{uuid}/deploy
 *   - Poll the deployment status endpoint every 2s up to 90s timeout.
 *   - Throw `CONTAINER_START_FAILED` / `CONTAINER_START_TIMEOUT` on
 *     non-success terminal states.
 *
 * Idempotency: Coolify's deploy endpoint is idempotent for the "already
 * running, no config drift" case (returns immediately). For drift, it
 * triggers a rolling restart, also idempotent.
 *
 * Stub: log the polling intent and pretend to wait.
 */

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

export const step06ContainerStart: PipelineStep = {
  name: 'CONTAINER_START',
  async forward(ctx) {
    if (!ctx.coolifyUuid) {
      throw new PipelineError(
        ERROR_CODES.CONTAINER_START_FAILED,
        'No coolifyUuid in context — step03 should have stamped it',
      );
    }

    ctx.log(
      'info',
      `STUB: Coolify deployApp(${ctx.coolifyUuid}) + poll status (timeout 90s)`,
    );
    ctx.log(
      'info',
      `STUB: container=${ctx.containerName ?? 'unknown'} starting on server=${ctx.server.id}`,
    );
  },
  async rollback(ctx) {
    if (!ctx.coolifyUuid) return;
    ctx.log('warn', `STUB: would Coolify stopApp(${ctx.coolifyUuid})`);
  },
};
