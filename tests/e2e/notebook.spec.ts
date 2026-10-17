import { test, expect } from '@playwright/test';
test('notebook deletion confirms the folder and restores its pages from local Trash', async ({
  page,
}) => {
  await page.goto('/');
  const notebooks = page.getByRole('region', { name: 'Notebooks and pages' });
  await expect(
    notebooks.getByRole('button', { name: 'Delete notebook My notebook', exact: true }),
  ).toHaveCount(0);
  await notebooks.getByRole('button', { name: 'Expand notebook Ideas', exact: true }).click();
  await notebooks.getByRole('button', { name: 'A useful note', exact: true }).click();
  await notebooks.getByRole('button', { name: 'Delete notebook Ideas', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this notebook?' });
  await expect(confirm).toContainText('all its subnotebooks, pages and files');
  await confirm.getByRole('button', { name: 'Keep notebook' }).click();
  await expect(notebooks.getByRole('button', { name: 'A useful note', exact: true })).toBeVisible();
  await notebooks.getByRole('button', { name: 'Delete notebook Ideas', exact: true }).click();
  await confirm.getByRole('button', { name: 'Delete notebook', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(notebooks.getByRole('button', { name: 'A useful note', exact: true })).toHaveCount(
    0,
  );
  await expect(
    notebooks.getByRole('button', { name: 'Delete notebook Ideas', exact: true }),
  ).toHaveCount(0);
  await expect(notebooks.getByRole('button', { name: 'Welcome', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings & tools', exact: true }).click();
  await page.getByRole('button', { name: 'History & trash', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'History & trash', exact: true });
  await expect(history.getByRole('heading', { name: 'Deleted notebooks' })).toBeVisible();
  await page.screenshot({ path: 'test-results/notebook-trash.png', fullPage: true });
  await history.getByRole('button', { name: 'Restore notebook Ideas' }).click();
  await expect(history.getByText('Notebook restored.', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Close dialog' }).click();
  await expect(notebooks.getByRole('button', { name: 'A useful note', exact: true })).toBeVisible();
  await notebooks.getByRole('button', { name: 'A useful note', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'A useful note', exact: true }).first(),
  ).toBeVisible();
});

test('compact notebooks and collapsed tools leave room to write at a small window size', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1320, height: 860 });
  await page.goto('/');
  const sidebar = page.getByRole('complementary');
  const notebooks = sidebar.getByRole('region', { name: 'Notebooks and pages' });
  await expect(sidebar.getByRole('textbox', { name: 'Search pages' })).toBeVisible();
  await expect(notebooks.getByRole('button', { name: 'Welcome', exact: true })).toBeVisible();
  await expect(notebooks.getByRole('button', { name: 'A useful note', exact: true })).toHaveCount(
    0,
  );
  await notebooks.getByRole('button', { name: 'Expand notebook Ideas', exact: true }).click();
  await expect(notebooks.getByRole('button', { name: 'A useful note', exact: true })).toBeVisible();
  await notebooks.getByRole('button', { name: 'Collapse notebook Ideas', exact: true }).click();
  await expect(notebooks.getByRole('button', { name: 'A useful note', exact: true })).toHaveCount(
    0,
  );
  await expect(sidebar.getByRole('button', { name: 'Settings & tools' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(sidebar.getByRole('button', { name: 'History & trash' })).toBeHidden();
  await expect(sidebar.locator('.notebook-page p')).toHaveCount(0);
  const menuBounds = await sidebar.boundingBox();
  const writingBounds = await page.locator('.workspace').boundingBox();
  expect(menuBounds!.width).toBeLessThanOrEqual(320);
  expect(writingBounds!.width).toBeGreaterThanOrEqual(990);
  await page.screenshot({ path: 'test-results/notebook-combined.png', fullPage: true });
  await page.getByRole('button', { name: 'Toggle notebook sidebar' }).click();
  await expect(sidebar).not.toBeVisible();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  await expect(sidebar.getByRole('textbox', { name: 'Search pages' })).toBeFocused();
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(page.locator('.workspace')).toBeVisible();
  expect((await page.locator('.workspace').boundingBox())!.width).toBeGreaterThanOrEqual(620);
  await expect(notebooks.getByRole('button', { name: 'Welcome', exact: true })).toBeVisible();
  const captionBounds = await sidebar.getByText('Preview · session only').boundingBox();
  expect(captionBounds!.y + captionBounds!.height).toBeLessThanOrEqual(600);
  const pageBounds = await notebooks
    .getByRole('button', { name: 'Welcome', exact: true })
    .boundingBox();
  expect(pageBounds!.height).toBeLessThanOrEqual(40);
  await page.screenshot({ path: 'test-results/notebook-compact-900.png', fullPage: true });
});

test('pages belong to the selected notebook and search reaches pages in other notebooks', async ({
  page,
}) => {
  await page.goto('/');
  const notebooks = page.getByRole('region', { name: 'Notebooks and pages' });
  await notebooks.getByRole('button', { name: /^Ideas / }).click();
  await expect(notebooks.getByRole('button', { name: /^Ideas / })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(notebooks.getByRole('button', { name: 'A useful note', exact: true })).toBeVisible();
  await notebooks.getByRole('button', { name: 'New page', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'A new page' });
  await expect(dialog).toContainText('Saved in Ideas');
  await dialog.getByRole('textbox').fill('Notebook page');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const created = notebooks.getByRole('button', { name: 'Notebook page', exact: true });
  await expect(created).toHaveAttribute('title', 'Ideas/Notebook page.md');
  await expect(created).toHaveAttribute('aria-current', 'page');
  await notebooks.getByRole('button', { name: 'Collapse notebook Ideas', exact: true }).click();
  await expect(created).toHaveCount(0);
  await notebooks.getByRole('button', { name: 'Expand notebook Ideas', exact: true }).click();
  await expect(created).toBeVisible();
  await page.getByRole('textbox', { name: 'Search pages' }).fill('Read slowly');
  await expect(notebooks.locator('.notebook-page-button')).toHaveCount(1);
  await notebooks.getByRole('button', { name: 'Reading list', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Reading list', exact: true }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(
    notebooks.getByRole('button', { name: 'Reading list', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    notebooks.getByRole('button', { name: 'Collapse notebook Reading', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
});
test('tags filter pages across notebooks and leave the selected page reachable', async ({
  page,
}) => {
  await page.goto('/');
  const notebooks = page.getByRole('region', { name: 'Notebooks and pages' });
  await page.getByText('Tags', { exact: true }).click();
  const writingTag = page.locator('.tag-list').getByRole('button', { name: /writing/ });
  await writingTag.click();
  await expect(notebooks.locator('.notebook-page-button')).toHaveCount(1);
  await notebooks.getByRole('button', { name: 'A useful note', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'A useful note', exact: true }).first(),
  ).toBeVisible();
  await writingTag.click();
  await expect(
    notebooks.getByRole('button', { name: 'A useful note', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    notebooks.getByRole('button', { name: 'Collapse notebook Ideas', exact: true }),
  ).toBeVisible();
});

test('utility disclosure works from the keyboard and remembers its compact state', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/');
  const tools = page.getByRole('button', { name: 'Settings & tools', exact: true });
  await tools.focus();
  await page.keyboard.press('Enter');
  await expect(tools).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'History & trash', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'History & trash', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'History & trash', exact: true })).toBeFocused();
  await tools.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'History & trash', exact: true })).toBeHidden();
  await page.reload();
  await expect(tools).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeHidden();
});

test('expanded tags and tools keep notebooks and every utility reachable at 900 by 600', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/');
  const notebooks = page.getByRole('region', { name: 'Notebooks and pages' });
  await notebooks.getByRole('button', { name: 'Expand notebook Ideas', exact: true }).click();
  await notebooks.getByRole('button', { name: 'Expand notebook Reading', exact: true }).click();
  await notebooks.getByRole('button', { name: 'A useful note', exact: true }).click();
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page.getByText('Tags', { exact: true }).click();
  await page.getByRole('button', { name: 'Settings & tools', exact: true }).click();
  const navigation = notebooks.getByRole('navigation', { name: 'Notebook pages' });
  expect((await navigation.boundingBox())!.height).toBeGreaterThanOrEqual(70);
  const caption = await page.getByText('Preview · session only').boundingBox();
  expect(caption!.y + caption!.height).toBeLessThanOrEqual(600);
  const controls = page.locator('.sidebar-utilities-controls');
  expect(await controls.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Your notebook settings', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: 'Appearance', exact: true });
  await expect(appearance.getByRole('radio')).toHaveCount(5);
  await appearance.getByRole('button', { name: 'Done', exact: true }).click();
  const darkMode = page.getByRole('switch', { name: 'Dark mode', exact: true });
  await darkMode.scrollIntoViewIfNeeded();
  await expect(darkMode).toBeInViewport();
  await expect(darkMode).not.toBeChecked();
  expect(await controls.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({
    path: 'test-results/notebook-both-expanded-900.png',
    animations: 'disabled',
  });
});

test('browser preview supports writing, searching, reading, and theme changes', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome', exact: true })).toBeVisible();
  await expect(page.getByText('Preview · session only')).toBeVisible();
  await page.getByRole('button', { name: 'New page', exact: false }).first().click();
  const dialog = page.getByRole('dialog', { name: 'A new page' });
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
  await page.getByRole('textbox', { name: 'Search pages' }).fill('worth finding');
  await expect(page.locator('.notebook-page-button')).toHaveCount(1);
  await page.getByRole('button', { name: 'Settings & tools', exact: true }).click();
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
    .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
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
  await page.getByRole('button', { name: 'Settings & tools', exact: true }).click();
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
  await page.getByRole('button', { name: 'Settings & tools', exact: true }).click();
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
  await page.getByRole('button', { name: 'Settings & tools', exact: true }).click();
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
