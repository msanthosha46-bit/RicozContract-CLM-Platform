import { test, expect } from '@playwright/test';

test('RicozContract sign-in page opens', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('link', {
    name: 'Sign in',
    exact: true,
  }).first().click();

  await expect(page).toHaveURL(/login|sign-in/i);

  await expect(page.locator('input').first()).toBeVisible();

  console.log('Sign-in URL:', page.url());
});
