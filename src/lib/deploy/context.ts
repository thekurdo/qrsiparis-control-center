/**
 * PipelineContext factory (Phase H6).
 *
 * Builds the per-run mutable bag of state that every pipeline step receives.
 * Logging fans out three ways:
 *
 *   1. **stdout** — `console.{info,warn,error}` so Docker / pino captures
 *      lines for centralised log aggregation.
 *   2. **In-memory buffer** — drained to `deployments.log` on flushLogs().
 *      We batch instead of writing per-line because each pipeline produces
 *      hundreds of lines and per-line UPDATE would saturate the connection
 *      pool. The `log` column is `text || delta` concatenation so multiple
 *      flushes don't trample one another.
 *   3. **Redis pub/sub** — channel `deployment:{id}:log`. The SSE handler
 *      (Phase H8) subscribes and streams new lines to operator browsers.
 *      We `void` the publish promise so a slow Redis doesn't block the
 *      pipeline; the pub/sub is best-effort, the DB row is the source
 *      of truth.
 *
 * Why not pino directly: we still want a single human-readable line per
 * log call (operators read the deployments.log column raw), and we don't
 * want a structured JSON envelope inflating every entry. The format here
 * matches the SSE consumer's expectations.
 */

import { eq, sql } from 'drizzle-orm';
import type IORedis from 'ioredis';

import { db } from '@/db/client';
import { deployments } from '@/db/schema';
import type { Deployment, Server, Tenant } from '@/types/db';

import type { PipelineContext } from './pipeline';

export interface CreatePipelineContextArgs {
  deployment: Deployment;
  tenant: Tenant;
  server: Server;
  redis: IORedis;
}

/**
 * Construct a PipelineContext for one pipeline run.
 *
 * The returned object owns:
 *   - A private `buffered: string[]` of log lines awaiting flush.
 *   - The Redis client (passed in — same connection used by the worker).
 *
 * Callers should call `flushLogs()` once at the success/failure boundary.
 * `runPipeline()` already does this, so direct callers rarely need to.
 */
export function createPipelineContext(
  args: CreatePipelineContextArgs,
): PipelineContext {
  const { deployment, tenant, server, redis } = args;
  const buffered: string[] = [];
  const channel = `deployment:${deployment.id}:log`;

  function formatLine(
    level: 'info' | 'warn' | 'error',
    msg: string,
    meta?: Record<string, unknown>,
  ): string {
    const ts = new Date().toISOString();
    const metaSuffix = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${ts}] [${level}] ${msg}${metaSuffix}`;
  }

  const ctx: PipelineContext = {
    deployment,
    tenant,
    server,
    log(level, msg, meta) {
      const line = formatLine(level, msg, meta);
      buffered.push(line);

      // Mirror to stdout so Docker / pino aggregator captures it.
      // We pick the right console method per level so log shippers can
      // filter properly without parsing the line.
      if (level === 'error') {
        // eslint-disable-next-line no-console
        console.error(line);
      } else if (level === 'warn') {
        // eslint-disable-next-line no-console
        console.warn(line);
      } else {
        // eslint-disable-next-line no-console
        console.info(line);
      }

      // Best-effort SSE fan-out. We deliberately don't await — a slow Redis
      // shouldn't block step execution, and any catch-up is fine because
      // the DB log column is the durable source of truth.
      void redis.publish(channel, line).catch((err: unknown) => {
        const m = err instanceof Error ? err.message : String(err);
        // Intentional console.warn — don't recurse via ctx.log().
        // eslint-disable-next-line no-console
        console.warn(`[deploy.ctx] redis publish failed channel=${channel} err=${m}`);
      });
    },
    async flushLogs() {
      if (buffered.length === 0) return;

      // Splice out the buffered lines so concurrent log() calls during the
      // DB roundtrip don't get lost or double-written.
      const concat = `${buffered.join('\n')}\n`;
      buffered.length = 0;

      try {
        await db
          .update(deployments)
          .set({
            // COALESCE handles the very first flush where log is still NULL.
            log: sql`COALESCE(${deployments.log}, '') || ${concat}`,
          })
          .where(eq(deployments.id, deployment.id));
      } catch (err) {
        // If the flush itself failed we don't want to crash the pipeline —
        // worst-case the in-memory log doesn't make it to the DB. Re-buffer
        // so a later flush can retry.
        buffered.unshift(concat.trimEnd());
        const m = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`[deploy.ctx] flushLogs failed deployment=${deployment.id} err=${m}`);
      }
    },
  };

  return ctx;
}
