import { test, expect } from '@playwright/test';

const TEST_EMAIL = process.env.RICOZ_TEST_EMAIL;
const TEST_PASSWORD = process.env.RICOZ_TEST_PASSWORD;
const LOGIN_URL = 'https://ricoz-contract-clm-platform.vercel.app/login';

test('Dashboard loads for authenticated test user (read-only)', async ({ page }) => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    test.skip(true, 'RICOZ_TEST_EMAIL and RICOZ_TEST_PASSWORD must be configured');
  }

  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });

  const failedRequests: string[] = [];
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    failedRequests.push(request.method() + ' ' + request.url() + ' - ' + (failure?.errorText || 'failed'));
  });

  const loginResponsePromise = page
    .waitForResponse(
      (response) => {
        try {
          const url = new URL(response.url());
          return url.pathname === '/api/auth/login' && response.request().method() === 'POST';
        } catch {
          return false;
        }
      },
      { timeout: 15000 }
    )
    .catch(() => null);

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const emailField = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i], input[aria-label*="email" i]').first();
  const passwordField = page.locator('input[type="password"], input[name="password"], input[placeholder*="password" i], input[aria-label*="password" i]').first();

  await expect(emailField).toBeVisible();
  await expect(passwordField).toBeVisible();

  await emailField.fill(TEST_EMAIL);
  await passwordField.fill(TEST_PASSWORD);

  const submitButton = page.getByRole('button', { name: /sign in|log in|login|submit/i }).first();
  await expect(submitButton).toBeVisible();
  await submitButton.click();

  const loginResponse = await loginResponsePromise;
  if (loginResponse === null) {
    if (failedRequests.length > 0) {
      console.log('Failed requests:', failedRequests);
    }
    throw new Error('Login API response not captured (timeout or network failure).');
  }

  const reqUrl = new URL(loginResponse.url());
  console.log('Login API - method:', loginResponse.request().method(), 'path:', reqUrl.pathname, 'status:', loginResponse.status());

  if (loginResponse.status() === 401) {
    throw new Error('Login failed: credentials rejected (HTTP 401). Verify authorized test account.');
  }
  if (!loginResponse.ok()) {
    throw new Error('Login failed: unexpected HTTP status ' + loginResponse.status());
  }

  await page.waitForURL((url) => !/^\/login\/?$/i.test(url.pathname), { timeout: 60000 });

  const currentPath = new URL(page.url()).pathname;
  expect(currentPath).not.toMatch(/^\/login\/?$/i);

  const appNavigation = page.getByRole('link', { name: /contracts|obligations|reports|dashboard/i }).first();
  await expect(appNavigation, 'Expected authenticated app navigation to be visible').toBeVisible({ timeout: 30000 });

  expect(errors, 'Uncaught JS errors: ' + errors.join('; ')).toHaveLength(0);
});
