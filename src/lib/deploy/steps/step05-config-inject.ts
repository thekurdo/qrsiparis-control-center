/**
 * Step 05 — CONFIG_INJECT.
 *
 * Forward: drop the tenant's `restaurant.config.json` onto the persistent
 * `/data/config/` volume that step03 attached. Concretely:
 *
 *   1. Decrypt `servers.ssh_private_key_encrypted` (AES-GCM).
 *   2. SSH into `server.publicIp:server.sshPort` as `server.sshUser`.
 *   3. Serialize `ctx.tenant.configSnapshot` AS-IS to JSON. V1 trusts the
 *      snapshot — the customer-product validated it on save. (V1.5 will
 *      Zod-validate here with the cross-repo schema package.)
 *   4. Base64-encode + `base64 -d > /tmp/tenant-{short}-config.json` so we
 *      don't have to worry about shell-escaping the JSON. Atomic.
 *   5. Look up the Coolify-created container name via
 *      `docker ps --filter name={coolifyUuid} --format {{.Names}}` and
 *      pick the first match. Coolify names containers
 *      `{coolifyUuid}-{timestamp}`, so a substring filter is the safest
 *      lookup that survives Coolify's redeploy churn.
 *   6. `docker exec` to mkdir -p `/data/config`, `docker cp` the tmp file
 *      to `{container}:/data/config/restaurant.config.json`, then
 *      `docker exec` to chown to 1001:1001 (the Next.js standalone
 *      runtime user inside the image).
 *   7. Best-effort delete the tmp file. Failure here is non-fatal —
 *      `/tmp` gets reaped on reboot anyway.
 *
 * If `ctx.tenant.configSnapshot` is null we throw `CONFIG_INVALID` up
 * front (mirrors step02's gate, but step02 might be skipped on some
 * pipelines so we re-check here).
 *
 * Idempotency: overwriting the same path is naturally idempotent. The
 * mkdir -p / chown calls are idempotent at the docker exec level. A
 * retried pipeline just writes the same bytes again.
 *
 * Rollback: best-effort `rm -f /tmp/...json` on the host — the in-container
 * config file is left in place (step06 / step10 deal with container
 * teardown, and re-running step05 is the normal recovery path).
 *
 * Container-name discovery rationale: we explicitly don't trust
 * `ctx.containerName` here because step03 only stamps the *logical* name
 * (`rest-{shortCode}`) while Coolify's actual docker container name is
 * `{coolifyUuid}-{ts}`. The Docker-side lookup is the source of truth.
 *
 * --- WHY BASE64 INSTEAD OF HEREDOC ---
 * A heredoc has to escape any embedded `$` / backticks / quotes in the
 * JSON; the tenant configSnapshot is operator-controlled jsonb and can
 * contain anything (menu names with apostrophes, prices with $, etc).
 * Pipe-decoded base64 is fully opaque to bash and produces a byte-perfect
 * file. Plus, it's idiomatic on every Linux distro qrSiparis runs on.
 *
 * --- WHY SKIP DECRYPT IN MOCK MODE ---
 * Same rationale as `src/lib/crons/daily-backup/index.ts` and the
 * docker-stats route: tests seed `'fake-iv:fake-tag:fake-cipher'` into
 * `sshPrivateKeyEncrypted` and the mock SSH client ignores the key. Pass
 * an empty string and let the mock take over.
 */

import { decryptNullable } from '@/lib/crypto/aes-gcm';
import { getSshClient, type SshClient } from '@/lib/ssh';

import { ERROR_CODES, PipelineError, type PipelineStep } from '../pipeline';

const CONFIG_PATH_IN_CONTAINER = '/data/config/restaurant.config.json';
const CONTAINER_USER_UID = '1001';
const CONTAINER_USER_GID = '1001';

/**
 * Discover the Docker container name on the host for this tenant.
 * Coolify v4 names containers `{coolifyUuid}-{timestamp}` so we filter
 * on the UUID and take the first match (Coolify keeps exactly one
 * running container per app — redeploys swap atomically).
 *
 * Returns `null` if no container is found yet (e.g. step03's
 * `instant_deploy: true` hasn't finished pulling the image when step05
 * runs — step06 waits for `running:*` so this should be rare).
 */
async function findContainerName(
  ssh: SshClient,
  coolifyUuid: string,
): Promise<string | null> {
  const cmd = `docker ps --filter name=${coolifyUuid} --format '{{.Names}}'`;
  const res = await ssh.exec(cmd);
  if (res.exitCode !== 0) {
    throw new Error(
      `docker ps lookup failed (exit=${res.exitCode}): ${res.stderr.slice(0, 200)}`,
    );
  }
  const first = res.stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return first ?? null;
}

/**
 * Run an SSH command and throw if it exits non-zero. Keeps the call sites
 * readable — the step has ~5 of these and the exit-code check is the same
 * each time.
 */
async function execOrThrow(
  ssh: SshClient,
  command: string,
  label: string,
): Promise<string> {
  const res = await ssh.exec(command);
  if (res.exitCode !== 0) {
    throw new Error(
      `${label} failed (exit=${res.exitCode}): ${res.stderr.slice(0, 200) || res.stdout.slice(0, 200)}`,
    );
  }
  return res.stdout;
}

export const step05ConfigInject: PipelineStep = {
  name: 'CONFIG_INJECT',
  async forward(ctx) {
    if (!ctx.tenant.configSnapshot) {
      throw new PipelineError(
        ERROR_CODES.CONFIG_INVALID,
        'tenant.configSnapshot is empty — cannot inject restaurant.config.json',
      );
    }

    if (!ctx.coolifyUuid) {
      // Step03 should always stamp this. Treat as a programmer error.
      throw new PipelineError(
        ERROR_CODES.API_ERROR,
        'CONFIG_INJECT: ctx.coolifyUuid not set — step03 must run first',
      );
    }

    // V1 ships the snapshot AS-IS. V1.5 will Zod-validate against the
    // cross-repo customer-product schema package. JSON.stringify is safe
    // here — jsonb columns round-trip as plain JS objects/arrays.
    const configJson = JSON.stringify(ctx.tenant.configSnapshot);
    const configB64 = Buffer.from(configJson, 'utf-8').toString('base64');
    const tmpPath = `/tmp/tenant-${ctx.tenant.shortCode}-config.json`;

    // Decrypt SSH key (skip in mock mode — tests seed a placeholder blob).
    let privateKey = '';
    if (process.env['TEST_MODE'] !== 'mock') {
      try {
        privateKey = decryptNullable(ctx.server.sshPrivateKeyEncrypted) ?? '';
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'decrypt failed';
        throw new PipelineError(
          ERROR_CODES.API_ERROR,
          `CONFIG_INJECT: SSH key decrypt failed: ${msg}`,
        );
      }
      if (!privateKey) {
        throw new PipelineError(
          ERROR_CODES.API_ERROR,
          `CONFIG_INJECT: server ${ctx.server.id} has no SSH key configured`,
        );
      }
    }

    const ssh = getSshClient();
    try {
      await ssh.connect({
        host: ctx.server.publicIp,
        port: ctx.server.sshPort,
        username: ctx.server.sshUser,
        privateKey,
      });
      ctx.log('info', `CONFIG_INJECT: ssh ${ctx.server.sshUser}@${ctx.server.publicIp}:${ctx.server.sshPort}`);

      // 1. Write the base64-decoded JSON to a tmp file on the host.
      //    `printf '%s' "$b64" | base64 -d > tmp` is portable across
      //    coreutils on every Debian/Ubuntu host we run on.
      await execOrThrow(
        ssh,
        `printf '%s' '${configB64}' | base64 -d > ${tmpPath}`,
        'host tmp write',
      );
      ctx.log('info', `CONFIG_INJECT: wrote ${configJson.length} bytes to ${tmpPath} on host`);

      // 2. Find the actual container name (Coolify names it
      //    `{coolifyUuid}-{timestamp}`). Poll for up to 90s: step03's
      //    instant_deploy queues an async build/pull, so the container
      //    can take ~30-60s to appear in `docker ps`.
      let containerName: string | null = null;
      const containerWaitDeadlineMs = Date.now() + 90_000;
      while (Date.now() < containerWaitDeadlineMs) {
        containerName = await findContainerName(ssh, ctx.coolifyUuid);
        if (containerName) break;
        await new Promise((r) => setTimeout(r, 5_000));
      }
      if (!containerName) {
        throw new Error(
          `no running container matching coolifyUuid=${ctx.coolifyUuid} after 90s wait`,
        );
      }
      ctx.log('info', `CONFIG_INJECT: target container = ${containerName}`);
      // Update ctx so downstream steps (e.g. step06 if it re-resolves)
      // see the real Docker name. Stays a noop on the first pass since
      // step06 hasn't run yet at this point in the pipeline.
      ctx.containerName = containerName;

      // 3. Ensure /data/config exists inside the container, copy the file,
      //    then chown to the runtime user. The image runs as 1001:1001
      //    (Next.js standalone server user from the Dockerfile).
      // -u 0 (root) is required: the container's default user (nextjs / app,
      // UID 1001) can't `mkdir` outside its own home or chown files it
      // doesn't own. The mkdir and chown calls run as root; the docker cp
      // file inherits root ownership and then chown drops it to 1001:1001
      // so the runtime user (the app process) can read it.
      await execOrThrow(
        ssh,
        `docker exec -u 0 ${containerName} mkdir -p /data/config`,
        'docker exec mkdir',
      );
      await execOrThrow(
        ssh,
        `docker cp ${tmpPath} ${containerName}:${CONFIG_PATH_IN_CONTAINER}`,
        'docker cp',
      );
      await execOrThrow(
        ssh,
        `docker exec -u 0 ${containerName} chown ${CONTAINER_USER_UID}:${CONTAINER_USER_GID} ${CONFIG_PATH_IN_CONTAINER}`,
        'docker exec chown',
      );
      ctx.log(
        'info',
        `CONFIG_INJECT: injected configVersion=${ctx.tenant.configVersion} → ${containerName}:${CONFIG_PATH_IN_CONTAINER}`,
      );

      // 4. Best-effort delete the tmp file. Failures are non-fatal —
      //    /tmp is reaped on reboot and the next run overwrites it.
      const rmRes = await ssh.exec(`rm -f ${tmpPath}`);
      if (rmRes.exitCode !== 0) {
        ctx.log(
          'warn',
          `CONFIG_INJECT: tmp cleanup failed (non-fatal): ${rmRes.stderr.slice(0, 200)}`,
        );
      }

      // 5. Restart the container so the app re-reads the freshly-injected
      //    config on next boot. The app loads config eagerly at startup
      //    (`getConfig()` is called from server-only modules) so without a
      //    restart the new tenant's first requests would 500 with
      //    CONFIG_NOT_FOUND from the cached null-state.
      await execOrThrow(
        ssh,
        `docker restart ${containerName}`,
        'docker restart (post-inject)',
      );
      ctx.log('info', `CONFIG_INJECT: restarted ${containerName} so app reloads config`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Re-wrap into a PipelineError so the runner stamps a clean code.
      throw new PipelineError(
        ERROR_CODES.API_ERROR,
        `CONFIG_INJECT failed: ${msg}`,
      );
    } finally {
      try {
        await ssh.disconnect();
      } catch {
        /* already disconnected or never connected; ignore */
      }
    }
  },
  async rollback(ctx) {
    // The in-container file is left in place — re-running step05 is the
    // normal recovery path and overwriting is idempotent. We only try to
    // clean the host-side tmp file (best-effort, silent on failure).
    if (!ctx.server?.publicIp) return;
    const tmpPath = `/tmp/tenant-${ctx.tenant.shortCode}-config.json`;
    let privateKey = '';
    if (process.env['TEST_MODE'] !== 'mock') {
      try {
        privateKey = decryptNullable(ctx.server.sshPrivateKeyEncrypted) ?? '';
      } catch {
        ctx.log('warn', `CONFIG_INJECT rollback: skip (key decrypt failed)`);
        return;
      }
      if (!privateKey) return;
    }
    const ssh = getSshClient();
    try {
      await ssh.connect({
        host: ctx.server.publicIp,
        port: ctx.server.sshPort,
        username: ctx.server.sshUser,
        privateKey,
      });
      await ssh.exec(`rm -f ${tmpPath}`);
      ctx.log('info', `CONFIG_INJECT rollback: removed ${tmpPath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log('warn', `CONFIG_INJECT rollback: ssh cleanup failed (non-fatal): ${msg}`);
    } finally {
      try {
        await ssh.disconnect();
      } catch {
        /* ignore */
      }
    }
  },
};
