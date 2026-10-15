import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('landing page is usable, theme previews work, and downloads match their checksums', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /A little space/ })).toBeVisible();
  await page.getByRole('button', { name: 'Sepia', exact: true }).click();
  await expect(page.locator('#app-preview')).toHaveAttribute('src', './assets/app-sepia.png');
  await expect(page.getByRole('button', { name: 'Sepia', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const release = await (await request.get('/release.json')).json();
  expect(release.channel).toBe('developer-alpha');
  expect(release.googlePreconfigured).toBe(false);
  for (const entry of [release.mac, release.source]) {
    const body = await readFile(`release/github/${entry.name}`);
    expect(body.length).toBe(entry.size);
    expect(createHash('sha256').update(body).digest('hex')).toBe(entry.sha256);
  }
  await expect(page.getByRole('link', { name: /View GitHub Releases/ })).toHaveAttribute(
    'href',
    'https://github.com/protoray/wattle-notes/releases',
  );
  await expect(page.getByRole('link', { name: /Browse the source/ })).toHaveAttribute(
    'href',
    'https://github.com/protoray/wattle-notes',
  );
  expect((await request.get('/downloads/wattle-notes-macos-arm64.zip')).status()).toBe(404);
  expect((await request.get('/downloads/wattle-notes-source.zip')).status()).toBe(404);
  await expect(page.getByRole('link', { name: /Buy me a coffee/ })).toHaveCount(
    release.supportUrl ? 1 : 0,
  );
  await page.getByRole('button', { name: 'Charcoal', exact: true }).click();
  await page.screenshot({
    path: 'test-results/launch-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('mobile layout and information pages work without a public demo', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'test-results/launch-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Privacy, in plain words.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'Getting started', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'browser demo', exact: true })).toHaveCount(0);
  expect((await request.get('/demo/')).status()).toBe(404);
  expect((await request.get('/demo/index.html')).status()).toBe(404);
});

test('site does not make third-party requests or offer missing local resources', async ({
  page,
  request,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:1430')) external.push(request.url());
  });
  for (const url of ['/', '/privacy/', '/getting-started/']) {
    await page.goto(url);
    await expect(page.locator('a[href*="/demo/"]')).toHaveCount(0);
    await expect(page.locator('a[href*="/downloads/"]')).toHaveCount(0);
    const paths = await page
      .locator('a[href], img[src], link[href], script[src]')
      .evaluateAll((nodes) =>
        nodes
          .map((node) => node.getAttribute('href') ?? node.getAttribute('src')!)
          .filter((path) => path && !path.startsWith('#') && !path.startsWith('https:')),
      );
    for (const path of paths)
      expect((await request.get(new URL(path, page.url()).href)).ok(), path).toBe(true);
  }
  expect(external).toEqual([]);
});

test('an explicitly configured support link is offered without adding a checkout or tracking', async ({
  page,
  request,
}) => {
  const release = await (await request.get('/release.json')).json();
  await page.route('**/release.json', (route) =>
    route.fulfill({ json: { ...release, supportUrl: 'https://example.test/support' } }),
  );
  await page.goto('/');
  const support = page.getByRole('link', { name: /Buy me a coffee/ });
  await expect(support).toBeVisible();
  await expect(support).toHaveAttribute('href', 'https://example.test/support');
  await expect(page.locator('form')).toHaveCount(0);
});
