# Preparing the first public alpha

The current launch kit is a static website, an unsigned Apple Silicon Mac download, and its matching public source snapshot. It deliberately excludes the interactive app preview. Nothing is published by preparing it. The app remains GPL-3.0-or-later and the website does not require a paid service or a backend.

## Build the local kit

1. Run the checks in README.md. Build the Mac app with `npm run desktop:build -- --bundles app`. This is the developer alpha, without preconfigured Google sign-in; use the configured release flow only after the production OAuth setup and live tests are complete.
2. Capture public product screenshots with `npm run screenshots:site`. This uses the synthetic browser demo, not your local notes.
3. Set optional `repositoryUrl`, `feedbackUrl`, and `supportUrl` in `website/launch.json` to your real HTTPS destinations. Leave unused fields null: the website omits those links. The homepage value records the intended domain; it does not register or publish it.
4. Run `npm run launch:prepare` on macOS. It refuses an absent, stale or non-ARM64 app; copies the static site without the interactive app; creates app/source ZIPs; and writes release metadata and SHA-256 checksums. It excludes local handoff notes, notes databases, common credential files, build caches and generated output from the source archive. Review the generated archive before distribution.
5. Run `npm run test:launch`, then `npm run launch:verify -- --against-workspace` to check both archives, all source-file hashes, bundled notices, native version/architecture, and every upload ZIP file. This uses Python 3 and does not extract or run downloaded executables. Without the flag, the source snapshot can differ from later workspace edits while the archived release remains internally verifiable. The verifier rejects duplicate, unsafe and symlink entries; its checks establish consistency, not a trusted signature.
6. Run `npm run test:site` to verify desktop/mobile pages, screenshot theme previews, absence of the public demo, local resource links, lack of third-party requests, and download bytes against the published checksums.

The output is `website/dist/`, also packaged as `release/wattle-notes-launch-kit.zip` with its own checksum file. The ZIP has the site's files at its root, ready to extract into a static hosting directory. Serve the directory locally with:

```sh
python3 -m http.server 1430 --bind 127.0.0.1 --directory website/dist
```

Open `http://127.0.0.1:1430/`. Do not open the HTML via a file URL: the site reads release metadata. This is a static site; directory-index hosting should serve `/privacy/` and `/getting-started/`. No SPA rewrite is required. Screenshot theme previews swap static images and do not run the notebook app.

The source ZIP includes a `SOURCE-SHA256SUMS.txt` record for the exact public snapshot. The app and source ZIPs are paired in the same release metadata. The snapshot currently has no public Git tag; publish a repository and tag before describing it as an official versioned release.

## Before public hosting

- Review the page and the public archive. Keep the alpha, unsigned/notarized status, platform limits and cloud-test status accurate.
- Add a real feedback destination so visitors can report issues. Add the public repository when available; source downloads work without one.
- Configure HTTPS on the domain you own. Serve the `website/dist/` tree, including `assets/` and `downloads/`. Do not deploy the app development preview or an old `demo/` directory; remove that directory when updating an earlier deployment.
- Verify downloads and checksums from the actual hosted URL. A local successful request does not prove hosting or distribution.
- Publish the source and notices corresponding to each binary. Retain a copy of each distributed kit rather than rebuilding over it after publication.
- Complete signing and live cloud acceptance before offering those as supported features. Never advertise the current alpha as independently security-audited.

## Optional support

The first monetization hook is an optional external support link. Enter your own public HTTPS support page in `supportUrl`, regenerate the kit, and verify that the support button opens the intended destination. With no URL configured, there is no donation button, payment collection, account, or subscription.

This keeps the app useful as FOSS. Charging for a service or accepting support does not need to change the free local notebook. The current implementation does not promise paid features or support contracts.
