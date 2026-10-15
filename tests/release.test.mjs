import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRelease, releaseEnvironment } from '../scripts/build-release.mjs';

const clientId = '123-release.apps.googleusercontent.com';

test('configured releases fail before starting a build without a usable client ID', () => {
  for (const id of [
    undefined,
    '',
    '   ',
    'not-a-client',
    'https://untrusted.invalid',
    `${'x'.repeat(513)}.apps.googleusercontent.com`,
  ]) {
    let spawned = false;
    assert.throws(
      () =>
        buildRelease([], { GOOGLE_CLIENT_ID: id }, () => {
          spawned = true;
        }),
      /Set GOOGLE_CLIENT_ID/,
    );
    assert.equal(spawned, false);
  }
});

test('release validation never echoes invalid client parameters', () => {
  const marker = 'SYNTHETIC-PRIVATE-INPUT';
  assert.throws(
    () => releaseEnvironment({ GOOGLE_CLIENT_ID: marker }),
    (error) => !error.message.includes(marker),
  );
  for (const secret of [marker.repeat(500), `${marker}\nvalue`, `${marker}\0value`]) {
    assert.throws(
      () => releaseEnvironment({ GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: secret }),
      (error) => !error.message.includes(marker),
    );
  }
});

test('release builds pass client configuration through the environment without a shell', () => {
  const environment = {
    GOOGLE_CLIENT_ID: ` ${clientId} `,
    GOOGLE_CLIENT_SECRET: 'synthetic-desktop-parameter',
    PATH: '/test/toolchain',
  };
  const code = buildRelease(['--bundles', 'app'], environment, (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args.slice(1), ['build', '--bundles', 'app']);
    assert.equal(
      args.some((arg) => arg.includes(clientId) || arg.includes(environment.GOOGLE_CLIENT_SECRET)),
      false,
    );
    assert.equal(options.env.GOOGLE_CLIENT_ID, clientId);
    assert.equal(options.env.GOOGLE_CLIENT_SECRET, environment.GOOGLE_CLIENT_SECRET);
    assert.equal(options.env.PATH, environment.PATH);
    assert.equal(options.shell, false);
    return { status: 0 };
  });
  assert.equal(code, 0);
  assert.equal(environment.GOOGLE_CLIENT_ID, ` ${clientId} `);
});

test('client secret is optional and build failures are propagated', () => {
  assert.equal(releaseEnvironment({ GOOGLE_CLIENT_ID: clientId }).GOOGLE_CLIENT_SECRET, '');
  assert.equal(
    buildRelease([], { GOOGLE_CLIENT_ID: clientId }, () => ({ status: 7 })),
    7,
  );
  assert.equal(
    buildRelease([], { GOOGLE_CLIENT_ID: clientId }, () => ({ status: null, signal: 'SIGTERM' })),
    1,
  );
  assert.throws(
    () =>
      buildRelease([], { GOOGLE_CLIENT_ID: clientId }, () => ({
        error: new Error('synthetic spawn failure'),
      })),
    /Could not start/,
  );
});
