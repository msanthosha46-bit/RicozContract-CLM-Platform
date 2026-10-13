import { test, expect } from '@playwright/test';

test('Login form shows required fields', async ({ page }) => {
  await page.goto('/login');

  const email = page.locator('input[type="email"]');
  const password = page.locator('input[type="password"]');

  await expect(email).toBeVisible();
  await expect(password).toBeVisible();

  console.log('Email field:', await email.count());
  console.log('Password field:', await password.count());

  await expect(email).toHaveAttribute('required', '');
  await expect(password).toHaveAttribute('required', '');
});
