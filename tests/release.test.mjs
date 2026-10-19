import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRelease,
  loadReleaseEnvironment,
  releaseEnvironment,
} from '../scripts/build-release.mjs';
import { verifyGoogleBuild } from '../scripts/verify-google-build.mjs';

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

test('VM builds load an explicit Desktop JSON without mixing in another client', () => {
  const environment = { GOOGLE_CLIENT_JSON: '/synthetic/client.json', PATH: '/test/toolchain' };
  const configured = loadReleaseEnvironment(environment, (path) => {
    assert.equal(path, environment.GOOGLE_CLIENT_JSON);
    return Buffer.from(
      JSON.stringify({ installed: { client_id: clientId, client_secret: 'desktop-value' } }),
    );
  });
  assert.equal(configured.GOOGLE_CLIENT_ID, clientId);
  assert.equal(configured.GOOGLE_CLIENT_SECRET, 'desktop-value');
  assert.equal(configured.PATH, environment.PATH);
  assert.equal(environment.GOOGLE_CLIENT_ID, undefined);
  assert.equal(
    loadReleaseEnvironment({ GOOGLE_CLIENT_ID: clientId }, () => {
      throw new Error('Must not read a different client');
    }).GOOGLE_CLIENT_SECRET,
    '',
  );
});

test('maintainer builds find the ignored local Desktop client on any host OS', () => {
  const configured = loadReleaseEnvironment({}, (path) => {
    assert.match(
      path.replaceAll('\\', '/'),
      /release\/private\/google-desktop-client\.local\.json$/,
    );
    return JSON.stringify({ installed: { client_id: clientId } });
  });
  assert.equal(configured.GOOGLE_CLIENT_ID, clientId);
});

test('missing or invalid Desktop JSON fails closed without echoing its contents', () => {
  const marker = 'SYNTHETIC-PRIVATE-INPUT';
  for (const source of [
    marker,
    '{}',
    JSON.stringify({ web: { client_id: clientId } }),
    JSON.stringify({ type: 'service_account', private_key: marker }),
    JSON.stringify({ installed: { client_id: clientId, client_secret: 123 } }),
    JSON.stringify({ installed: { client_id: marker } }),
    'x'.repeat(65537),
  ]) {
    assert.throws(
      () => loadReleaseEnvironment({}, () => source),
      (error) => !error.message.includes(marker),
    );
  }
  const missing = () => {
    throw Object.assign(new Error(marker), { code: 'ENOENT' });
  };
  assert.throws(() => loadReleaseEnvironment({}, missing), /Set GOOGLE_CLIENT_ID/);
  assert.throws(
    () => loadReleaseEnvironment({ GOOGLE_CLIENT_JSON: marker }, missing),
    (error) => error.message.includes('Cannot load') && !error.message.includes(marker),
  );
});

test('native build verification rejects missing or mismatched client parameters', () => {
  const environment = { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: 'synthetic-secret' };
  const configured = Buffer.from(`native executable ${clientId} synthetic-secret`);
  assert.equal(verifyGoogleBuild(configured, environment), true);
  assert.equal(verifyGoogleBuild(Buffer.from(clientId), { GOOGLE_CLIENT_ID: clientId }), true);
  assert.throws(() => verifyGoogleBuild(Buffer.from('unconfigured'), environment), /client ID/);
  assert.throws(() => verifyGoogleBuild(Buffer.from(clientId), environment), /client parameter/);
  assert.throws(() => verifyGoogleBuild(configured, {}), /Set GOOGLE_CLIENT_ID/);
});

test('configured CLI preflight and binary gate work with a VM JSON path and fail before compiling', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wattle-google-build-'));
  try {
    const client = join(directory, 'client.local.json');
    const binary = join(directory, 'synthetic.exe');
    writeFileSync(
      client,
      JSON.stringify({ installed: { client_id: clientId, client_secret: 'synthetic-secret' } }),
    );
    writeFileSync(binary, `native ${clientId} synthetic-secret`);
    const env = {
      ...process.env,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GOOGLE_CLIENT_JSON: client,
    };
    const run = (script, args, environment = env) =>
      spawnSync(process.execPath, [script, ...args], {
        env: environment,
        encoding: 'utf8',
        shell: false,
      });
    assert.equal(run('scripts/build-release.mjs', ['--check-config']).status, 0);
    assert.equal(run('scripts/verify-google-build.mjs', [binary]).status, 0);
    writeFileSync(binary, 'unconfigured native executable');
    assert.equal(run('scripts/verify-google-build.mjs', [binary]).status, 1);
    const failed = run('scripts/build-release.mjs', [], {
      ...env,
      GOOGLE_CLIENT_JSON: join(directory, 'missing.json'),
    });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Cannot load Google Desktop client JSON/);
    assert.doesNotMatch(failed.stdout + failed.stderr, /synthetic-secret|Starting|Compiling/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
