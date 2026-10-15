import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));

export function releaseEnvironment(environment) {
  const clientId = environment.GOOGLE_CLIENT_ID?.trim() ?? '';
  if (clientId.length > 512 || !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error(
      'Set GOOGLE_CLIENT_ID to the maintainer’s Google Desktop OAuth client ID before building a configured release. See docs/google-drive.md.',
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
    process.exitCode = buildRelease(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
