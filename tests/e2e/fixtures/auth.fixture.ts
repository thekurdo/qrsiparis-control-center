/**
 * Authentication Playwright fixtures.
 *
 * `loggedInAdmin`: logs in as the seeded admin (from `pnpm db:seed`)
 * with `DEFAULT_OPERATOR_PASSWORD`. If 2FA is enabled it walks through
 * the verify flow using `otplib`; if not yet enabled (first login) it
 * walks through `/2fa-setup`.
 *
 * `loggedInOperator`: inserts a fresh test-operator-N (test- prefix so
 * the `truncateAll()` cleanup catches it) and logs in.
 *
 * Note on 2FA secrets in fixtures: the `two_factor_secret` column is
 * encrypted (AES-GCM). For tests, we either:
 *   (a) start the admin with 2FA disabled and walk through setup each test
 *   (b) for fresh operators, insert with 2FA disabled
 *
 * The seed script leaves 2FA disabled (see src/db/seed.ts), so (a) is
 * what loggedInAdmin does the first time it runs after a truncate.
 */

import { test as base, type Page } from '@playwright/test';
import { authenticator } from 'otplib';

import { rawQuery } from './db';
import { operatorData, TEST_PASSWORD, TEST_PASSWORD_HASH } from './data';

type AuthFixtures = {
  loggedInAdmin: Page;
  loggedInOperator: Page;
  freshOperator: { username: string; password: string };
};

async function loginWithCredentials(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
}

async function handle2faIfPresent(page: Page, secret: string | null): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  const url = page.url();

  if (url.includes('/2fa-setup')) {
    // First-time setup — extract the QR/secret from the page so we can
    // generate a real TOTP.
    const exposedSecret = await page
      .locator('[data-totp-secret]')
      .getAttribute('data-totp-secret');
    if (!exposedSecret) {
      throw new Error(
        '[auth.fixture] /2fa-setup page does not expose data-totp-secret; ' +
          'add a small `<span data-totp-secret={secret} hidden />` to the setup page for tests.',
      );
    }
    await page.fill('input[name="code"]', authenticator.generate(exposedSecret));
    await page.click('button[type="submit"], button:has-text("Doğrula")');

    // After successful verification the wizard advances to the "backup
    // codes shown once" phase — same URL, different in-page state. Click
    // through to land on the panel home where the test can make
    // post-condition assertions.
    await page.click('button:has-text("Onayla ve Devam Et")');
    await page.waitForURL((u) => !u.toString().includes('/2fa-setup'), {
      timeout: 10_000,
    });
  } else if (url.includes('/2fa-verify')) {
    if (!secret) {
      throw new Error(
        '[auth.fixture] /2fa-verify shown but no secret known. Seed flow expected.',
      );
    }
    await page.fill('input[name="code"]', authenticator.generate(secret));
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.toString().includes('/2fa-verify'));
  }
}

export const test = base.extend<AuthFixtures>({
  loggedInAdmin: async ({ page }, use) => {
    const username = process.env['DEFAULT_OPERATOR_USER'] ?? 'admin';
    const password = process.env['DEFAULT_OPERATOR_PASSWORD'] ?? 'AdminTest123!';
    await loginWithCredentials(page, username, password);
    await handle2faIfPresent(page, null /* no preknown secret */);
    await use(page);
  },

  freshOperator: async ({}, use) => {
    const op = operatorData();
    await rawQuery(
      `INSERT INTO operator_users (username, email, full_name, password_hash, role, two_factor_enabled, is_active)
       VALUES ($1,$2,$3,$4,$5,false,true)`,
      [op.username, op.email, op.fullName, TEST_PASSWORD_HASH, op.role],
    );
    await use({ username: op.username, password: TEST_PASSWORD });
  },

  loggedInOperator: async ({ page, freshOperator }, use) => {
    await loginWithCredentials(page, freshOperator.username, freshOperator.password);
    await handle2faIfPresent(page, null);
    await use(page);
  },
});

export { expect } from '@playwright/test';
