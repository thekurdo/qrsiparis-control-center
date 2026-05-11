/**
 * GET /api/internal/deployments/{id}/log-stream — SSE log stream (Phase H8).
 *
 * Subscribes to the Redis pub/sub channel `deployment:{id}:log` and forwards
 * every received message as a Server-Sent Event to the operator browser.
 *
 * Channel contract (matches `createPipelineContext` in
 * `src/lib/deploy/context.ts`):
 *   - Each message is one preformatted log line:
 *       `[ISO8601] [level] msg {meta?}`
 *   - The pipeline does not chunk lines — one publish = one full line.
 *
 * Lifecycle:
 *   1. Auth-gate (any operator).
 *   2. Open a dedicated IORedis connection in subscribe mode. We can NOT
 *      reuse the BullMQ / runner Redis client here because once a node-redis
 *      / ioredis connection enters subscribe mode it cannot serve other
 *      commands.
 *   3. Stream incoming messages through the response's ReadableStream.
 *   4. When the client disconnects (`req.signal.abort`), or the controller
 *      cancels, close the Redis connection promptly so we don't leak
 *      sockets per browser tab.
 *
 * We do NOT replay the historical log over SSE — the server component
 * (`app/(panel)/deployments/[id]/page.tsx`) already hydrates the client
 * with `deployments.log` so the new lines just append on top of that.
 *
 * Note for active deploys: the client should only open this stream when
 * the deployment status is `pending` or `in_progress`. For terminal
 * states the log is already complete and SSE would just sit idle.
 */

import IORedis from 'ioredis';

import { requireOperatorAuth } from '@/lib/auth/middleware';

const REDIS_URL = process.env['REDIS_URL'];

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await requireOperatorAuth(['admin', 'operator']);

  if (!REDIS_URL) {
    return new Response('REDIS_URL is not configured', { status: 503 });
  }

  // Per-request subscriber. Once `subscribe` is called the connection
  // becomes a one-purpose pubsub socket — never reuse the worker / runner
  // client here.
  const sub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  const channel = `deployment:${id}:log`;

  let closed = false;
  function closeSub() {
    if (closed) return;
    closed = true;
    // best-effort — don't throw across the request boundary
    void sub.quit().catch(() => {
      /* swallow */
    });
  }

  // Closing the request kills the ReadableStream which fires `cancel()`
  // below. We also listen for the request's abort signal as a belt-and-
  // braces guard for runtimes that don't propagate cancel reliably.
  req.signal.addEventListener('abort', closeSub);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function safeEnqueue(payload: string) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // The controller is already closed (client gone). Don't crash.
          closeSub();
        }
      }

      // Initial handshake event so the browser EventSource resolves
      // `onopen` immediately. Operators see a friendly first line in the
      // log pane while waiting for pipeline output.
      safeEnqueue(`data: Subscribed to ${channel}\n\n`);

      sub.on('message', (_ch: string, msg: string) => {
        if (closed) return;
        // SSE spec: a multi-line payload must split each line with its
        // own `data: ` prefix. The pipeline only ever publishes single
        // lines (createPipelineContext) but we defensively handle '\n'
        // in case meta JSON contains one.
        const lines = msg.split('\n');
        let payload = '';
        for (const line of lines) {
          payload += `data: ${line}\n`;
        }
        payload += '\n';
        safeEnqueue(payload);
      });

      sub.on('error', (err: Error) => {
        if (closed) return;
        safeEnqueue(`data: SSE error: ${err.message}\n\n`);
      });

      try {
        await sub.subscribe(channel);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        safeEnqueue(`data: SSE subscribe failed: ${m}\n\n`);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
        closeSub();
      }
    },
    cancel() {
      closeSub();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable nginx / Coolify Traefik response buffering so each line
      // hits the client immediately (otherwise the proxy can hold a
      // ~4KB buffer before flushing).
      'X-Accel-Buffering': 'no',
    },
  });
}
