# Dependency security checks

The 18 October 2026 remediation updates `rusqlite` to 0.40.2, which embeds SQLite 3.53.2, and locks Rustls 0.23.46. These address the SQLite and Rustls advisory matches found in the dependency scan. Native tests check the actual SQLite engine, reject schema-table rewriting, exercise search and open a synthetic index produced by the previous SQLite 3.46.0 engine without losing note identity, metadata, history or state.

SQLite connections enable `SQLITE_DBCONFIG_DEFENSIVE` and disable `SQLITE_DBCONFIG_TRUSTED_SCHEMA` before schema initialization. These are additional controls; they do not make an arbitrary database trustworthy or replace patching.

The Tauri updater retains its Rustls and system-proxy features. Its optional legacy Tauri v1 ZIP support is disabled, removing ZIP 4.6.1 and its three advisory matches. Native macOS tar.gz and current v2 installer paths remain available. Do not re-enable the legacy ZIP feature without reviewing a fixed dependency and testing that format. The established updater key, HTTPS endpoint and signed-version requirement are unchanged.

## Linux GLib backport

Tauri 2's GTK3 dependencies require GLib 0.18. A direct replacement with GLib 0.20 is not compatible with those APIs. `src-tauri/vendor/glib` preserves the verified, MIT-licensed 0.18.5 crate with the exact two-line upstream fix from [gtk-rs PR 1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343), addressing [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html). `SECURITY-PATCH.md` records the original archive checksum and patch provenance. No other upstream code is modified.

`[patch.crates-io]` selects this local source. Public source packaging includes its source and license. A Linux-only integration test exercises forward/reverse iteration, mixed ends, nth/last and empty input; Linux CI also runs it with optimizations because the original bug could surface in optimized builds.

Registry advisory scanners omit path dependencies, so a clean Cargo audit alone does not validate this backport. `npm run check:security` independently verifies the patched dependency minimums, local GLib resolution and SHA-256 of the reviewed iterator source (with line endings normalized for Windows). It rejects a return to registry GLib, a modified fix, unpatched Rustls/SQLite wrappers or vulnerable ZIP versions. CI and the Node test suite run this gate. Remove the backport only when the upstream platform stack supports a fixed GLib release, and review the gate at that time.

## Repeating checks

Run `npm run check:security`, `npm audit`, and a current `cargo audit --file src-tauri/Cargo.lock` with a fresh official RustSec advisory database. Use `cargo metadata` with the intended target to distinguish linked runtime dependencies from other platforms and build tools. Check the embedded SQLite version separately against its vendor/CVE records; Rust package advisories alone do not cover every bundled C-library CVE.

Run the core and native suites, strict Clippy, frontend tests/build and browser checks. Native fixtures are synthetic; use disposable notebook data for any packaged acceptance test. Dependency notices must be regenerated before source or binary distribution. The legacy-index fixture is test-only and is not part of app resources.

The repeat scan reports five maintenance warnings: `unsafe-libyaml` (runtime), and the Linux stack's `proc-macro-error`, `zvariant`, `zbus_names` and `zvariant_derive`. These are unmaintained-package notices, not remaining vulnerability or soundness alerts. A YAML migration needs frontmatter compatibility tests; the Linux D-Bus migration needs compatible upstream desktop/keyring support. They remain explicit follow-up work, without advisory ignore rules.
