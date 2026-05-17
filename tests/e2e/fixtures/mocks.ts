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

/**
 * Drop every dynamically-installed mapping and reload the on-disk
 * mappings under `docker/wiremock/mappings/`. Tests that inject runtime
 * mappings via {@link addCoolifyMapping} MUST call this in `afterEach`
 * so subsequent tests (or the next run) start from the canonical mapping
 * set. `resetCoolifyScenarios()` deliberately doesn't do this because
 * the request-journal/scenarios reset is the common case and the full
 * mapping reload is slower (file IO inside the WireMock container).
 */
export async function resetCoolifyMappings(): Promise<void> {
  await fetch(`${COOLIFY_ADMIN}/mappings/reset`, { method: 'POST' });
}

/**
 * Install a runtime WireMock mapping. Returns the mapping id so callers
 * can delete it surgically with {@link removeCoolifyMapping}, or rely on
 * `resetCoolifyMappings()` in `afterEach` to drop all runtime mappings
 * in one shot.
 *
 * Use this for per-test overrides that the on-disk JSON files don't
 * cover (e.g., S8 needs `getApp` to return `failed` *regardless* of
 * `X-Mock-Mode`, because injecting `COOLIFY_MOCK_MODE` into the running
 * worker is more invasive than swapping a mapping).
 */
export async function addCoolifyMapping(
  mapping: Record<string, unknown>,
): Promise<string> {
  const r = await fetch(`${COOLIFY_ADMIN}/mappings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapping),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(
      `[mocks] addCoolifyMapping failed status=${r.status} body=${body.slice(0, 200)}`,
    );
  }
  const j = (await r.json()) as { id: string };
  return j.id;
}

/**
 * Remove a single runtime mapping by id (returned by
 * {@link addCoolifyMapping}). Safe to call for an unknown id — WireMock
 * returns 404 silently.
 */
export async function removeCoolifyMapping(id: string): Promise<void> {
  await fetch(`${COOLIFY_ADMIN}/mappings/${id}`, { method: 'DELETE' });
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
