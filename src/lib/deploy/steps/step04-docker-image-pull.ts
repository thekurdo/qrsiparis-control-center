/**
 * Step 04 — DOCKER_IMAGE_PULL (Phase H6 STUB).
 *
 * Real implementation (Phase H7):
 *   - SSH into the tenant's server using `ssh2`.
 *   - `docker pull ghcr.io/{org}/qrsiparis-app:{appVersion}` and verify
 *     the digest matches an expected list (supply-chain check).
 *   - Throw `DOCKER_PULL_FAILED` / `IMAGE_NOT_FOUND` on any failure.
 *
 * Idempotency: docker pull is naturally idempotent. The real impl will
 * still short-circuit if `docker image inspect` shows the digest is
 * already present.
 *
 * Stub: log the would-be command and sleep 1s to mimic latency so SSE
 * consumers see realistic timing in dev.
 */

import type { PipelineStep } from '../pipeline';

export const step04DockerImagePull: PipelineStep = {
  name: 'DOCKER_IMAGE_PULL',
  async forward(ctx) {
    const tag = ctx.appVersion ?? ctx.deployment.appVersion ?? 'latest';
    const image = `ghcr.io/cyxares/qrsiparis-app:${tag}`;

    ctx.log('info', `STUB: SSH ${ctx.server.publicIp} -> docker pull ${image}`);

    // Mimic latency so dev SSE shows non-zero step durations.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    ctx.log('info', `DOCKER_IMAGE_PULL: stub completed for ${image}`);
  },
  async rollback(ctx) {
    // Pulled images are cheap to leave in place; the cron prune job (V1.5)
    // garbage-collects untagged images. No-op rollback.
    ctx.log('info', 'DOCKER_IMAGE_PULL rollback: noop (image cache preserved)');
  },
};
