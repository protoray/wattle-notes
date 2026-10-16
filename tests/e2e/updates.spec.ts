import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

test('settings explains alpha updates without contacting GitHub from the preview', async ({
  page,
}) => {
  const githubRequests: string[] = [];
  page.on('request', (request) => {
    if (/github(?:usercontent)?\.com/.test(request.url())) githubRequests.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings & tools', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const updates = page.getByRole('region', { name: 'App updates' });
  await expect(updates.getByText(`Wattle Notes ${version} · Developer alpha`)).toBeVisible();
  await expect(updates.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  await expect(updates.getByRole('checkbox')).toBeDisabled();
  await expect(updates.getByText('Updates are available in the desktop app.')).toBeVisible();
  await page.screenshot({ path: 'test-results/app-updates-settings.png', fullPage: true });
  expect(githubRequests).toEqual([]);
});
