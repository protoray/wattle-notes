import { test, expect } from '@playwright/test';

test('notes, rendered images and connection settings stay usable during a long sync', async ({
  page,
}) => {
  await page.addInitScript(() => Object.assign(window, { isTauri: true }));
  await page.route('**/src/main.tsx', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import { mockIPC } from '/node_modules/@tauri-apps/api/mocks.js';
      import App from '/src/App.tsx';
      import '/src/styles.css';
      const notes = Array.from({length:100}, (_,i) => ({id:'note-'+i,path:'Imported/Page '+i+'.md',title:'Page '+i,content:'# Page '+i+'\\n\\n![Photo](../attachments/photo.png)\\n',hash:'initial',tags:[],modified:100-i}));
      let syncing = false;
      let finish;
      const status = () => ({state:syncing?'syncing':'synced',pending:syncing?200:0,conflicts:0,last_sync:null,message:null});
      const info = () => ({root:'synthetic-sync-fixture',name:'Synthetic notebook',notes,folders:['Imported','attachments'],status:status()});
      document.addEventListener('qa-finish-sync', () => { syncing=false; finish?.(status()); });
      mockIPC((command,args) => {
        if(command==='last_vault') return 'synthetic-sync-fixture';
        if(command==='open_vault'||command==='vault_info') return info();
        if(command==='account_info') return {connected:true,encrypted:true,unlocked:true,bundled_client:true,settings:{client_id:'123-fixture.apps.googleusercontent.com',client_secret:null}};
        if(command==='note_links') return {outbound:[],backlinks:[]};
        if(command==='sync_now') { if(syncing) throw new Error('Duplicate sync'); syncing=true; return new Promise(resolve => {finish=resolve}); }
        if(command==='sync_progress') return syncing?{stage:'Uploading attachments',completed:3,total:100}:null;
        if(command==='attachment_bytes') return {bytes:Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0)),mime_type:'image/png'};
        if(command==='save_note') { const note=notes.find(n=>n.id===args.id); note.content=args.content; note.hash='saved'; document.documentElement.dataset.qaSaved=note.content; return {...note}; }
        if(command==='plugin:event|listen') return 1;
        return null;
      });
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
    `,
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.getByText('Syncing… 3/100', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  const image = page.getByAltText('Photo', { exact: true });
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(1);
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await page.locator('.cm-content[contenteditable=true]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\nEdited while sync is waiting.');
  await expect(page.locator('html')).toHaveAttribute(
    'data-qa-saved',
    /Edited while sync is waiting/,
  );
  await expect(page.getByText('Syncing… 3/100', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings & tools', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Google Drive connected', { exact: true })).toBeVisible();
  await expect(page.getByText('Loading Google connection settings…', { exact: true })).toHaveCount(
    0,
  );
  const progress = page.getByRole('progressbar', { name: 'Google Drive sync progress' });
  await expect(progress).toHaveAttribute('value', '3');
  await progress.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/sync-progress-settings.png', fullPage: true });
  await page.evaluate(() => document.dispatchEvent(new Event('qa-finish-sync')));
  await expect(progress).toHaveCount(0);
});
