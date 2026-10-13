import { test, expect } from '@playwright/test';

test('Login prevents empty submission', async ({ page }) => {
  await page.goto('/login');

  const email = page.locator('input[type="email"]');
  const password = page.locator('input[type="password"]');

  await expect(email).toBeVisible();
  await expect(password).toBeVisible();

  // Verify the browser considers the empty form invalid.
  const emailValid = await email.evaluate(
    (element: HTMLInputElement) => element.checkValidity()
  );

  const passwordValid = await password.evaluate(
    (element: HTMLInputElement) => element.checkValidity()
  );

  expect(emailValid).toBe(false);
  expect(passwordValid).toBe(false);

  console.log('Empty email valid:', emailValid);
  console.log('Empty password valid:', passwordValid);
});
