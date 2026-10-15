# Encrypted format v1

Use established XChaCha20-Poly1305 and Argon2id implementations. All numbers and field names below are versioned protocol decisions. Unsupported versions fail closed without changing local files.

## Vault configuration

`vault.json` contains version `1`, a random UUID vault identity, a 16-byte random salt encoded with standard base64, Argon2id memory `65536` KiB, iterations `3`, lanes `1`, and two base64-encoded encrypted master-key envelopes. The master key is 32 random bytes.

Argon2id v0x13 derives a 32-byte wrapping key from the vault passphrase. An independently generated 32-byte recovery wrapping key is shown as `NN1-` followed by 64 hexadecimal characters. Both wrappers encrypt the same master key. The recovery key itself is never stored in Drive or application settings. Passwords are checked against a 12-character minimum during setup.

Only the fixed supported KDF parameters and salt length are accepted, preventing malicious configurations from requesting unbounded memory. Changing passphrases or revoking recovery keys is outside v1; old encrypted configuration copies would need explicit consideration in any migration.

## Metadata and note envelopes

The JSON envelope has `magic: NEWNOTES1`, `identity`, `nonce`, and `ciphertext`. Nonce and ciphertext are standard base64. `identity` contains, in serialization order: `version`, `vault_id`, `item_id`, `revision_id`, and `purpose`.

The UTF-8 compact JSON serialization of identity is AEAD associated data. A fresh 24-byte random nonce is generated per envelope. The ciphertext includes the 16-byte authentication tag. The expected identity must be supplied independently from the Drive object properties and match exactly before decryption.

Purpose values are `revision`, `mirror`, `passphrase`, and `recovery`. Wrapped-key identities use item `vault-key` and revision `setup`. Revision plaintext is the complete JSON revision; mirror plaintext is the Markdown file. Tags, dependencies, logical path metadata, and history content are inside the encrypted revision. A metadata envelope is limited to 32 MiB; note content is limited to 10 MiB.

## Attachment frames

Attachments use this binary format:

1. Ten ASCII bytes `NNSTREAM1\n`.
2. Little-endian u32 header length, at most 4096.
3. Compact JSON identity bytes.
4. One or more frames: final flag (u8, 0 or 1), ciphertext length (little-endian u32), random nonce (24 bytes), ciphertext including tag.

Plaintext frames are at most 65536 bytes. Each frame authenticates the original header bytes, its zero-based index encoded as little-endian u64, and its final flag. A final frame is required, including for empty files. Trailing bytes, oversized frames, missing final frames, incorrect identities, tampering, and reordered frames are rejected. Total plaintext is limited to 100 MiB. Decryption goes to a temporary local file; the completed blob is installed only after all frames validate.

Blob objects use their blob UUID for both item and revision identity and purpose `attachment`. Mirrored attachment files use the owning item and revision identities with purpose `mirror`.

There is no filename encryption, padding to hide sizes, or protection against an attacker who already controls the unlocked local device. There is no server-side plaintext index or thumbnail generation.

## WebDAV full backup container v1

A `.wnbackup` snapshot begins with the 10-byte ASCII magic `WNBACKUP1\n`. All integer lengths are little-endian unsigned 64-bit values. The following blocks each carry a length prefix:

1. VaultConfig JSON (at most 64 KiB), with the existing passphrase/recovery wrappers and Argon2id parameters. No master key or account credentials are present in this cleartext header.
2. Snapshot UUID UTF-8 (at most 128 bytes, validated as a UUID).
3. Existing authenticated JSON envelope with purpose `backup-manifest`, item `manifest`, revision equal to the snapshot UUID, and the config's vault ID (at most 32 MiB encrypted).
4. One length-prefixed `NNSTREAM1` encrypted file per manifest entry. Each identity uses purpose `backup-file`, item equal to its zero-based entry number, and the same snapshot/vault IDs. Reordering, truncation, appended bytes, and swapping a file from another backup fail authentication.

The decrypted manifest contains version 1, snapshot ID, notebook name, relative empty/current directories, and ordered file entries containing the relative path, metadata flag, plaintext byte length, and SHA-256 hash. Plaintext names and hashes never leave outside encryption. Only `index.db`, `revisions/<UUID>.json`, and `blobs/<UUID>` are allowed as internal metadata entries. File/directory collisions, missing or differently cased parent directories, traversal, reserved paths, and unknown metadata are rejected before installation. Every file's size and hash must match after stream authentication, and trailing container bytes are rejected.

The local database snapshot is created through SQLite VACUUM INTO while the vault operation lock is held. It is encrypted like every other file. Private temporary directories hold staging data; successful restore publishes a new folder after verification and an index rebuild. Limits: 4 GiB container, 100 MiB plaintext per file, 20,000 manifest entries. A completed object is published from its `.partial` upload via non-overwriting WebDAV MOVE.
