/**
 * Deployment pipeline framework (Phase H6).
 *
 * Defines the contract every deploy pipeline (initial / config_update /
 * app_update / redeploy / rollback) plugs into:
 *
 *   1. `PipelineStep` — a named pair of `forward` + `rollback` functions.
 *      Steps MUST be idempotent so a retried deployment doesn't double-write.
 *   2. `PipelineContext` — the per-run blob passed to every step. Carries
 *      the loaded tenant + server + deployment rows, mutable scratch space
 *      (e.g. `coolifyUuid` once Coolify creates the app), and a `log()`
 *      helper that fans out to console + Redis pub/sub + DB.
 *   3. `runPipeline(steps, ctx)` — the orchestrator. Walks the steps in
 *      order, awaiting each forward(); on failure, replays `rollback()` for
 *      each completed step in reverse order (Doc 18 §5).
 *
 * Error propagation:
 *   - Steps throw `PipelineError(code, message, meta)` to mark a typed
 *     failure (codes mirror Doc 18 §17). Anything else still aborts but
 *     gets logged with `code='UNKNOWN_ERROR'` upstream in the runner.
 *   - We rethrow the original error after rollback so the runner can write
 *     `error_code` / `error_message` onto the deployment row.
 *
 * Why a closed `ERROR_CODES` map: Doc 18 §17 lists the canonical set and
 * the ops dashboard / docs reference these strings. Drift here breaks
 * the operator UX. Adding a code is deliberate — update Doc 18 and this
 * map together.
 *
 * Concurrency note: a single PipelineContext is owned by exactly one
 * BullMQ job. The runner does not allow parallel steps; if Phase H7+ ever
 * needs parallelism inside a step it can spawn promises internally.
 */

import type { CoolifyClient } from '@/lib/coolify';
import type { Deployment, Server, Tenant } from '@/types/db';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-run mutable bag of state. Loaded once at the top of `executeDeployment`
 * and threaded through every step. Optional fields are filled in as steps
 * progress (e.g. `coolifyUuid` becomes available after step 03 succeeds).
 */
export interface PipelineContext {
  deployment: Deployment;
  tenant: Tenant;
  server: Server;
  /** Coolify API client — points to real Coolify in prod, WireMock in dev/E2E. */
  coolifyClient: CoolifyClient;
  /** App image tag pulled in step 04, e.g. `qrsiparis-app:1.4.2`. */
  appVersion?: string;
  /** Coolify application UUID — stamped after step 03. */
  coolifyUuid?: string;
  /** Container name as seen by Docker — derived from short_code in step 02. */
  containerName?: string;
  /**
   * Coolify deployment UUID — stamped after step 06 (CONTAINER_START) issues
   * the `/deploy` call, used by step 07 (HEALTH_CHECK) for polling.
   */
  coolifyDeploymentUuid?: string;
  /** Env vars to be injected into the container; built up in step 02 (CONFIG_GENERATE). */
  envVars?: Record<string, string>;
  /** Wall-clock seconds the pipeline has consumed; final value written by runner. */
  durationSeconds?: number;
  /**
   * Append a structured log line. Writes to:
   *   1. Process stdout (Docker captures this)
   *   2. In-memory buffer (drained to deployments.log via flushLogs())
   *   3. Redis pub/sub channel `deployment:{id}:log` for SSE consumers
   *
   * Treat as fire-and-forget — never `await` from inside hot loops.
   */
  log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    meta?: Record<string, unknown>,
  ): void;
  /**
   * Drain the in-memory log buffer into the `deployments.log` column.
   * Called by `runPipeline()` at the success/failure boundary so the log
   * column always reflects the final state without per-line DB churn.
   */
  flushLogs(): Promise<void>;
}

/**
 * One unit of work inside a pipeline. Both `forward` and `rollback` MUST
 * be idempotent: a retried deploy must not double-create resources, and
 * a rollback for a step whose forward never finished must be a noop.
 *
 * Convention: `name` is UPPER_SNAKE_CASE matching Doc 18 §4 step labels
 * (PRECHECK, CONFIG_GENERATE, COOLIFY_APP_CREATE, ...). The runner emits
 * structured log lines `step.start <NAME>` / `step.done <NAME>` so the SSE
 * consumer can render progress chips.
 */
export interface PipelineStep {
  name: string;
  forward: (ctx: PipelineContext) => Promise<void>;
  rollback: (ctx: PipelineContext) => Promise<void>;
}

/**
 * Typed failure raised by pipeline steps. The `code` is persisted to
 * `deployments.error_code` (open text column — see schema.ts §4) and
 * surfaced to operators on the deployment-detail UI.
 *
 * `meta` is free-form: include enough context to debug without leaking
 * secrets (no SSH keys, no Coolify tokens, no PII).
 */
export class PipelineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PipelineError';
    // Restore prototype chain so `instanceof PipelineError` works after
    // the super() call (TS / ES5 quirk).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Canonical pipeline error codes (Doc 18 §17). Adding a new code is a
 * deliberate change — update Doc 18 in lockstep.
 */
export const ERROR_CODES = {
  // — pre-flight —
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  TENANT_CANCELLED: 'TENANT_CANCELLED',
  NO_SERVER: 'NO_SERVER',
  SERVER_UNHEALTHY: 'SERVER_UNHEALTHY',
  SERVER_NOT_ACTIVE: 'SERVER_NOT_ACTIVE',
  SERVER_FULL: 'SERVER_FULL',
  // — config —
  CONFIG_INVALID: 'CONFIG_INVALID',
  // — image / container —
  DOCKER_PULL_FAILED: 'DOCKER_PULL_FAILED',
  IMAGE_NOT_FOUND: 'IMAGE_NOT_FOUND',
  CONTAINER_START_FAILED: 'CONTAINER_START_FAILED',
  CONTAINER_START_TIMEOUT: 'CONTAINER_START_TIMEOUT',
  CONTAINER_NOT_RUNNING: 'CONTAINER_NOT_RUNNING',
  // — health / domain —
  HEALTH_CHECK_FAILED: 'HEALTH_CHECK_FAILED',
  SSL_TIMEOUT: 'SSL_TIMEOUT',
  LANDING_UNREACHABLE: 'LANDING_UNREACHABLE',
  ADMIN_UNREACHABLE: 'ADMIN_UNREACHABLE',
  // — generic transport —
  API_ERROR: 'API_ERROR',
} as const;

export type PipelineErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Summary of what `runPipeline()` accomplished before a failure.
 *
 * Attached to the thrown `PipelineError` via `(err as any).rollbackSummary`
 * so the higher-level runner can record `deployment.rollback_completed`
 * audit rows + drive UI affordances without re-parsing the log column.
 *
 * `failedStep` is the name of the forward step that raised; `rolledBackSteps`
 * is the ordered list of completed steps whose `rollback()` was invoked
 * (in reverse-execution order). A rollback whose cleanup threw is still
 * listed here — failure surfaces as a `rollback.failed <NAME>` log line.
 */
export interface PipelineRollbackSummary {
  failedStep: string | null;
  rolledBackSteps: string[];
}

/**
 * Walk the supplied steps in order. On failure, replay rollback() in
 * reverse for every step whose forward() completed.
 *
 * Behaviour contract:
 *   - The runner does NOT swallow errors — it rethrows after rollback so
 *     the BullMQ job is marked failed and the higher-level runner stamps
 *     `deployments.error_code` / `error_message` on the row.
 *   - Rollback errors are logged at `warn` level but do not abort the
 *     remaining rollbacks. We always try every cleanup we know about.
 *   - On failure the thrown error is annotated with a `rollbackSummary`
 *     property (typed as {@link PipelineRollbackSummary}) so callers can
 *     write follow-up audit rows / metrics without re-parsing the log.
 *   - Logs are flushed at both the success and failure boundary.
 */
export async function runPipeline(
  steps: PipelineStep[],
  ctx: PipelineContext,
): Promise<void> {
  const completed: PipelineStep[] = [];
  let failedStep: string | null = null;
  try {
    for (const step of steps) {
      ctx.log('info', `step.start ${step.name}`);
      try {
        await step.forward(ctx);
      } catch (e) {
        // Capture which forward step blew up. We rethrow into the outer
        // catch so the rollback loop runs uniformly.
        failedStep = step.name;
        throw e;
      }
      completed.push(step);
      ctx.log('info', `step.done ${step.name}`);
    }
    await ctx.flushLogs();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof PipelineError ? err.code : 'UNKNOWN_ERROR';
    ctx.log('error', `step.failed ${message}`, { code });

    // Rollback in reverse over a COPY — `Array.prototype.reverse()` mutates
    // in place and we don't want to leave `completed` in a flipped state.
    const rollbackOrder = [...completed].reverse();
    const rolledBackSteps: string[] = [];
    for (const step of rollbackOrder) {
      ctx.log('info', `rollback.start ${step.name}`);
      try {
        await step.rollback(ctx);
        ctx.log('info', `rollback.done ${step.name}`);
      } catch (rbErr) {
        const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
        ctx.log('warn', `rollback.failed ${step.name}`, { error: rbMsg });
        // Intentionally swallow — a failing cleanup must not block
        // the remaining cleanups.
      }
      rolledBackSteps.push(step.name);
    }
    ctx.log('info', `rollback.complete steps=${rolledBackSteps.length}`);

    // Annotate the thrown error so the runner can pick the summary out
    // of the catch without re-parsing the log column. We define the
    // property non-enumerable so it doesn't leak into JSON-stringify
    // contexts (Sentry, audit metadata) by surprise.
    const summary: PipelineRollbackSummary = {
      failedStep,
      rolledBackSteps,
    };
    if (err instanceof Error) {
      Object.defineProperty(err, 'rollbackSummary', {
        value: summary,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }

    await ctx.flushLogs();
    throw err;
  }
}

/**
 * Helper for runner code that catches an error from `runPipeline()` and
 * wants the rollback summary if present. Returns `null` for errors thrown
 * from anywhere outside the pipeline (e.g. row-load failures).
 */
export function getRollbackSummary(
  err: unknown,
): PipelineRollbackSummary | null {
  if (
    err &&
    typeof err === 'object' &&
    'rollbackSummary' in err &&
    err.rollbackSummary &&
    typeof err.rollbackSummary === 'object'
  ) {
    return err.rollbackSummary as PipelineRollbackSummary;
  }
  return null;
}
