import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// A Rust/linker signature on the executable alone does not seal an app bundle.
// Updater signatures also do not replace macOS bundle code signing.
export function verifyMacBundle(app) {
  const seal = lstatSync(join(app, 'Contents/_CodeSignature/CodeResources'), {
    throwIfNoEntry: false,
  });
  if (!seal?.isFile() || seal.isSymbolicLink())
    throw new Error('The macOS app must have a regular bundle resource seal.');
  const result = spawnSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', app],
    { encoding: 'utf8', shell: false },
  );
  if (result.error || result.status !== 0)
    throw new Error('macOS bundle signature verification failed. Rebuild before packaging.');
}
