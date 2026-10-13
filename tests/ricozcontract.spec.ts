import { test, expect } from '@playwright/test';

test('RicozContract homepage loads', async ({ page, baseURL }) => {
  const errors: string[] = [];

  page.on('pageerror', error => {
    errors.push(error.message);
  });

  const response = await page.goto('/');

  expect(response).not.toBeNull();
  expect(response!.ok()).toBeTruthy();

  // The homepage must be served by the configured base URL. That URL is
  // validated in playwright.config.ts to be loopback-only, so this can never
  // resolve to a production origin.
  expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);

  await expect(page.locator('body')).toBeVisible();

  console.log('Page title:', await page.title());
  console.log('JavaScript errors:', errors);
});
