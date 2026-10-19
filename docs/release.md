# Release checklist

## Automated checks

- Lockfile install, frontend lint/build, Markdown preview security tests, and Playwright interactions.
- Rust formatting, strict Clippy, storage/encryption tests, and two-/three-device transport simulations.
- macOS ARM64 and x64, Windows x64, and Linux x64 native build jobs. Publish unsigned artifacts only as clearly identified development builds.
- Manually run **Configured Linux and Windows packages** on `main` for configured installers, using the repository's Google Desktop client Actions secrets. Ordinary Checks CI is compilation/testing only. Configuration and native-executable checks must pass before artifact upload; see [Google build setup](google-drive.md#linux-and-windows-packages-in-github-actions).
- Regenerate dependency notices for release dependencies. Review license compatibility and cryptographic format changes.
- For updater-enabled releases, follow [In-app alpha updates](updates.md): back up the private signing key, prepare/verify signed updater artifacts, publish assets before advancing the alpha feed, and test replacement/relaunch using a disposable notebook. Updater signatures do not provide Apple notarization.

## Live acceptance gates

These need real accounts and operating systems; simulated tests are not a substitute.

- Register the production Google Desktop OAuth client and finish consent-screen preparation.
- Build configured distributions with `npm run desktop:build` or `npm run desktop:release`, supplying the maintainer's client through the process environment or ignored Desktop JSON file. Both fail closed without configuration. Verify the compiled executable with `desktop:verify-google`, then verify sign-in appears without client import/setup controls. `desktop:build:local` is an explicit opt-in for unconfigured local development builds; do not distribute that output as a configured release.
- Publish the source repository and provide the exact source/tag and build instructions corresponding to each distributed binary.
- Verify Nextcloud connection, full encrypted backup, interrupted PUT/MOVE, quota/authentication errors, and fresh-folder restore with both passphrase and recovery key on a real server.

  Nextcloud is optional. Verify this provider with a suitable test service before claiming live Nextcloud recovery is validated. Its acceptance testing does not block work on local notes or Google Drive.

- Connect on two devices using the same client; create, rename, attach, delete, merge, and restore notes.
- Interrupt a large encrypted upload, revoke authorization, and fill Drive quota. Pending local work must survive every case.
- Inspect actual downloaded Drive files for plaintext note/attachment fixtures. Confirm names and folders remain readable.
- Restore into a genuinely empty third device from Drive with both the passphrase and the recovery key. Verify note/attachment bytes, identities, links, and unresolved conflicts.
- Test macOS Keychain, Windows Credential Manager, and Linux Secret Service, including an unavailable/locked credential store.
- Run packaged launch, editor, filesystem, and recovery smoke tests on each supported operating system and architecture.
- Arrange Apple signing/notarization and Windows signing. Verify Linux installer dependencies and app icons.
- Back up a realistic local vault and verify independent restoration. Do not automatically prune revision history.

## Current validation record

See `docs/validation.md` for the checks actually executed for this implementation. Leave unchecked platform/live-service gates clearly identified until their evidence exists.
