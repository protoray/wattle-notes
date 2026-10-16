import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleBuildConfigured, publicLink, publicSourcePath } from '../scripts/prepare-launch.mjs';

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

test('configured packaging verifies the public Google client is in the actual native binary', () => {
  const clientId = '123-release.apps.googleusercontent.com';
  const binary = Buffer.from(`synthetic native data: ${clientId}`);
  assert.equal(googleBuildConfigured(binary, { GOOGLE_CLIENT_ID: clientId }), true);
  assert.equal(googleBuildConfigured(Buffer.from('unconfigured build'), {}), false);
  assert.throws(() => googleBuildConfigured(binary, {}), /same GOOGLE_CLIENT_ID/);
  assert.throws(
    () => googleBuildConfigured(Buffer.from('wrong build'), { GOOGLE_CLIENT_ID: clientId }),
    /does not contain/,
  );
  assert.throws(
    () => googleBuildConfigured(binary, { GOOGLE_CLIENT_ID: 'invalid-private-input' }),
    (error) => !error.message.includes('invalid-private-input'),
  );
});
