import { test, expect } from '@playwright/test';

test('RicozContract homepage navigation works', async ({ page }) => {
  await page.goto('/');

  const navigationLinks = [
    'Features',
    'How it works',
    'Security',
  ];

  for (const name of navigationLinks) {
    const link = page.getByRole('link', {
      name,
      exact: true,
    }).first();

    await expect(link).toBeVisible();

    const href = await link.getAttribute('href');

    console.log(`${name} -> ${href}`);

    expect(href).toBeTruthy();

    if (href?.startsWith('#')) {
      const target = page.locator(href);
      await expect(target).toHaveCount(1);
    }
  }
});
