import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { themes } from '../../src/themes';

test('capture the real browser preview for the launch website', async ({ page }) => {
  await mkdir('website/assets', { recursive: true });
  await page.setViewportSize({ width: 1320, height: 860 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Ideas / }).click();
  await page.getByRole('button', { name: 'A useful note', exact: true }).click();
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  for (const theme of themes) {
    await page.getByRole('button', { name: 'Settings & tools', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Appearance', exact: true });
    await dialog.getByRole('radio', { name: new RegExp(theme.name) }).check();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
    await page.getByRole('button', { name: 'Settings & tools', exact: true }).click();
    await page.screenshot({
      path: `website/assets/app-${theme.id}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
});
