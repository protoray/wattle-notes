# GLib 0.18.5 safety backport

This is the upstream MIT-licensed `glib` 0.18.5 crate, with its original version,
license and notices retained. Tauri 2's GTK3 stack requires this release family;
GLib 0.20 is not an API-compatible substitution.

The original crates.io archive SHA-256 is
`233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`.
The only upstream code modification is the two-line change in
`src/variant_iter.rs`: declare the output pointer mutable and pass `&mut p` to
`g_variant_get_child`.

Upstream fix: https://github.com/gtk-rs/gtk-rs-core/pull/1343
Merge commit: `05dff0ee696f9bcd8617cd48c4b812d046d440cb`
Advisory: https://rustsec.org/advisories/RUSTSEC-2024-0429.html

The root manifest patches crates.io resolution to this source. The crate is
included in public source archives and dependency notices. The application core
suite contains a Linux-only regression covering string-iterator operations;
Linux CI runs it with the normal storage tests. No vulnerability ignore rule is
used. A version-only scanner may still flag 0.18.5: inspect this backport rather
than treating that match as an unpatched registry copy. Remove this patch when
the upstream desktop stack permits a fixed GLib release.
