import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { updateManifest } from '../scripts/prepare-update.mjs';

const signature = Buffer.from(
  'untrusted comment: synthetic test\nRWfake\ntrusted comment: test\tversion:0.1.2\nfake\n',
).toString('base64');
test('updater manifest pins the alpha asset and includes the signature content', () => {
  const feed = updateManifest({
    version: '0.1.2',
    tag: 'v0.1.2-alpha.1',
    signature,
    date: '2026-10-16T00:00:00Z',
  });
  assert.deepEqual(Object.keys(feed.platforms), ['darwin-aarch64']);
  assert.equal(
    feed.platforms['darwin-aarch64'].url,
    'https://github.com/protoray/wattle-notes/releases/download/v0.1.2-alpha.1/wattle-notes-macos-arm64.app.tar.gz',
  );
  assert.equal(feed.platforms['darwin-aarch64'].signature, signature);
});
test('manifest refuses mismatched tags, signature URLs and invalid versions', () => {
  for (const value of [
    { version: '0.1.2', tag: 'v0.1.1-alpha.1', signature },
    { version: '../0.1.2', tag: 'v0.1.2-alpha.1', signature },
    { version: '0.1.2', tag: 'v0.1.2-alpha.1', signature: 'https://example.org/file.sig' },
  ])
    assert.throws(() => updateManifest(value));
});
test('native updater trusts the dedicated HTTPS alpha feed with an embedded public key', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url)));
  assert.deepEqual(config.plugins.updater.endpoints, [
    'https://raw.githubusercontent.com/protoray/wattle-notes/main/updates/alpha.json',
  ]);
  assert.ok(
    Buffer.from(config.plugins.updater.pubkey, 'base64')
      .toString()
      .startsWith('untrusted comment:'),
  );
  assert.equal(config.plugins.updater.dangerousInsecureTransportProtocol, undefined);
  assert.equal(config.plugins.updater.requireSignedVersion, true);
});
