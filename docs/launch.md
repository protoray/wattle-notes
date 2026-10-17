# Preparing app release assets

The release tools prepare an Apple Silicon Mac download, its matching GPL-3.0-or-later app source snapshot, checksums and alpha guidance. The website is maintained separately and is not required, read, changed or included by app packaging. Preparing these files does not commit, push, publish or deploy anything.

## Build and verify

1. Run the app checks in README.md. Build a configured distribution with `npm run desktop:release -- --bundles app`, supplying the maintainer's `GOOGLE_CLIENT_ID` and optional `GOOGLE_CLIENT_SECRET` through the process environment. See [Google Drive](google-drive.md). For a signed updater, use `npm run updates:build -- vVERSION-alpha.N` with the same client configuration and existing signing key.
2. Run `npm run launch:prepare` on macOS with the same Google client environment used for the native build. It refuses an absent, stale or non-ARM64 app and prepares app/source ZIPs under `release/github/`. No website folder or screenshots are needed.
3. Run `npm run test:launch`, then `npm run launch:verify -- --against-workspace`. Verification checks both archives, source-file hashes, bundled notices, native version/architecture and release metadata without extracting or running executable files. Without the workspace flag, an archived snapshot can differ from later source edits while remaining internally verifiable.

Output under `release/github/`:

- `wattle-notes-macos-arm64.zip`: the native app and bundled notices.
- `wattle-notes-source.zip`: public app source plus `SOURCE-SHA256SUMS.txt`.
- `SHA256SUMS.txt`: app/source archive checksums.
- `ALPHA-README.txt`: platform, licence and configuration guidance.
- `release.json`: local packaging metadata pairing the app and source hashes.

The source filter and independent verifier exclude website implementation, website-only tests/configuration, local handoff/state files, credentials, notes and build caches. Checksummed website files are still rejected. The public checkout can build and package the app without the maintainer's local website workspace.

## Publication

Commit and push the corresponding app source, then create a GitHub pre-release in `protoray/wattle-notes` at that exact source commit and a matching alpha tag. Upload the two ZIPs, checksums and alpha README from `release/github/`. For updater-enabled releases, also attach the matching signed updater archive, signature and manifest, following [In-app alpha updates](updates.md).

Verify actual public asset bytes before advancing the updater feed. Keep the alpha's platform, Google configuration and Apple signing/notarization status accurate. Publish the exact source and notices corresponding to the distributed binary. Retain evidence for each published release; do not overwrite old release assets merely to refresh source packaging.

The live website and its download links are a separate publication step. App commits, packaging and pushes do not change WordPress. Existing Git history, tags and previously published source archives may contain historical website copies; ordinary removal from the current branch does not rewrite them.

The project website is [wattlenotes.app](https://wattlenotes.app/). Optional support remains available through [Buy me a coffee](https://buymeacoffee.com/wattlenotes.app) and GitHub's Sponsor button. The app remains free and open source.
