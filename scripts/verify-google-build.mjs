import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReleaseEnvironment, releaseEnvironment } from './build-release.mjs';

export function verifyGoogleBuild(binary, environment) {
  const checked = releaseEnvironment(environment);
  if (!binary.includes(Buffer.from(checked.GOOGLE_CLIENT_ID)))
    throw new Error('Native executable does not contain the configured Google client ID.');
  if (checked.GOOGLE_CLIENT_SECRET && !binary.includes(Buffer.from(checked.GOOGLE_CLIENT_SECRET)))
    throw new Error('Native executable does not contain the configured Desktop client parameter.');
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3)
      throw new Error('Pass the path to the compiled native executable.');
    const environment = loadReleaseEnvironment();
    let binary;
    try {
      binary = readFileSync(process.argv[2]);
    } catch {
      throw new Error('Cannot read the compiled native executable.');
    }
    verifyGoogleBuild(binary, environment);
    console.log('Native executable contains the configured Google Desktop client parameters.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
