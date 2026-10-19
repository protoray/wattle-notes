import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));

export function releaseEnvironment(environment) {
  const clientId = environment.GOOGLE_CLIENT_ID?.trim() ?? '';
  if (clientId.length > 512 || !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error(
      'Set GOOGLE_CLIENT_ID or GOOGLE_CLIENT_JSON to the maintainer’s Google Desktop OAuth client before building a configured release. See docs/google-drive.md.',
    );
  }
  const clientSecret = environment.GOOGLE_CLIENT_SECRET ?? '';
  if (clientSecret.length > 4096 || /[\r\n\0]/.test(clientSecret)) {
    throw new Error(
      'GOOGLE_CLIENT_SECRET must be a Desktop client parameter, up to 4096 characters.',
    );
  }
  return { ...environment, GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret };
}

export function loadReleaseEnvironment(environment = process.env, read = readFileSync) {
  // Explicit environment parameters take precedence as a pair: never mix clients.
  if (environment.GOOGLE_CLIENT_ID?.trim() || environment.GOOGLE_CLIENT_SECRET)
    return releaseEnvironment(environment);
  const path =
    environment.GOOGLE_CLIENT_JSON ||
    resolve(root, 'release/private/google-desktop-client.local.json');
  let client;
  try {
    const source = read(path);
    if (source.length > 64 * 1024) throw new Error('Oversized client file');
    const json = JSON.parse(source.toString());
    if (json.web || !json.installed || typeof json.installed.client_id !== 'string')
      throw new Error('Not a Desktop client');
    if (
      json.installed.client_secret !== undefined &&
      typeof json.installed.client_secret !== 'string'
    )
      throw new Error('Invalid Desktop client parameter');
    client = json.installed;
  } catch (error) {
    if (error.code === 'ENOENT' && !environment.GOOGLE_CLIENT_JSON)
      return releaseEnvironment(environment);
    throw new Error(
      'Cannot load Google Desktop client JSON. Check GOOGLE_CLIENT_JSON or the ignored local client file.',
    );
  }
  return releaseEnvironment({
    ...environment,
    GOOGLE_CLIENT_ID: client.client_id,
    GOOGLE_CLIENT_SECRET: client.client_secret ?? '',
  });
}

export function buildRelease(args, environment, spawn = spawnSync) {
  // Validate before starting any build. Client values are passed as environment variables,
  // never shell arguments; neither this script nor its error messages print them.
  const env = releaseEnvironment(environment);
  const result = spawn(
    process.execPath,
    [require.resolve('@tauri-apps/cli/tauri.js'), 'build', ...args],
    {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: false,
    },
  );
  if (result.error)
    throw new Error('Could not start the desktop build. Check Node and the Tauri toolchain.');
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const environment = loadReleaseEnvironment();
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--check-config')
      console.log('Google Desktop client build configuration is valid.');
    else process.exitCode = buildRelease(args, environment);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
