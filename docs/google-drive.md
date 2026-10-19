# Google Drive

## Connect your account

A configured Wattle Notes build includes the application's Google client. Select **Settings & tools → Google Drive → Sign in with Google**, approve access in your normal browser, and return to the app. You do not need to create a Google Cloud project or import JSON.

Choose **Set up this notebook**, set a vault passphrase, and save the recovery key separately. **Sync now** saves pending editor changes before syncing. Future sync runs automatically while connected and unlocked.

For another device, install the same configured app and open an empty local folder. Connect Google, choose **Restore from Drive → Find my vaults**, select your vault, and enter its original passphrase or recovery key. Select **Sync now** to reconstruct notes, attachments, and unresolved conflicts from the encrypted history.

Each device must use the same registered Desktop client: `drive.file` grants access to files created by that app, rather than arbitrary Drive files. Do not edit or rename app-managed files on Drive. Locking sync forgets any remembered encryption key. Disconnecting removes the saved refresh token and leaves local notes and Drive data intact.

## Maintainer: configure a distribution

1. Enable the Google Drive API in the app's Google Cloud project.
2. Prepare OAuth branding and audience. Use the [homepage](https://wattlenotes.app/), [Privacy Policy](https://wattlenotes.app/privacy/), and [Terms of Service](https://wattlenotes.app/terms-of-service/) URLs. Verify ownership of wattlenotes.app in Google Search Console and add it to OAuth authorized domains. For development, add your account as a test user. Request only `https://www.googleapis.com/auth/drive.file`.
3. Create a **Desktop app** OAuth client. Keep the same registered client across releases and devices.
4. Supply the existing maintainer Desktop client using one of these methods on macOS, Windows or Linux:
   - Set `GOOGLE_CLIENT_ID` and, if supplied by Google, `GOOGLE_CLIENT_SECRET` in the process environment.
   - Set `GOOGLE_CLIENT_JSON` to the downloaded **Desktop app** JSON file's local path. On Linux/macOS: `export GOOGLE_CLIENT_JSON='/path/to/client.json'`. In Windows PowerShell: `$env:GOOGLE_CLIENT_JSON = 'C:\private\client.json'`.
   - For maintainer VM builds, securely copy that same JSON to `release/private/google-desktop-client.local.json` in the checkout. This ignored file is the default when explicit client environment parameters are absent. Never commit or upload it as source.

   Explicit client environment parameters take precedence as a pair; the build never combines an ID from one source with a secret from another. `.env` files are not loaded automatically. These installed-app parameters identify the app; they cannot be protected as secrets in a distributed executable. Never use access tokens, refresh tokens, passwords or service-account credentials as build configuration.

5. Run `npm run desktop:check-config`, then `npm run desktop:build` or `npm run desktop:release` (for an app-only Mac bundle, append `-- --bundles app`). Both commands validate the configuration before launching Tauri and pass it through the build environment. Missing, malformed, unreadable or non-Desktop JSON fails before compilation. Validation does not verify ownership, consent configuration or a live Google grant.
6. Complete the live tests and signing requirements in [the release checklist](release.md).

Configured builds show normal sign-in and hide developer client controls. The backend also refuses client-setting changes in these builds. Existing notebooks retain previously saved client settings for compatibility with their Drive data; notebooks used with a different development client must be migrated deliberately. Test restores using the same effective client rather than assuming a new app client can discover an old developer client's vault.

The existing flow uses PKCE S256, OAuth state validation, a random localhost callback port, offline access, and the OS credential store. No application login server is required. Rust rebuilds when the compiled client environment changes.

### Linux and Windows packages in GitHub Actions

The maintainer-only **Configured Linux and Windows packages** workflow (`desktop-packages.yml`) builds Linux x64 `.deb` and Windows x64 NSIS/MSI installers from `main` when manually dispatched. Set repository Actions secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to the same Desktop client used for Mac releases. The secret parameter may be omitted only if Google did not provide one. Secrets are passed to configuration/build/verification steps through the environment; ordinary pull-request CI never receives them.

The workflow fails before compiling if configuration is absent and checks that the compiled native executable contains the expected client ID and supplied Desktop client secret before uploading installers. Only installer files are uploaded as short-lived Actions artifacts; it does not publish a GitHub release, change the updater feed, or upload the client JSON. Workflow artifacts still need packaged live acceptance and platform signing checks before public distribution. The existing updater feed currently serves macOS Apple Silicon only.

For a local build, run `npm run desktop:verify-google -- <native-executable-path>` with the same configuration after compiling. Typical native paths are `src-tauri/target/release/wattle-notes` on Linux and `src-tauri/target/release/wattle-notes.exe` on Windows; an explicit `--target` adds the target triple beneath `target/`. This checks compiled configuration, not a live Google authorization. Desktop Linux also needs an available, unlocked Secret Service credential store; verify sign-in and reconnect after restarting in a disposable notebook.

## Contributors: local development

`npm run desktop:dev` and the explicit `npm run desktop:build:local` still work without a bundled client. Ordinary `desktop:build` now requires Google configuration to prevent accidentally distributing an app with sign-in unavailable. Only the development server UI exposes **Developer Google connection settings**, with setup links, bounded Desktop JSON import and manual client entry. Web-client and service-account JSON files are rejected. Production builds never expose these controls; an unconfigured local production build explains that Google sign-in is unavailable and directs users to the official release. Without a client, local editing and optional Nextcloud backup remain available.

## Troubleshooting

If an app-managed object is missing, restore it from Google Drive Trash and retry. If tokens expire or consent is revoked, reconnect. Do not delete local history, replace encryption settings, or use a second passphrase to work around an authentication error.

Official references: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

The configured 0.1.5 alpha uses the maintainer’s production Desktop client. On 16 October 2026, the maintainer confirmed successful sign-in, encrypted sync and restore into a fresh folder. Other live acceptance cases remain listed in the release checklist. Use the same client build environment for `updates:build` and `launch:prepare`; packaging verifies that the advertised client is present in the native binary. Keep the downloaded client JSON outside public source archives.
