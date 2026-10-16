# Preparing the first public alpha

The launch tools prepare a static website and separate assets for GitHub Releases: an unsigned Apple Silicon Mac download, its matching public source snapshot, and checksums. The website links to the GitHub repository and Releases page; it does not contain downloadable app/source archives or the interactive app preview. Nothing is committed, pushed or published by preparing these files. The app remains GPL-3.0-or-later.

## Build the local kit

1. Run the checks in README.md. For a configured distribution, use `npm run desktop:release -- --bundles app` with the maintainer’s `GOOGLE_CLIENT_ID` and optional `GOOGLE_CLIENT_SECRET` in the process environment, as described in [Google Drive](google-drive.md). For signed updater artifacts, use `npm run updates:build -- v0.1.4-alpha.1` with that same environment. `desktop:build` without those parameters remains an unconfigured developer build.
2. Capture public product screenshots with `npm run screenshots:site`. This uses the synthetic browser demo, not your local notes.
3. `website/launch.json` records `https://github.com/protoray/wattle-notes` as the repository and its `/releases` page as the download destination. Keep optional feedback/support URLs null unless you have configured them. The default HTML links also work without JavaScript.
4. Run `npm run launch:prepare` on macOS with the same Google client build environment. It refuses an absent, stale or non-ARM64 app; copies the static site without the interactive app or downloads; prepares app/source ZIPs and SHA-256 checksums under `release/github/`; and writes release metadata. It excludes local handoff notes, notes databases, common credential files, build caches and generated output from the source archive. Review the generated assets before distribution.
5. Run `npm run test:launch`, then `npm run launch:verify -- --against-workspace` to check both archives, all source-file hashes, bundled notices, native version/architecture, and every upload ZIP file. This uses Python 3 and does not extract or run downloaded executables. Without the flag, the source snapshot can differ from later workspace edits while the archived release remains internally verifiable. The verifier rejects duplicate, unsafe and symlink entries; its checks establish consistency, not a trusted signature.
6. Run `npm run test:site` to verify desktop/mobile pages, screenshot theme previews, GitHub links, absence of website-hosted downloads and the public demo, local resources, lack of third-party requests, and prepared release assets against their checksums.

The static website is `website/dist/`, also packaged as `release/wattle-notes-launch-kit.zip` with its own checksum file. GitHub release assets are separate under `release/github/`. Serve the website locally with:

```sh
python3 -m http.server 1430 --bind 127.0.0.1 --directory website/dist
```

Open `http://127.0.0.1:1430/`. Do not open the HTML via a file URL: the site reads release metadata. This is a static site; directory-index hosting should serve `/privacy/`, `/terms-of-service/` and `/getting-started/`. No SPA rewrite is required. Screenshot theme previews swap static images and do not run the notebook app.

The source ZIP includes a `SOURCE-SHA256SUMS.txt` record for the exact public snapshot. The app and source ZIPs are paired in the same release metadata.

## Commit, push and publish release files

Commit and push the source changes using GitHub Desktop. Build outputs in `release/` and `website/dist/` are deliberately ignored by Git, so a push does not upload them or publish a release.

When ready, create a GitHub pre-release in `protoray/wattle-notes`, selecting the matching source commit and an alpha tag. Upload `wattle-notes-macos-arm64.zip`, `wattle-notes-source.zip`, `SHA256SUMS.txt` and `ALPHA-README.txt` from `release/github/`. Describe it as an unsigned-by-Apple, not-notarized Apple Silicon alpha. Its Google configuration status must match the actual binary and release metadata; the configured 0.1.4 build includes normal Google sign-in. Verify the uploaded file hashes before relying on the downloads. Until a release exists, the website labels the link as the Releases page and does not claim an installer is already available there.

The live `wattlenotes.app` site currently runs on WordPress/Oxygen. Pushing this repository does not deploy those pages automatically. Apply the reviewed link changes to WordPress separately; only after GitHub assets are verified should any old website-hosted downloads be retired.

## Before public hosting

- Review the page and the public archive. Keep the alpha, unsigned/notarized status, platform limits and cloud-test status accurate.
- Add a real feedback destination so visitors can report issues.
- Configure HTTPS on the domain you own. Serve the `website/dist/` tree, including screenshots in `assets/`. Do not deploy `release/github/`, an old `downloads/` directory, or the app development preview. Remove any old `demo/` directory when updating an earlier deployment.
- Verify downloads and checksums from the actual hosted URL. A local successful request does not prove hosting or distribution.
- Publish the source and notices corresponding to each binary. Retain a copy of each distributed kit rather than rebuilding over it after publication.
- Complete signing and live cloud acceptance before offering those as supported features. Never advertise the current alpha as independently security-audited.

## Optional support

The optional external support link is configured as [Buy me a coffee](https://buymeacoffee.com/wattlenotes.app) in `website/launch.json` and works from the landing page without JavaScript. GitHub's Sponsor button uses the same page through `.github/FUNDING.yml`. Support is optional; Wattle Notes remains free and open source. To change the destination, update `supportUrl` and the default HTML link, regenerate the kit, and verify the destination. With no URL configured, remove the default support link too.

This keeps the app useful as FOSS. Charging for a service or accepting support does not need to change the free local notebook. The current implementation does not promise paid features or support contracts.
