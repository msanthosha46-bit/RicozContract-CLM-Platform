import { test, expect, type Request, type Response } from '@playwright/test';

import { evaluateProductionAuthGate } from './support/productionAuthGate';

// This test submits real credentials to the production deployment, so it is
// locked behind an explicit opt-in plus a target guard. It runs only when ALL
// of the following are true:
//
//   RICOZ_ENABLE_PRODUCTION_AUTH_TEST=1   (explicit opt-in, must be exactly "1")
//   RICOZ_TEST_EMAIL=...                  (non-empty)
//   RICOZ_TEST_PASSWORD=...               (non-empty)
//   RICOZ_PRODUCTION_AUTH_TARGET=https://ricoz-contract-clm-platform.vercel.app
//
// Credentials alone never enable it; routine pushes and pull requests never set
// the opt-in (see .github/workflows/playwright.yml, which also excludes the
// @production-auth tag). The gate is evaluated before any navigation, so a
// missing/ambiguous target refuses to submit anything. See
// tests/support/productionAuthGate.ts for the guard logic. Safe manual run:
//   RICOZ_ENABLE_PRODUCTION_AUTH_TEST=1 \
//   RICOZ_PRODUCTION_AUTH_TARGET=https://ricoz-contract-clm-platform.vercel.app \
//   RICOZ_TEST_EMAIL=... RICOZ_TEST_PASSWORD=... \
//   npx playwright test tests/dashboard.spec.ts
//
// Never log or commit the credential values.
const gate = evaluateProductionAuthGate(process.env);

const TEST_EMAIL = process.env.RICOZ_TEST_EMAIL;
const TEST_PASSWORD = process.env.RICOZ_TEST_PASSWORD;
const LOGIN_PATH = '/api/auth/login';

// Never echo a full URL: query parameters can carry tokens or filters. Only the
// pathname is ever reported.
const safePath = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return '<unparseable-url>';
  }
};

// The failure body is a single short, non-sensitive sentence
// (e.g. "Invalid email or password"). Read it defensively and clip it so a body
// can never flood the report or leak anything unexpected.
const safeReason = async (response: Response): Promise<string> => {
  try {
    const text = await response.text();
    if (!text) return '';
    const parsed = JSON.parse(text);
    const message = parsed && typeof parsed.message === 'string' ? parsed.message : '';
    return message.slice(0, 120);
  } catch {
    return '';
  }
};

test('Dashboard loads for authenticated test user (read-only) @production-auth', async ({ page }) => {
  // Refuse to submit credentials unless the explicit opt-in, credentials and the
  // intended production target are all present. Skips before any request.
  if (!gate.run) {
    test.skip(true, gate.reason);
    return;
  }
  const loginUrl = `${gate.target}/login`;

  const pageErrors: string[] = [];
  const onPageError = (error: Error) => {
    pageErrors.push(error.message);
  };
  page.on('pageerror', onPageError);

  const failedRequestPaths: string[] = [];
  let loginNetworkFailure: string | null = null;
  const onRequestFailed = (request: Request) => {
    const path = safePath(request.url());
    const reason = request.failure()?.errorText || 'failed';
    failedRequestPaths.push(`${request.method()} ${path} - ${reason}`);
    if (path === LOGIN_PATH) loginNetworkFailure = reason;
  };
  page.on('requestfailed', onRequestFailed);

  try {
    // Register the wait before submitting so a fast response cannot be missed.
    const loginResponsePromise = page
      .waitForResponse(
        (response) => {
          try {
            return new URL(response.url()).pathname === LOGIN_PATH && response.request().method() === 'POST';
          } catch {
            return false;
          }
        },
        { timeout: 15000 }
      )
      .catch(() => null);

    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    const emailField = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i], input[aria-label*="email" i]').first();
    const passwordField = page.locator('input[type="password"], input[name="password"], input[placeholder*="password" i], input[aria-label*="password" i]').first();
    await expect(emailField).toBeVisible();
    await expect(passwordField).toBeVisible();

    await emailField.fill(TEST_EMAIL);
    await passwordField.fill(TEST_PASSWORD);

    // Scope to the sign-in form's submit control so the Google button (outside the
    // form) can never be clicked by mistake.
    const submitButton = page.locator('form').getByRole('button', { name: /sign in|log in|login|submit/i }).first();
    await expect(submitButton).toBeVisible();
    await submitButton.click();

    const loginResponse = await loginResponsePromise;

    if (loginResponse === null) {
      if (failedRequestPaths.length > 0) {
        console.log('Failed request paths:', failedRequestPaths);
      }
      if (loginNetworkFailure) {
        throw new Error(`Login request failed at the network level (${loginNetworkFailure}); no HTTP response was received.`);
      }
      throw new Error(`No POST ${LOGIN_PATH} response observed within 15s (response timeout).`);
    }

    // Capture every fact needed from the live response in one place, before any
    // teardown. `response.text()` consumes the body stream, so it is read at
    // most once and only for a non-2xx status. Everything below works from the
    // captured primitives, so no later step touches the Response object and the
    // body can never be read a second time.
    const status = loginResponse.status();
    const method = loginResponse.request().method();
    const path = safePath(loginResponse.url());
    const reason = loginResponse.ok() ? '' : await safeReason(loginResponse);
    console.log('Login API - method:', method, 'path:', path, 'status:', status);

    if (status === 401) {
      throw new Error(
        `Login failed: credentials rejected (HTTP 401${reason ? `: ${reason}` : ''}). ` +
          'Verify the authorized test account exists, is Active, and uses password sign-in (a Google-only account has no password).'
      );
    }
    if (status === 429) {
      throw new Error('Login failed: too many attempts (HTTP 429). Wait for the rate-limit window before retrying.');
    }
    if (!loginResponse.ok()) {
      throw new Error(`Login failed: unexpected HTTP status ${status}${reason ? `: ${reason}` : ''}.`);
    }
    if (loginNetworkFailure) {
      throw new Error(`Login response received but a network failure was also recorded (${loginNetworkFailure}).`);
    }

    await page.waitForURL((url) => !/^\/login\/?$/i.test(url.pathname), { timeout: 60000 });

    const currentPath = new URL(page.url()).pathname;
    expect(currentPath).not.toMatch(/^\/login\/?$/i);

    const appNavigation = page.getByRole('link', { name: /contracts|obligations|reports|dashboard/i }).first();
    await expect(appNavigation, 'Expected authenticated app navigation to be visible').toBeVisible({ timeout: 30000 });

    expect(pageErrors, 'Uncaught JS errors: ' + pageErrors.join('; ')).toHaveLength(0);
  } finally {
    // Runs after every assertion that depends on the page. Detaching the
    // listeners is a purely local emitter operation (it performs no browser I/O),
    // so a late page/network event arriving during tear-down can never run a
    // handler against a closed page. Both calls are guarded so cleanup itself
    // cannot mask a genuine failure.
    try {
      page.off('pageerror', onPageError);
    } catch {
      // nothing to detach if the page emitter is already gone
    }
    try {
      page.off('requestfailed', onRequestFailed);
    } catch {
      // nothing to detach if the page emitter is already gone
    }
  }
});
