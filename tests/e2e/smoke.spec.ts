/**
 * Smoke test — sanity check that the entire E2E stack is up:
 *   - dev server (port 3001)
 *   - postgres (port 55432) — via truncateAll() side-effect
 *   - redis (port 16379) — via resetAllMocks()
 *   - wiremock (port 58080) — via resetCoolifyScenarios()
 *
 * If this passes, the rest of the scenario suite has a healthy baseline.
 */

import { test, expect } from './fixtures/auth.fixture';
import { rawQuery, truncateAll } from './fixtures/db';
import { resetAllMocks } from './fixtures/mocks';
import { resetCounter } from './fixtures/data';
import { CoolifyClient } from '../../src/lib/coolify';

test.beforeEach(async () => {
  await truncateAll();
  await resetAllMocks();
  resetCounter();
});

test('login page renders with both inputs and a submit button', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('input[name="username"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toBeVisible();
  await expect(page).toHaveTitle(/Control Center/i);
});

test('postgres reachable via truncateAll fixture', async () => {
  // truncateAll already ran in beforeEach. Verify there's a seed admin row.
  const rows = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM operator_users WHERE username = 'admin'`,
  );
  expect(rows[0]!.count).toBe('1');
});

test('wiremock health endpoint returns healthy', async () => {
  const wm = process.env['COOLIFY_API_URL'] ?? 'http://localhost:58080';
  const r = await fetch(`${wm}/__admin/health`);
  expect(r.ok).toBe(true);
  const j = (await r.json()) as { status: string };
  expect(j.status).toBe('healthy');
});

test('coolify happy mode createApp end-to-end via the client', async () => {
  const client = new CoolifyClient({
    baseUrl: process.env['COOLIFY_API_URL'] ?? 'http://localhost:58080',
    token: 'smoke-test-token',
  });
  const app = await client.createApp({
    name: 'smoke',
    domain: 'smoke.test.local',
    serverUuid: 'srv-1',
    dockerImage: 'qrsiparis-app:test',
    envVars: {},
  });
  expect(app.uuid).toMatch(/^test-/);
});
