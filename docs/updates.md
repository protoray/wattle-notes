# In-app alpha updates

Updater-enabled desktop builds check the public GitHub alpha feed three seconds after launch. Settings → App updates provides a manual check and a saved option to disable startup checks. A newer build is offered for the current platform. Downloads and installation require the user's click; the app shows progress, verifies the signature, saves the open note, installs, and restarts. A failed download, signature or save stops installation. Editing and normal Quit are blocked during installation/download so pending work cannot race the restart. This does not change notebook locations or erase settings/history.

The previously published 0.1.1 alpha has no updater. Users must manually install the first updater-enabled release once. Version 0.1.2 introduces the updater; source changes alone do not publish a release or advance its feed.

## Trust and network requests

Tauri's updater verifies each archive using the public key embedded in `src-tauri/tauri.conf.json`. `requireSignedVersion` also binds the announced version to the signed artifact, preventing an altered feed from advertising an older signed artifact as a newer build. The default newer-version comparison remains enabled. HTTPS is required. The frontend has only check/download/install permissions; it cannot replace the endpoint or signing key.

The endpoint is `https://raw.githubusercontent.com/protoray/wattle-notes/main/updates/alpha.json`. An explicit feed is used because GitHub's `/releases/latest` shortcut excludes alpha prereleases. The feed can only offer builds that the maintainer has published, signed and added to that feed; it does not execute an arbitrary source commit. Only macOS Apple Silicon is currently packaged. Do not add other platforms until matching installers have been verified.

Startup checks contact GitHub, which receives ordinary connection metadata such as IP address. No note content, attachments, notebook paths or cloud credentials are sent. Disable automatic checks in Settings to avoid startup requests. Browser previews never invoke the updater.

Updater signing is distinct from Apple code signing/notarization. The current Mac candidate remains unsigned by Apple and not notarized. Install the app into a writable Applications folder before using in-app updates; read-only disk images, App Translocation or filesystem permissions may prevent replacement. The app reports update errors and retains access to local notes. An isolated packaged Mac upgrade/restart test passed on 16 October 2026; repeat acceptance checks for future releases.

## Private key

The maintainer's updater signing key is stored at `~/.tauri/wattle-notes-updater.key` (mode 0600), outside the checkout and generated release files. Its public counterpart is `~/.tauri/wattle-notes-updater.key.pub`; the public key is embedded in app configuration. Back up the private key securely on separate storage before distributing updater-enabled builds. Losing it prevents future updates to those installations. Never upload the private key, print its contents, include it in source archives, regenerate it casually or replace the embedded public key for existing users.

`TAURI_SIGNING_PRIVATE_KEY` may supply a different secure file path or key contents; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` supplies its password. Both travel through the process environment, never shell interpolation. Keep CI keys in protected repository secrets if automated publishing is introduced. Source builders do not need the private key for `npm run desktop:build`; only signed updater packaging needs it. Forks must use their own key and feed.

## Prepare and publish a future release

1. Increment the app version consistently in npm, Tauri, Cargo and local website metadata. Each published alpha uses a new numeric app version so comparison works (for example, app 0.1.3 with tag `v0.1.3-alpha.1`). Changing only `alpha.N` while retaining the same app version will not offer an update.
2. Run the project checks and regenerate notices. Configure the maintainer Google OAuth client for a supported release; an unconfigured build must remain labelled a developer alpha.
3. With the Rust toolchain on PATH, run `npm run updates:build -- v0.1.2-alpha.1` for the current candidate, or the matching new tag later. This builds the Mac app, creates its updater archive/signature, verifies the signature and signed version against the embedded public key, rejects tampered bytes, checks archive paths, and stages public artifacts in `release/updater/TAG/`. It does not upload or change the public feed.
4. Prepare the regular app/source ZIPs and checksums using `npm run launch:prepare` and `npm run launch:verify -- --against-workspace`. Preserve exact matching source. Keep historical releases intact.
5. Create the new GitHub alpha release at the matching source commit, including regular app/source assets plus `wattle-notes-macos-arm64.app.tar.gz` and its `.sig` from the updater staging directory. Verify the public updater download bytes/signature before offering it.
6. **Only after the assets are public**, copy staged `alpha.json` to `updates/alpha.json`, commit and push that feed to main. Uploading an alpha release alone does not update the feed. Do not announce URLs for draft/missing assets. For the first bootstrap publication the feed may be copied in a follow-up commit after the tagged source is published; this preserves publish-before-offer ordering.
7. From a disposable older updater-enabled app/notebook, check, download, install and relaunch. Verify saved note bytes, selected notebook and preferences survive, and the app no longer offers the same build. Verify corrupted payloads and offline responses cannot trigger installation. When publishing the feature, update the live website privacy policy with the local App update checks section as well as the requested download links.

A release tag may contain the previous feed snapshot because assets must be published before the feed advances. The feed on main is updated in a separate commit after public asset verification; the release source archive remains matched to its tag. Release and website publication are explicit maintainer actions.

Reference: [Tauri updater documentation](https://v2.tauri.app/plugin/updater/).
