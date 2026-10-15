# Security model

Cloud confidentiality covers note bodies, tags, attachment bytes, and revision payloads. Filenames, directory names, object identities, ciphertext sizes, timestamps, and sync activity are visible to Google. TLS protects transport in addition to application encryption. Nextcloud backups encrypt internal filenames, current files, and local database/history as a full snapshot; only archive names, wrapped keys, identities, sizes, and activity remain visible to that server.

Local notes, attachments, history snapshots, and the SQLite index are **plaintext**. Use operating-system disk encryption and backups for device protection. A sync lock is not a local vault lock. An unlocked or compromised device can read notes and keys.

The renderer can edit notes but cannot retrieve the master encryption key or refresh token. Key material is held in Rust and zeroized on drop; optional persistence uses the OS credential store. OAuth opens the system browser, uses PKCE/state, and has a timeout. Public-client parameters are not treated as a security boundary.

Preview sanitization strips active content. Remote Markdown images and raw HTML images are not automatically loaded. Native image loading is limited to selected-vault paths, a safe raster extension list, and 10 MiB. Content Security Policy blocks external scripts, frames, objects, and preview resource connections. External links require a click and are limited to HTTP(S) or mailto.

Vault operations reject absolute paths, traversal, symlinks, reserved Windows names, and case-equivalent collisions. Remote encrypted content is authenticated and validated before materialization. Missing or malformed history pauses affected work and retains local data. Immutable history and deterministic merging reduce concurrent-write loss; there is no last-writer-wins policy based on clocks.

Encryption does not prevent a storage provider from withholding or deleting files. Existing devices detect missing known history; a fresh device cannot prove the server supplied every historical revision. Keep independent local backups. v1 does not provide cross-device cryptographic rollback/freshness guarantees.

This is an alpha implementation, not an independently audited security product. The automated suite exercises synthetic corruption and recovery; production OAuth, credential stores, Drive interruptions, and packaged platform behavior require the documented release checks.

Nextcloud requires HTTPS, disables redirects to prevent credential forwarding, and stores its app password only in the OS credential store. Backups are encrypted before upload. Restore authenticates all files in a private staging directory, validates paths and resource limits, rebuilds the index, then publishes a separate folder. WebDAV does not implement automatic multi-device synchronization. See `nextcloud.md` for limits and live acceptance checks.
