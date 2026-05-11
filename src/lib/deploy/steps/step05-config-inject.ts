/**
 * Step 05 — CONFIG_INJECT (Phase H6 STUB).
 *
 * Real implementation (Phase H7):
 *   - SSH into the server.
 *   - `mkdir -p /var/lib/docker/volumes/{slug}-data/_data/config`.
 *   - Write `restaurant.config.json` (atomic via tmp + mv) with the
 *     RestaurantConfig generated in step02.
 *   - Write `0600` perms (root-only — the container runs as a non-root
 *     user but the volume is mounted read-only on the customer side).
 *
 * Idempotency: the file is overwritten on every retry. The atomic
 * tmp + mv pattern ensures partial writes never leave a half-config.
 *
 * Stub: log the would-be path and stamp `ctx.containerName` so step06
 * can pretend to start the container.
 */

import type { PipelineStep } from '../pipeline';

export const step05ConfigInject: PipelineStep = {
  name: 'CONFIG_INJECT',
  async forward(ctx) {
    const slug = ctx.tenant.shortCode;
    const path = `/var/lib/docker/volumes/${slug}-data/_data/config/restaurant.config.json`;

    ctx.log('info', `STUB: SSH writeFile ${path}`);
    ctx.log(
      'info',
      `STUB: would inject configVersion=${ctx.tenant.configVersion} for tenant=${ctx.tenant.id}`,
    );

    // Stamp the container name for downstream steps.
    ctx.containerName = `${slug}-app`;
    ctx.log('info', `CONFIG_INJECT: containerName=${ctx.containerName}`);
  },
  async rollback(ctx) {
    if (!ctx.containerName) return;
    ctx.log(
      'warn',
      `STUB: would SSH rm /var/lib/docker/volumes/${ctx.tenant.shortCode}-data/_data/config/restaurant.config.json`,
    );
  },
};
