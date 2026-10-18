import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cargo/OSV registry scans do not cover locally patched sources. Keep the
// upstream backport's reviewed bytes and dependency minimums independently gated.
export function checkSecurityBaseline(lock, manifest, glibSource) {
  const packages = lock
    .split('[[package]]')
    .slice(1)
    .map((block) => ({
      name: block.match(/^name = "([^"]+)"/m)?.[1],
      version: block.match(/^version = "([^"]+)"/m)?.[1],
      source: block.match(/^source = "([^"]+)"/m)?.[1],
    }));
  const minimum = (name, floor, required = true) => {
    const matches = packages.filter((pkg) => pkg.name === name);
    assert.ok(!required || matches.length, `${name} is missing`);
    for (const pkg of matches) {
      const version = pkg.version
        ?.match(/^(\d+)\.(\d+)\.(\d+)$/)
        ?.slice(1)
        .map(Number);
      assert.ok(version, `${name} must use a stable version`);
      const firstDifference = version.findIndex((part, index) => part !== floor[index]);
      assert.ok(
        firstDifference < 0 || version[firstDifference] > floor[firstDifference],
        `${name} ${pkg.version} is below the security baseline ${floor.join('.')}`,
      );
    }
  };
  minimum('rustls', [0, 23, 46]);
  minimum('libsqlite3-sys', [0, 38, 2]);
  minimum('zip', [9, 0, 0], false);
  const glib = packages.filter((pkg) => pkg.name === 'glib');
  assert.equal(glib.length, 1, 'Review changed GLib resolution');
  assert.equal(glib[0].source, undefined, 'GLib must resolve to the reviewed local backport');
  assert.match(
    manifest,
    /\[patch\.crates-io\][\s\S]*glib\s*=\s*\{\s*path\s*=\s*"vendor\/glib"\s*\}/,
  );
  assert.equal(
    createHash('sha256').update(glibSource.toString().replaceAll('\r\n', '\n')).digest('hex'),
    'a0f5ee8acb8faa089bcdfbc9a57372609fce7654026ccef7d9a224d05a654ccc',
    'GLib backport differs from the reviewed upstream safety fix',
  );
}

export function checkWorkspaceSecurity() {
  const root = new URL('../', import.meta.url);
  checkSecurityBaseline(
    readFileSync(new URL('src-tauri/Cargo.lock', root), 'utf8'),
    readFileSync(new URL('src-tauri/Cargo.toml', root), 'utf8'),
    readFileSync(new URL('src-tauri/vendor/glib/src/variant_iter.rs', root)),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkWorkspaceSecurity();
  console.log('Dependency security minimums and reviewed GLib safety backport verified.');
}
