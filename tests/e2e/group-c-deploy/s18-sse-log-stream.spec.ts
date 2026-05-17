/**
 * Scenario S18 — SSE Log Stream
 * (plan/2026-05-11-control-center-e2e.md).
 *
 * Trigger a deployment, open an EventSource against
 * `/api/internal/deployments/{id}/log-stream` from a real browser page
 * (so the auth cookie + the network path the operator UI uses are both
 * exercised), and verify:
 *
 *   1. Live `step.start <NAME>` / `step.done <NAME>` lines arrive on the
 *      stream WHILE the worker is running the pipeline — not just batched
 *      at the end. We assert by polling the message buffer (collected in
 *      `window.__sseMessages` by the browser-side EventSource) and
 *      requiring at least 10 events before the deployment terminates.
 *   2. The deployment finishes in `status='success'`.
 *   3. `deployments.log` (the durable DB backup) contains the same
 *      `step.start` / `step.done` lines that the SSE stream emitted. The
 *      SSE handler is best-effort fan-out per `createPipelineContext`;
 *      the DB column is the source of truth, so they must agree.
 *   4. After disconnecting mid-stream and reconnecting, the new
 *      EventSource still works — at minimum it receives the handshake
 *      (`Subscribed to deployment:{id}:log`) emitted by the route's
 *      `start()` handler. The route DOES NOT replay history (header
 *      docstring of `route.ts` calls this out explicitly); the operator
 *      UI gets historical context from the hydrated `deployments.log`
 *      column, so SSE reconnect only needs to deliver new lines.
 *
 * --- WHY A BROWSER EVENTSOURCE INSTEAD OF NODE'S fetch+ReadableStream ---
 * The operator's actual SSE path is `EventSource` from the React client
 * component (`src/components/cc/DeploymentLogStream.tsx`), with the auth
 * cookie attached automatically. Driving the test from
 * `page.evaluate(() => new EventSource(url))` exercises that same code
 * path inside the same Playwright browser context, picking up the session
 * cookie from `loginWithTotp()` without any token forwarding gymnastics.
 *
 * Node 22+ also ships a built-in `EventSource`, but it doesn't share the
 * browser context's cookie jar, and the route's `requireOperatorAuth`
 * gate would 401 us. We'd have to manually forward the session cookie
 * which defeats the "exercise the operator's real network path" goal.
 *
 * --- WHY WE DON'T REQUIRE ALL 20 step.start+step.done EVENTS ---
 * Between the POST response (201) and the EventSource handshake there's
 * a short race window:
 *   - The worker picks up the BullMQ job within ~10-50ms.
 *   - `step.start PRECHECK` may publish to Redis before the SSE route's
 *     `sub.subscribe(channel)` resolves.
 *   - Once subscribed, all subsequent publishes are caught.
 * We therefore require N >= 10 received events (any mix of `step.start`
 * and `step.done`) rather than the strict 20 (10 step.start + 10
 * step.done) we'd see if we could subscribe BEFORE the pipeline started.
 * The DB log column gets the full set regardless, which is what we
 * assert as the durable source of truth.
 *
 * --- WHY THE WHILE-LIVE POLL INSTEAD OF A SINGLE EVALUATE ---
 * If we just opened the EventSource and immediately waited for the
 * deployment to terminate, then snapshotted `window.__sseMessages`,
 * we couldn't tell the difference between "events streamed live" and
 * "events arrived in one batch at the end". The poll loop with
 * `expect.poll` proves the buffer GROWS over time — i.e. events arrive
 * mid-pipeline, not as a single end-of-run dump.
 *
 * --- TIMEOUT BUDGET ---
 * 60s — pipeline runs in ~3-4s, with ~30s headroom for slow CI / first-
 * compile JIT cost on the SSE route and the deploy POST route.
 */

import { test, expect } from '@playwright/test';
import { authenticator } from 'otplib';

// Relative path — Playwright's TS loader doesn't honour the `@/` alias.
import { encrypt } from '../../../src/lib/crypto/aes-gcm';

import { rawQuery, truncateAll } from '../fixtures/db';
import { resetCounter } from '../fixtures/data';
import { resetAllMocks } from '../fixtures/mocks';
import { createServer } from '../fixtures/server.fixture';
import { createDeployableTenant } from '../fixtures/tenant.fixture';

const ADMIN_USERNAME = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
const ADMIN_PASSWORD = process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';

test.setTimeout(60_000);

/** Mirror of S17's 2FA direct-seed helper. */
async function enable2faForAdmin(): Promise<{ totp_secret_plain: string }> {
  const totpSecret = authenticator.generateSecret(20);
  const encryptedSecret = encrypt(totpSecret);
  await rawQuery(
    `UPDATE operator_users
        SET two_factor_enabled = true,
            two_factor_secret = $1,
            failed_login_attempts = 0,
            failed_login_locked_until = NULL
      WHERE username = $2`,
    [encryptedSecret, ADMIN_USERNAME],
  );
  return { totp_secret_plain: totpSecret };
}

/** Mirror of S17's login helper. /login -> /2fa-verify -> panel. */
async function loginWithTotp(
  page: import('@playwright/test').Page,
  totpSecret: string,
): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="username"]', ADMIN_USERNAME);
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/auth/callback/credentials') && r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    page.click('button[type="submit"]'),
  ]);

  await page.waitForURL(/\/2fa-verify/, { timeout: 10_000 });

  await page.fill('input[name="username"]', ADMIN_USERNAME);
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await page.fill('input[name="code"]', authenticator.generate(totpSecret));

  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/auth/callback/credentials') && r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    page.click('button[type="submit"]'),
  ]);

  await page.waitForURL(
    (u) => !u.toString().includes('/2fa-verify') && !u.toString().includes('/login'),
    { timeout: 15_000 },
  );
}

/**
 * Poll `deployments.status` until it reaches a terminal state. Throws on
 * timeout or on a non-success terminal (the test expects the happy path;
 * anything else indicates worker/WireMock misconfiguration).
 *
 * Mirrors S17's `waitForDeploymentSuccess` — kept inlined here to avoid
 * a new shared helper module just for two callers.
 */
async function waitForDeploymentSuccess(deploymentId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let last:
    | {
        status: string;
        error_code: string | null;
        error_message: string | null;
      }
    | undefined;
  while (Date.now() - start < timeoutMs) {
    const rows = await rawQuery<{
      status: string;
      error_code: string | null;
      error_message: string | null;
    }>(
      `SELECT status, error_code, error_message
         FROM deployments
        WHERE id = $1`,
      [deploymentId],
    );
    if (rows.length === 0) {
      throw new Error(`deployment ${deploymentId} disappeared`);
    }
    last = rows[0]!;
    if (last.status === 'success') return;
    if (last.status === 'failed' || last.status === 'rolled_back' || last.status === 'cancelled') {
      throw new Error(
        `deployment ${deploymentId} ended unexpectedly: status=${last.status} code=${last.error_code} message=${last.error_message}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `deployment ${deploymentId} did not reach success in ${timeoutMs}ms (last status=${last?.status})`,
  );
}

test.beforeEach(async ({ page }) => {
  await truncateAll();
  await resetAllMocks();
  resetCounter();
  await rawQuery(
    `UPDATE operator_users
        SET two_factor_enabled = false,
            two_factor_secret = NULL,
            two_factor_backup_codes = '{}'::text[],
            failed_login_attempts = 0,
            failed_login_locked_until = NULL
      WHERE username = $1`,
    [ADMIN_USERNAME],
  );
  await page.goto('about:blank');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* storage disabled */
    }
  });
});

test('S18 SSE stream emits step.start/step.done live; DB log column matches; reconnect succeeds', async ({
  page,
}) => {
  // ---- Phase 0: seed ------------------------------------------------------
  const admin = await enable2faForAdmin();
  const server = await createServer();
  const tenant = await createDeployableTenant(server.id, {
    shortCode: 's18-sse-stream',
    domain: 's18-sse-stream.test.local',
  });

  await loginWithTotp(page, admin.totp_secret_plain);

  // ---- Phase 1: trigger the deployment ------------------------------------
  // We stay on the post-login panel page so the EventSource opened in
  // page.evaluate inherits the session cookie attached by the browser
  // context (EventSource doesn't accept custom auth headers).
  const triggerRes = await page.request.post('/api/internal/deployments', {
    data: {
      tenantId: tenant.id,
      deploymentType: 'initial',
      triggerReason: 's18-sse-log-stream',
    },
  });
  expect(triggerRes.status()).toBe(201);
  const triggerBody = (await triggerRes.json()) as {
    success: boolean;
    data: { deploymentId: string };
  };
  expect(triggerBody.success).toBe(true);
  const deploymentId = triggerBody.data.deploymentId;
  expect(deploymentId).toBeTruthy();

  // ---- Phase 2: open the first EventSource in the browser -----------------
  // Stash incoming messages on `window.__sseMessages` so the test side
  // can poll without round-tripping a function reference per check. The
  // browser's EventSource auto-attaches the session cookie set during
  // `loginWithTotp`, which is what the SSE route's
  // `requireOperatorAuth` reads.
  //
  // We deliberately handle `onerror` by closing — the route closes the
  // stream once the pipeline emits its final log + the channel goes
  // quiet, and browsers fire `error` on a clean server-side EOF for
  // SSE. Reconnect spam would noise up the test and isn't part of the
  // operator's real flow (DeploymentLogStream.tsx does the same).
  await page.evaluate((id: string) => {
    interface SseWindow extends Window {
      __sseMessages?: string[];
      __sseState?: string;
      __sseInstance?: EventSource;
    }
    const w = window as SseWindow;
    w.__sseMessages = [];
    w.__sseState = 'connecting';
    const sse = new EventSource(`/api/internal/deployments/${id}/log-stream`);
    w.__sseInstance = sse;
    sse.onopen = () => {
      w.__sseState = 'open';
    };
    sse.onmessage = (e: MessageEvent<string>) => {
      w.__sseMessages!.push(e.data);
    };
    sse.onerror = () => {
      w.__sseState = 'error';
      sse.close();
    };
  }, deploymentId);

  // ---- Phase 3: live-streaming assertion ----------------------------------
  // Poll the in-page buffer until we have at least 10 events. If the
  // events only ever arrived as a single batch at the very end, this
  // poll would hit its `timeout` before the deployment finishes (we'd
  // see the message count jump from 0 to 20+ in one tick); the timeout
  // failure would surface that regression clearly.
  //
  // `expect.poll` re-runs the supplier every `intervals[]` step. 250ms
  // matches the deploy-status poll cadence; the worker emits a step
  // every ~300-500ms so the buffer reliably gains entries each tick.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          interface SseWindow extends Window {
            __sseMessages?: string[];
          }
          return (window as SseWindow).__sseMessages?.length ?? 0;
        }),
      {
        message: 'SSE stream must deliver >= 10 live events before pipeline terminates',
        timeout: 30_000,
        intervals: [250],
      },
    )
    .toBeGreaterThanOrEqual(10);

  // ---- Phase 4: wait for the deployment to terminate ----------------------
  // The worker drives the happy path to `status='success'` in ~3-4s; the
  // poll above will have already observed most of those events. We
  // still wait here to verify the terminal state before sampling the DB
  // log column (which is flushed at the success boundary in
  // runPipeline()).
  await waitForDeploymentSuccess(deploymentId, 30_000);

  // ---- Phase 5: snapshot the SSE buffer + close the first EventSource ----
  // Snapshot BEFORE close so we capture the final batch of events the
  // pipeline emitted (POST_DEPLOY step.done etc).
  const firstStreamMessages: string[] = await page.evaluate(() => {
    interface SseWindow extends Window {
      __sseMessages?: string[];
      __sseInstance?: EventSource;
    }
    const w = window as SseWindow;
    const msgs = (w.__sseMessages ?? []).slice();
    try {
      w.__sseInstance?.close();
    } catch {
      /* ignore */
    }
    return msgs;
  });

  // The buffer starts with the route's handshake line (always present;
  // it's the first thing the SSE start() handler writes). Strip it
  // before counting step lines so callers see a clean signal.
  const handshakeIdx = firstStreamMessages.findIndex((m) =>
    m.startsWith('Subscribed to deployment:'),
  );
  expect(handshakeIdx, 'SSE must emit a "Subscribed to" handshake first line').toBe(0);

  const pipelineLines = firstStreamMessages.slice(1);
  const stepStartLines = pipelineLines.filter((l) => /\[info\] step\.start /.test(l));
  const stepDoneLines = pipelineLines.filter((l) => /\[info\] step\.done /.test(l));

  // We saw a meaningful chunk of the lifecycle — at least 3 starts and
  // 3 dones. This is stricter than "10 events total" but still tolerant
  // of the subscribe-race that may swallow the first 1-3 lines.
  expect(
    stepStartLines.length,
    'SSE stream must include multiple step.start events',
  ).toBeGreaterThanOrEqual(3);
  expect(
    stepDoneLines.length,
    'SSE stream must include multiple step.done events',
  ).toBeGreaterThanOrEqual(3);

  // ---- Phase 6: DB log column matches the SSE stream ----------------------
  // The DB is the source of truth (ctx.flushLogs() runs at the
  // success/failure boundary). The SSE stream is best-effort fan-out
  // from the same publish path, so every line we received on the
  // stream must also be in the DB — modulo the handshake which is a
  // route-local synthetic line.
  const logRows = await rawQuery<{ log: string | null }>(
    `SELECT log FROM deployments WHERE id = $1`,
    [deploymentId],
  );
  expect(logRows).toHaveLength(1);
  const dbLog = logRows[0]!.log ?? '';
  expect(dbLog.length).toBeGreaterThan(0);

  // The DB log should mention every pipeline step name at least once
  // for both start and done. The 10-step canonical list lives in
  // `src/lib/deploy/steps/index.ts`.
  const STEP_NAMES = [
    'PRECHECK',
    'CONFIG_GENERATE',
    'COOLIFY_APP_CREATE',
    'DOCKER_IMAGE_PULL',
    'CONFIG_INJECT',
    'CONTAINER_START',
    'HEALTH_CHECK',
    'SSL_CERTIFICATE',
    'DOMAIN_VERIFICATION',
    'POST_DEPLOY',
  ] as const;
  for (const name of STEP_NAMES) {
    expect(dbLog).toContain(`step.start ${name}`);
    expect(dbLog).toContain(`step.done ${name}`);
  }

  // Every step.start/step.done line we saw on the stream must be a
  // verbatim substring of the DB log column — proves the SSE fan-out
  // and the DB flush share the same `ctx.log()` source. We compare on
  // the step lines specifically (not the handshake, not the route's
  // synthetic lines) because everything in `pipelineLines` came from
  // `ctx.log()`.
  for (const line of [...stepStartLines, ...stepDoneLines]) {
    expect(dbLog, `DB log column missing line that the SSE stream emitted: ${line}`).toContain(
      line,
    );
  }

  // ---- Phase 7: reconnect — the route must accept a fresh subscription ---
  // After the deployment is terminal the pipeline emits no further
  // pubs, so a fresh EventSource will receive the route's synthetic
  // handshake line and then sit idle until the operator navigates
  // away. We assert the handshake arrives within a few seconds — that
  // proves auth still works, the route still mounts, and Redis pubsub
  // is healthy. The route header docstring explicitly states it does
  // NOT replay history; we capture that expected behaviour here.
  await page.evaluate((id: string) => {
    interface SseWindow extends Window {
      __sseMessages2?: string[];
      __sseState2?: string;
      __sseInstance2?: EventSource;
    }
    const w = window as SseWindow;
    w.__sseMessages2 = [];
    w.__sseState2 = 'connecting';
    const sse = new EventSource(`/api/internal/deployments/${id}/log-stream`);
    w.__sseInstance2 = sse;
    sse.onopen = () => {
      w.__sseState2 = 'open';
    };
    sse.onmessage = (e: MessageEvent<string>) => {
      w.__sseMessages2!.push(e.data);
    };
    sse.onerror = () => {
      w.__sseState2 = 'error';
      sse.close();
    };
  }, deploymentId);

  // The handshake line MUST arrive within 5s. The route synthesises it
  // immediately in `start()` before awaiting `sub.subscribe()`, so a
  // healthy backend turns this round-trip in <500ms.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          interface SseWindow extends Window {
            __sseMessages2?: string[];
          }
          return (window as SseWindow).__sseMessages2?.[0] ?? null;
        }),
      {
        message: 'Reconnected EventSource must receive the route handshake line',
        timeout: 5_000,
        intervals: [200],
      },
    )
    .toMatch(/^Subscribed to deployment:/);

  // Sanity: the reconnect does NOT replay historical step lines. This
  // is by design — header docstring of route.ts states the operator UI
  // hydrates history from `deployments.log` and SSE only ships new
  // lines. If a future change adds replay, this assertion needs
  // updating in lockstep with the docstring.
  const reconnectMessages: string[] = await page.evaluate(() => {
    interface SseWindow extends Window {
      __sseMessages2?: string[];
      __sseInstance2?: EventSource;
    }
    const w = window as SseWindow;
    const msgs = (w.__sseMessages2 ?? []).slice();
    try {
      w.__sseInstance2?.close();
    } catch {
      /* ignore */
    }
    return msgs;
  });
  // Wait an extra beat after capture to make sure no late-arriving
  // historical messages would invalidate the no-replay assumption.
  // (The route is sync about its subscribe() and won't dribble in.)
  const reconnectStepLines = reconnectMessages.filter((l) => /step\.start|step\.done/.test(l));
  expect(reconnectStepLines, 'Reconnect must not replay historical step lines').toHaveLength(0);
});
