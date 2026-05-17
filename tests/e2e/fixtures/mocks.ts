/**
 * Mock-state controls for E2E tests.
 *
 * The CoolifyClient sets `X-Mock-Mode` per request (configurable via the
 * client instance), so test-side control is mostly about WireMock scenario
 * resets between tests rather than mode switching.
 *
 * SSH failure injection is process-env based; for full server-process E2E
 * we can only assert this from in-process callers (the dev server's env
 * was set at boot). Tests that need server-side SSH failures should
 * restart the dev server with the appropriate env (deferred to V2).
 */

import IORedis from 'ioredis';

const COOLIFY_ADMIN = (
  process.env['COOLIFY_API_URL'] ?? 'http://localhost:58080'
) + '/__admin';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:16379';

export async function resetCoolifyScenarios(): Promise<void> {
  // Reset both scenarios state (for any priority-chained scenarios) and
  // request journal (so call-count assertions start from zero per test).
  await fetch(`${COOLIFY_ADMIN}/scenarios/reset`, { method: 'POST' });
  await fetch(`${COOLIFY_ADMIN}/requests`, { method: 'DELETE' });
}

export async function flushRedis(): Promise<void> {
  const redis = new IORedis(REDIS_URL, { lazyConnect: true });
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

export async function resetAllMocks(): Promise<void> {
  await resetCoolifyScenarios();
  await flushRedis();
}

/**
 * Inspect WireMock's request journal — useful for asserting that a
 * specific Coolify call was made (or NOT made) during a test.
 */
export async function getCoolifyRequestCount(
  method: string,
  urlPattern: string,
): Promise<number> {
  const r = await fetch(`${COOLIFY_ADMIN}/requests/count`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method,
      urlPathPattern: urlPattern,
    }),
  });
  const j = (await r.json()) as { count: number };
  return j.count;
}
