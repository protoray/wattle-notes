# Wattle Notes

An independent desktop Markdown notebook with encrypted Google Drive sync. Built for macOS, Windows, and Linux using Tauri 2, React, CodeMirror 6, and Rust.

**Mostly vibe coded with AI assistance.** Much of the implementation was generated using AI tools, guided by the maintainer's ideas, prompts and feedback. It started as a personal project to bring together the note-taking features the maintainer wanted.

**Public alpha.** Local notes and attachments are plaintext. Encryption protects the copies sent to Google Drive, including revision history. Google can see names, folder structure, file sizes, timestamps, and activity. No note content goes to an AI service; the application has no backend service or telemetry.

## Features

- Ordinary Markdown folders; stable note IDs and tags in YAML frontmatter.
- Writing, split preview, and directly editable reading views; keyboard shortcuts and five saved appearance themes.
- Local full-text search, wiki links, relative Markdown links, and backlinks.
- Attachment imports, clipboard image paste, and bounded local image previews in Split and Read. Remote images are blocked.
- Journaled saves, external-file scanning, Markdown import/export, and retained history.
- Passphrase-protected encryption with an independent recovery key.
- Native Google OAuth, encrypted resumable uploads, immutable sync history, and a readable encrypted mirror.
- Optional Nextcloud/WebDAV encrypted full backups and verified restore to a new folder.
- Three-way merging of non-overlapping edits; a conflict screen for overlapping edits, paths, binary files, and delete-versus-edit changes.

## Run from source

Install Node.js **22.12 or later**, Rust **1.90 or later** (current stable recommended), and [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/). macOS needs Xcode Command Line Tools; Linux needs WebKitGTK 4.1 and DBus development packages; Windows needs the MSVC toolchain and WebView2.

From the repository root:

```sh
npm ci
npm run desktop:dev
```

Choose an empty folder or an existing Markdown folder. Opening a folder assigns IDs to Markdown notes and stores local indexing, history, and queue data in `.notes/`. Back up that directory along with your notes if you want to retain unsynced history.

`npm run dev` runs an **explicitly labelled, temporary browser preview**. It does not access local note folders or implement encryption/sync. Preview changes disappear when the page is reloaded.

## Connect Google Drive

In a configured build, select **Sign in with Google**, approve access in your normal browser, then set up a vault passphrase and save the generated recovery key separately. Users do not create OAuth clients or import JSON. See [Google Drive setup](docs/google-drive.md) for the maintainer's build configuration and development setup.

The app requests only `drive.file`. Refresh tokens and optionally remembered encryption keys use the OS credential store. The maintainer supplies the Desktop client at build time using `npm run desktop:release`; this command refuses a missing or malformed client ID. Google consent-screen preparation is a release requirement.

For another device: use the same configured app, open an empty local folder, connect Google, choose **Find my vaults**, enter the vault passphrase or recovery key, then sync. The encrypted history is sufficient to reconstruct notes, attachments, and unresolved conflicts.

**Do not edit or rename the app-managed files on Drive.** Restore accidentally deleted remote files from Drive Trash. Sync pauses if encrypted history is missing; it does not interpret missing remote files as local deletion requests.

## Back up to Nextcloud

Open **Nextcloud backup** in the sidebar. Enter the WebDAV URL from Nextcloud Files settings, your username, and an app password, then **Save & test connection**. Set up or unlock encryption in **Protect your notes**, then **Back up now**. No Google account is needed.

Use **Find backups** to restore a snapshot into a new folder with its original passphrase or recovery key. These are manual full backups with retained history, separate from automatic Drive synchronization. See [Nextcloud setup and limits](docs/nextcloud.md).

## Commands

```sh
npm run build             # TypeScript check and frontend production bundle
npm run lint              # ESLint and TypeScript checks
npm test                  # Frontend behavior and preview security tests
npm run test:core         # Rust storage, encryption, and multi-device sync tests
npm run test:desktop      # Native notebook-switch and transport module tests
npm run check:core        # Strict Rust linting
npm run desktop:build     # Native release and platform installers
npm run desktop:release   # Configured distribution; requires GOOGLE_CLIENT_ID
npx playwright install chromium
npm run test:e2e          # Browser-preview interaction tests
```

Rust formatting: `cargo fmt --manifest-path src-tauri/Cargo.toml --check`. Frontend formatting: `npx prettier --check src tests docs *.json *.ts *.js README.md CONTRIBUTING.md`.

Shortcuts: **Cmd/Ctrl+N** creates a note, **Cmd/Ctrl+P** focuses search, and **Cmd/Ctrl+S** saves. Local autosave waits 500 ms. Connected, unlocked sync runs after five seconds of inactivity, every 30 seconds, on reconnect, or manually.

**Read** is a live Markdown editor. Click rendered text to write; formatting markers appear around the caret so you can edit the underlying Markdown. Use the toolbar or **Cmd/Ctrl+B**, **Cmd/Ctrl+I**, and **Cmd/Ctrl+K** for bold, italic, and links. **Cmd/Ctrl-click** a rendered link to follow it; ordinary clicks edit it. Write, Split and Read share one editor, so undo/redo, the caret and pending image pastes survive view switches. Autosave uses the same note draft in every view. Headings, emphasis, lists, task checkboxes, links and local images are displayed with formatting. Tables, fenced code and raw HTML remain visible as Markdown source; editing does not round-trip the document through HTML.

Choose **Appearance** in the sidebar, or **Settings → Choose theme**, for Paper, Charcoal, Midnight, Sepia, and Forest. Charcoal is the neutral default dark theme; Forest retains the original green palette. Themes apply immediately and are remembered on this device. The **Dark mode** switch returns to your last chosen light or dark theme.

## Alpha boundaries

- One active vault and Google account. Mobile, collaboration, graph views, citations, plugins, full rich-text document conversion, and passphrase changes are deferred.
- Notes are limited to 10 MiB, attachments to 100 MiB, inline image previews to 10 MiB. Remote history is retained without automatic pruning and uses additional Drive storage.
- Sync scans the complete encrypted history for consistency; the stored Drive changes cursor tracks removal events. Large-vault optimization is future work.
- Empty folders are local organization; remote folders are created as files are mirrored. Case-equivalent paths and Windows-reserved names are rejected for portability. Symlinks are not followed.
- Frontmatter values are preserved semantically; YAML comments and original formatting may be normalized. Avoid duplicating a `new_notes_id` when copying a note in another editor.
- A sync operation serializes backend vault access. You can keep typing; local saves wait until the operation finishes. Unsaved drafts are indicated explicitly.
- Google sign-in, real Drive behavior, platform signing, and packaged Windows/Linux validation need the release checks in [Release checklist](docs/release.md). The transport test double validates sync logic, not Google's production service.

See [encrypted format](docs/encrypted-format.md), [architecture](docs/architecture.md), and [security model](docs/security.md).

## Website and alpha downloads

The static launch website includes screenshot theme previews, privacy information, getting-started guidance, and links to the GitHub source repository and Releases page. App/source ZIPs and checksums are prepared separately in `release/github/` for manual GitHub release upload. The website bundle excludes download archives and the interactive notebook preview. Links are configured in `website/launch.json`. Preparing or pushing source files does not publish a release or update the WordPress website automatically.

Run `npm run screenshots:site`, `npm run launch:prepare`, `npm run launch:verify -- --against-workspace`, then `npm run test:site` after building the Mac app. The deployable directory is `website/dist/`. See [the launch guide](docs/launch.md) for prerequisites, verification and remaining public-release gates.

## Support the project

If you find Wattle Notes useful, you can [buy me a coffee](https://buymeacoffee.com/wattlenotes.app). Support is optional; the app remains free and open source.

## License and provenance

GPL-3.0-or-later; see [LICENSE](LICENSE). Commercial use is allowed. Distributed derivatives must comply with the GPL, including source availability. Third-party dependencies keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This application is mostly vibe coded with AI assistance. It is an independent implementation: Joplin, Obsidian, and Zettlr informed the feature goals, without copying their code, assets, or UI. Encryption uses existing cryptographic libraries. Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md).
