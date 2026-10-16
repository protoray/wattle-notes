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
4. Provide `GOOGLE_CLIENT_ID` and, if supplied by Google, `GOOGLE_CLIENT_SECRET` in the build environment. These installed-app parameters identify the app; they cannot be protected as secrets in a distributed executable. Never include access tokens, refresh tokens, or service-account credentials. Variables are read from the process environment, not automatically from `.env` files.
5. Run `npm run desktop:release` (for an app-only Mac bundle, `npm run desktop:release -- --bundles app`). It validates the client parameter format before launching Tauri and passes the parameters through the build environment. It does not verify ownership, client type, consent configuration, or a live Google grant.
6. Complete the live tests and signing requirements in [the release checklist](release.md).

Configured builds show normal sign-in and hide developer client controls. The backend also refuses client-setting changes in these builds. Existing notebooks retain previously saved client settings for compatibility with their Drive data; notebooks used with a different development client must be migrated deliberately. Test restores using the same effective client rather than assuming a new app client can discover an old developer client's vault.

The existing flow uses PKCE S256, OAuth state validation, a random localhost callback port, offline access, and the OS credential store. No application login server is required. Rust rebuilds when the compiled client environment changes.

## Contributors: local development

`npm run desktop:dev` and `npm run desktop:build` still work without a bundled client. Only the development server UI exposes **Developer Google connection settings**, with setup links, bounded Desktop JSON import and manual client entry. Web-client and service-account JSON files are rejected. Production builds never expose these controls; an unconfigured production build explains that Google sign-in is unavailable and directs users to the official release. Without a client, local editing and optional Nextcloud backup remain available.

## Troubleshooting

If an app-managed object is missing, restore it from Google Drive Trash and retry. If tokens expire or consent is revoked, reconnect. Do not delete local history, replace encryption settings, or use a second passphrase to work around an authentication error.

Official references: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

The configured 0.1.5 alpha uses the maintainer’s production Desktop client. On 16 October 2026, the maintainer confirmed successful sign-in, encrypted sync and restore into a fresh folder. Other live acceptance cases remain listed in the release checklist. Use the same client build environment for `updates:build` and `launch:prepare`; packaging verifies that the advertised client is present in the native binary. Keep the downloaded client JSON outside public source archives.
