import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicLink, publicSourcePath } from '../scripts/prepare-launch.mjs';

test('public source snapshots exclude handoff, local preferences, credentials, notes and caches', () => {
  for (const path of [
    'docs/HANDOFF.md',
    'website/dist/downloads/app.zip',
    '.env',
    '.env.production',
    'src/../private.txt',
    'src/.notes/index.db',
    'src/secret.pem',
    'src/passwords.local.json',
    'node_modules/package/index.js',
    'scripts/__pycache__/verify-launch.pyc',
    'src-tauri/target/release/wattle-notes',
  ])
    assert.equal(publicSourcePath(path), false, path);
  for (const path of [
    'docs/security.md',
    'src/App.tsx',
    'src-tauri/Cargo.lock',
    '.github/workflows/ci.yml',
    '.gitignore',
    'website/launch.json',
  ])
    assert.equal(publicSourcePath(path), true, path);
});
test('optional public links must be explicit HTTPS destinations without embedded credentials', () => {
  assert.equal(publicLink(null, 'supportUrl'), null);
  assert.equal(publicLink('', 'supportUrl'), null);
  assert.equal(
    publicLink('https://example.test/support', 'supportUrl'),
    'https://example.test/support',
  );
  for (const url of [
    'javascript:alert(1)',
    'http://example.test',
    'https://user:password@example.test',
    'not-a-url',
  ])
    assert.throws(() => publicLink(url, 'supportUrl'));
});
