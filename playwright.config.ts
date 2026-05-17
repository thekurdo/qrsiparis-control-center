/**
 * Playwright config for control-center E2E suite.
 *
 * Design choices:
 *   - `workers: 1` + `fullyParallel: false`: tests share DB + Redis +
 *     WireMock state, and per-test truncate is cheaper than per-test
 *     isolated DB instances at this scale. Revisit when the suite hits
 *     ~50 tests.
 *   - `webServer` config disabled in favour of running `pnpm dev` and
 *     `pnpm worker` manually (or via docker compose) — Playwright's
 *     webServer occasionally races with the dev server compile.
 *   - JSON + HTML + list reporters: list for live feedback, JSON for
 *     CI parsing, HTML for human triage.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env['CI'],
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:3001',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
});
