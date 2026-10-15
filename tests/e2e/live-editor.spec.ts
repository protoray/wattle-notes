import { test, expect } from '@playwright/test';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('Read supports rendered editing, formatting, undo and source preservation across note navigation', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New note', exact: false }).first().click();
  const dialog = page.getByRole('dialog', { name: 'A new note' });
  await dialog.getByRole('textbox').fill('Live editing');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const source =
    '# Title\n\nA **bold** sentence.\n\n- item\n\n[[A useful note]]\n\n```md\n[[literal]]\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<div>keep me</div>';
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText(source);
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: 'Markdown formatting' })).toBeVisible();
  await expect(page.locator('.cm-live-h1')).toHaveText(' Title');
  await expect(page.locator('.cm-live-bold')).toHaveText('bold');
  await expect(page.locator('.reading-page a').first()).toHaveText('A useful note');
  // Put caret in a visible paragraph and edit without switching to the source view.
  await page.locator('.cm-line').filter({ hasText: 'sentence.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' Added in Read.');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.keyboard.insertText('direct');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(editor).not.toContainText('direct');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(editor).toContainText('direct');
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await expect(editor).toContainText('Added in Read.**direct**');
  await expect(editor).toContainText('```md\n[[literal]]\n```', { useInnerText: true });
  await expect(editor).toContainText('| a | b |\n|---|---|\n| 1 | 2 |', { useInnerText: true });
  await expect(editor).toContainText('<div>keep me</div>');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page
    .locator('.reading-page a')
    .first()
    .click({ modifiers: [mod] });
  await expect(
    page.getByRole('heading', { name: 'A useful note', exact: true }).first(),
  ).toBeVisible();
  await page.locator('.note-card').filter({ hasText: 'Live editing' }).click();
  await expect(editor).toContainText('Added in Read.');
  await page.screenshot({ path: 'test-results/read-live-editor.png', fullPage: true });
});

test('Read keyboard formatting and task checkboxes update ordinary Markdown', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('.cm-content');
  for (const [key, marker] of [
    ['b', '**'],
    ['i', '*'],
  ] as const) {
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await editor.click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.insertText('# Shortcuts\n\nword');
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await page
      .locator('.cm-line')
      .filter({ hasText: /^word$/ })
      .click();
    await page.keyboard.press('End');
    await page.keyboard.press(`${mod}+${key}`);
    await page.keyboard.insertText('formatted');
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await expect(editor).toContainText(`word${marker}formatted${marker}`);
  }
  await editor.click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText('# Tasks\n\n- [ ] Take a note');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Mark task complete' }).check();
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await expect(editor).toContainText('- [x] Take a note');
});

test('view switches preserve source edits, selection and undo history', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText('# Persistent\n\nA paragraph.');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page
    .locator('.cm-line')
    .filter({ hasText: /^A paragraph\.$/ })
    .click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' From Read.');
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await editor.click();
  await page.keyboard.press(`${mod}+z`);
  await expect(editor).not.toContainText('From Read.');
  await expect(editor).toContainText('A paragraph.');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(page.locator('.preview-pane')).toContainText('A paragraph.');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(editor).toContainText('From Read.');
});
