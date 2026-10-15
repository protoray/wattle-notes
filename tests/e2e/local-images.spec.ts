import { test, expect } from '@playwright/test';

// Exercise the real Markdown sanitizer, native IPC contract and Blob hydration
// in a browser decoder. The native filesystem boundary has separate Rust tests.
test('local image bytes render while external images remain blocked', async ({ page }) => {
  const remoteRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('tracking.example')) remoteRequests.push(request.url());
  });
  await page.addInitScript(() => {
    Object.assign(window, { isTauri: true });
  });
  await page.route('**/src/main.tsx', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
      import { mockIPC } from '/node_modules/@tauri-apps/api/mocks.js';
      import { renderMarkdown } from '/src/markdown.ts';
      import { hydrateLocalImages } from '/src/localImages.ts';
      mockIPC((command, args) => {
        if (command !== 'attachment_bytes' || args.sourceNote !== 'test-note' || args.target !== '../attachments/screen%20shot.png') {
          throw new Error('Unexpected image request');
        }
        return { bytes: Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII='), c => c.charCodeAt(0)), mime_type: 'image/png' };
      });
      const root = document.getElementById('root');
      root.innerHTML = renderMarkdown('![Local](../attachments/screen%20shot.png)\\n![Remote](https://tracking.example/pixel.png)');
      hydrateLocalImages(root, 'test-note');
    `,
    }),
  );
  await page.route('**/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'content-security-policy': "img-src 'self' blob:",
      },
    });
  });
  await page.goto('/');
  const image = page.getByAltText('Local', { exact: true });
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(1);
  await expect(page.getByText('Remote image not loaded: Remote')).toBeVisible();
  expect(remoteRequests).toEqual([]);
});
