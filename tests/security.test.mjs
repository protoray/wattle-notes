import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  checkSecurityBaseline,
  checkWorkspaceSecurity,
} from '../scripts/check-security-baseline.mjs';

const root = new URL('../', import.meta.url);
const lock = readFileSync(new URL('src-tauri/Cargo.lock', root), 'utf8').replaceAll('\r\n', '\n');
const manifest = readFileSync(new URL('src-tauri/Cargo.toml', root), 'utf8');
const glib = readFileSync(new URL('src-tauri/vendor/glib/src/variant_iter.rs', root));

test('workspace uses patched dependencies and the reviewed GLib backport', checkWorkspaceSecurity);
test('security gate rejects a vulnerable TLS dependency or old SQLite wrapper', () => {
  assert.throws(
    () =>
      checkSecurityBaseline(
        lock.replace(
          'name = "rustls"\nversion = "0.23.46"',
          'name = "rustls"\nversion = "0.23.45"',
        ),
        manifest,
        glib,
      ),
    /rustls/,
  );
  assert.throws(
    () =>
      checkSecurityBaseline(
        lock.replace(
          'name = "libsqlite3-sys"\nversion = "0.38.2"',
          'name = "libsqlite3-sys"\nversion = "0.30.1"',
        ),
        manifest,
        glib,
      ),
    /libsqlite3-sys/,
  );
});
test('security gate rejects reintroduced vulnerable ZIP extraction', () => {
  assert.throws(
    () =>
      checkSecurityBaseline(
        lock + '\n[[package]]\nname = "zip"\nversion = "4.6.1"\n',
        manifest,
        glib,
      ),
    /zip/,
  );
});
test('security gate rejects the unpatched GLib registry source or a changed safety fix', () => {
  assert.throws(
    () =>
      checkSecurityBaseline(
        lock.replace(
          'name = "glib"\nversion = "0.18.5"',
          'name = "glib"\nversion = "0.18.5"\nsource = "registry+https://github.com/rust-lang/crates.io-index"',
        ),
        manifest,
        glib,
      ),
    /GLib/,
  );
  assert.throws(
    () => checkSecurityBaseline(lock, manifest, glib.toString().replace('&mut p,', '&p,')),
    /GLib backport/,
  );
});
