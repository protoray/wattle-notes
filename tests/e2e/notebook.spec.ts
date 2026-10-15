import { test, expect } from '@playwright/test';
test('combined notebook sidebar leaves room to write and search reopens it', async ({ page }) => {
  await page.setViewportSize({ width: 1320, height: 860 });
  await page.goto('/');
  const sidebar = page.getByRole('complementary');
  await expect(sidebar.getByRole('textbox', { name: 'Search notes' })).toBeVisible();
  await expect(sidebar.locator('.note-card')).toHaveCount(4);
  await sidebar.getByText('Folders & tags', { exact: true }).click();
  await expect(sidebar.getByRole('navigation', { name: 'Note folders' })).toBeVisible();
  await sidebar.getByText('Folders & tags', { exact: true }).click();
  const menuBounds = await sidebar.boundingBox();
  const writingBounds = await page.locator('.workspace').boundingBox();
  expect(menuBounds!.width).toBeLessThanOrEqual(320);
  expect(writingBounds!.width).toBeGreaterThanOrEqual(990);
  await page.screenshot({ path: 'test-results/notebook-combined.png', fullPage: true });
  await page.getByRole('button', { name: 'Toggle notebook sidebar' }).click();
  await expect(sidebar).not.toBeVisible();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  await expect(sidebar.getByRole('textbox', { name: 'Search notes' })).toBeFocused();
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(page.locator('.workspace')).toBeVisible();
  expect((await page.locator('.workspace').boundingBox())!.width).toBeGreaterThanOrEqual(620);
});
test('browser preview supports writing, searching, reading, and theme changes', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome', exact: true })).toBeVisible();
  await expect(page.getByText('Preview · session only')).toBeVisible();
  await page.getByRole('button', { name: 'New note', exact: false }).first().click();
  const dialog = page.getByRole('dialog', { name: 'A new note' });
  await dialog.getByRole('textbox').fill('A test thought');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A test thought', exact: true })).toBeVisible();
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.type('\nA sentence worth finding.');
  await expect(page.getByText('Unsaved changes')).not.toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.locator('.reading-page')).toContainText('A sentence worth finding.');
  await page.getByRole('textbox', { name: 'Search notes' }).fill('worth finding');
  await expect(page.locator('.note-card')).toHaveCount(1);
  await page.getByRole('switch', { name: 'Dark mode' }).click();
  await expect(page.getByRole('switch', { name: 'Dark mode' })).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({
    path: 'test-results/notebook-dark.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Dark mode' })).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('switch', { name: 'Dark mode' }).click();
  await expect(page.getByRole('switch', { name: 'Dark mode' })).not.toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
test('links and preview security remain functional', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('tracking.example')) requests.push(r.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Toggle links panel' }).click();
  await expect(page.locator('.links-panel')).toContainText('A useful note');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page
    .locator('.reading-page')
    .getByRole('link', { name: 'A useful note', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'A useful note', exact: true }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(
    '# Safe preview\n\n<img src="https://tracking.example/pixel" onerror="alert(1)">\n\n![tracker](https://tracking.example/image.png)',
  );
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.locator('.reading-page')).toContainText('Remote image not loaded');
  expect(requests).toEqual([]);
});
test('appearance themes persist, preserve writing, and remember light and dark choices', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1320, height: 860 });
  await page.goto('/');
  const content = await page.locator('.cm-content').innerText();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Appearance', exact: true });
  await expect(dialog.getByRole('radio')).toHaveCount(5);
  await dialog.getByRole('radio', { name: /Charcoal/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.workspace')).toHaveCSS('background-color', 'rgb(32, 33, 36)');
  await page.screenshot({
    path: 'test-results/appearance-charcoal.png',
    fullPage: true,
    animations: 'disabled',
  });
  await dialog.getByRole('radio', { name: /Sepia/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sepia');
  await dialog.getByRole('radio', { name: /Midnight/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.cm-content')).toHaveText(content, { useInnerText: true });
  await page.screenshot({
    path: 'test-results/notebook-midnight.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  await expect(page.getByRole('switch', { name: 'Dark mode' })).toBeChecked();
  await page.getByRole('switch', { name: 'Dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sepia');
  await expect(page.getByRole('switch', { name: 'Dark mode' })).not.toBeChecked();
  await page.screenshot({
    path: 'test-results/notebook-sepia.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('switch', { name: 'Dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await dialog.getByRole('radio', { name: /Midnight/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('radio', { name: /Sepia/ })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Appearance', exact: true })).toBeFocused();
});
test('settings explain the preview and cannot pretend to connect Drive', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Google Drive Connect', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('unencrypted files');
  await expect(page.getByRole('link', { name: 'Create a Desktop app client' })).toHaveAttribute(
    'href',
    'https://console.cloud.google.com/auth/clients',
  );
  await expect(page.getByLabel('Import Google client JSON')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Set up Google sign-in', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Set up encryption', exact: true })).toBeDisabled();
  await page.screenshot({
    path: 'test-results/google-drive-setup.png',
    fullPage: true,
    animations: 'disabled',
  });
});
test('Nextcloud backup setup is discoverable and cannot upload from the browser preview', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Nextcloud backup', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Nextcloud backup', exact: true }).last(),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('WebDAV URL')).toBeDisabled();
  await expect(page.getByLabel('Nextcloud app password')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save & test connection' })).toBeDisabled();
  await page.getByLabel('WebDAV URL').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'test-results/nextcloud-backup.png',
    fullPage: true,
    animations: 'disabled',
  });
});
