# Implementation validation — 13–16 October 2026

Executed on the development Mac (Apple Silicon), using Node.js 26.10.0 and an isolated Rust 1.99.0 toolchain. Build/test caches were kept out of source control.

## Automated results

| Check                                                                       | Result                      |
| --------------------------------------------------------------------------- | --------------------------- |
| TypeScript + frontend production build                                      | Passed                      |
| ESLint + TypeScript lint                                                    | Passed                      |
| Frontend content, preview security, conflict editor, close and theme suite  | 37 passed                   |
| Release and launch script validation                                        | 6 passed                    |
| Rust storage, encryption, OAuth validation, sync and native switching suite | 43 passed                   |
| Browser interaction suite                                                   | 6 passed                    |
| Rust Clippy, desktop and test targets, warnings denied                      | Passed                      |
| Rustfmt and Prettier                                                        | Passed                      |
| npm dependency advisory audit                                               | No reported vulnerabilities |
| macOS ARM64 release app bundle                                              | Built                       |
| macOS x64 Rust/Tauri cross-compilation check                                | Passed                      |

The tests cover passphrase and recovery unlock, randomized authenticated encryption, ciphertext/context tampering, fixed KDF limits, chunked attachment corruption/truncation/reordering, safe paths, symlink rejection, external-editor conflicts, durable save/rename recovery, search rebuilds, exports, links/rename updates, deletion/restoration, two-/three-device merging, overlapping conflicts, binary conflict copies, uncertain upload retries, remote history removal/modification, and restoration of readable notes with unresolved conflicts.

Browser interaction checks use the clearly labelled temporary preview. They exercise writing/autosave, searching, reading, links/backlinks, theme changes, and blocking remote image requests. They do not claim to validate native disk storage or live Google Drive.

Conflict-editor regression tests verify that resolving a conflict updates the active editor and that newer unsaved text is preserved in a separate recovered note.

Close-handler regression tests verify that exit waits for a pending save and that a failed save leaves the editor open with the draft intact.

## Native smoke checks

The packaged app was launched with a disposable local folder. Verified note creation, Markdown editing, explicit save/autosave, reading view, tags, and detection of an external file edit. The resulting Markdown file was read back from disk and contained the expected body, stable ID, and tags. Real personal note folders were not opened for testing.

The final bundle was also tested by entering text, observing the editor's "Unsaved changes" status, and pressing Cmd+Q. Disk readback confirmed that the pending text was saved before exit. The application's Quit menu uses a custom save handshake because the native predefined macOS Quit action bypasses Tauri's exit-request callback.

After the rename to Wattle Notes, the 18 frontend tests, frontend lint/build, and strict desktop Rust Clippy checks passed again. The rebuilt `Wattle Notes.app` launched with the new window/sidebar/menu branding and reopened the existing disposable vault with its note, ID, and tags intact. Storage and credential identifiers were retained for compatibility.

The combined sidebar layout passed all four browser interaction tests and the 18 frontend tests. Its layout regression check covers note navigation/search in one sidebar, expandable folders/tags, sidebar hiding and shortcut reopening, and writing-area width at both 1320 px and the 900 px minimum window width. Light and dark screenshots were visually inspected.

The labelled Dark mode switch was checked for switching in both directions and restoring the saved theme after a page reload. All four browser tests and 18 frontend tests passed after the change.

The simplified Drive setup passed 26 frontend tests and four browser interaction tests. Tests cover configured-client sign-in, setup links opening through the native browser command, bounded Desktop client JSON imports, rejected web/service-account files, the separate restore path, and Settings sync delegating through the editor save flow. These checks simulate commands and do not establish live Google authorization.

The Nextcloud backup implementation passed 39 Rust tests (36 integration and 3 module tests), 30 frontend tests, and five browser tests. Tests verify passphrase/recovery restoration of files, retained history and conflicts; rejection of tampering, truncation, incorrect keys, and malicious paths; streamed WebDAV upload retry; recovery after a lost MOVE response; filtering incomplete/foreign objects; and credential/redirect rejection. Captured fixture uploads contain the encrypted archive and omit note/attachment markers. These tests use a local protocol fixture with synthetic credentials, not a live Nextcloud account.

On 14 October, the saved 15.54 MiB macOS bundle launched successfully and reopened the existing test note intact, retaining dark mode. The native Nextcloud sidebar entry opened the correct provider view. Verified the native connection-info command loaded, WebDAV URL/username/app-password fields were available, connection testing was disabled until required inputs were provided, and encryption setup remained available without Google sign-in. No credentials were entered and no real Nextcloud server was contacted. The backup/restore and WebDAV production code was reviewed; the saved source and build required no changes for this smoke check.

## Themes and configured Google builds

On the latest 14 October continuation, the neutral Charcoal dark palette and optional Paper, Midnight, Sepia and Forest choices passed the expanded frontend suite and all six browser tests. Tests cover saved theme migration, invalid/unavailable preference storage, remembered light/dark choices, persisted browser reload, keyboard radio selection, focus return, and unchanged editor content. Native macOS smoke checks confirmed the five-card picker, immediate Midnight/Sepia selection, return to Charcoal, and the existing Testing note remaining intact. The updated 15.54 MiB app bundle built and launched successfully.

Configured Google builds now hide developer setup controls and use native sign-in without rewriting notebook settings. A frontend regression test verifies those command/UI boundaries. Four Node tests verify missing/invalid release configuration fails before spawning Tauri, input values are omitted from validation errors, configuration travels through the environment without a shell, and failed builds propagate their status. Strict desktop/all-target Rust Clippy passed. The release guard validates syntax only; no production client, Google grant, or real account was used. An initial browser run was blocked by macOS sandbox permissions; the permitted unsandboxed run passed. A new content assertion was corrected to compare CodeMirror's rendered inner text consistently before the final passing run.

## Notebook-switching release audit

The latest native audit found that opening another notebook discarded the current backend handle/key before validating the candidate, and that the normal folder picker retained the previous notebook's search state. The backend now prepares the replacement before swapping state; missing or locked folders, malformed candidate encryption config and failed preference writes preserve the writable current notebook/key. Reselecting the same canonical folder reuses the handle and preserves the unlocked key. Missing remembered folders are not recreated.

The frontend shares one save-before-switch path for normal and restored notebooks. It clears search/filter/history state and cached account state only after successful opening, closes old Settings, and ignores late search responses from the prior notebook. Two frontend regressions passed, bringing that suite to 37 tests. Four native switching regressions plus the existing integration/module suite passed as 43 Rust tests. All six browser interaction tests and strict desktop/all-target Clippy passed. CI now runs the native module tests and desktop Clippy after building the frontend.

The updated 15.54 MiB macOS app rebuilt and launched successfully. Native UI testing switched to a separate empty disposable notebook and back to the original test notebook. The existing Markdown file's SHA-256 was unchanged before/after, and the original note reopened intact in Charcoal. No synthetic edits were made in it. A read-only signing check found zero valid code-signing identities on this Mac; the app remains unsigned/not notarized. The user confirmed the production Google Desktop OAuth client has not yet been created.

The launch verifier is now a saved command, with archive traversal/alias, duplicate-entry and symlink rejection tests. Source filtering also excludes Python bytecode/cache directories. Regenerate and verify the upload kit after source changes using the commands in `launch.md`.

## Image rendering, clipboard paste and editable Read view — 15 October 2026

Three isolated agent tasks were integrated on `codex/images-and-editable-read`. Local attachment paths are decoded once before vault-confined lookup, and the native reader returns the raster MIME type for Blob URLs. Tests cover imported names containing spaces, Unicode, percent signs, hashes and parentheses, the 10 MiB inline limit, symlinks, and URL cleanup. A browser test decodes an actual PNG under the app's image CSP while remote images remain blocked.

Clipboard images are stored as indexed local attachments and inserted at the mapped selection. Tests cover type/size rejection, note/notebook changes during import, ordinary text paste, concurrent typing and undo. Write, Split and Read share one persistent CodeMirror instance, so switching views retains pending paste and undo history. Read provides direct editing, formatting controls and shortcuts without HTML-to-Markdown conversion; complex code/table/HTML blocks remain literal Markdown. Regression tests also cover reference images, reference-definition changes, angle-wrapped link URLs and resource cleanup after equal widget DOM reuse.

The combined implementation passed 61 frontend tests, six Node tests, 41 Rust integration tests, seven desktop/module tests, strict desktop/all-target Clippy, frontend lint and ten browser tests. Existing dependency versions were retained; already-locked CodeMirror packages are now declared directly.

A separately identified macOS QA build opened only a new synthetic notebook. Native WebKit displayed images with encoded filenames. Copy Image through the native context menu followed by normal Paste in both Write and Read created two PNG attachments; a direct Read edit was saved in the Markdown file. The primary app's remembered-notebook setting had an identical fingerprint before and after testing. These are local editor/image checks and do not establish live cloud acceptance or signing.

## Signed alpha updater — 16 October 2026

The local 0.1.2 candidate adds native Tauri update checking and user-initiated download/install/restart. Nine new frontend tests cover startup checks, saved opt-out/manual checks, save-before-install ordering, failed saves, failed signature/download responses, overlapping operations, failed-restart retry, offline errors and browser-preview isolation. The complete frontend suite passed 70 tests; Node release/launch/update validation passed nine tests. Lint, production build, strict desktop/all-target Clippy, 41 Rust integration tests and seven desktop/module tests passed. All eleven browser tests passed; the final updater-panel regression was rerun after layout cleanup and its screenshot inspected.

The native Mac updater archive was built and signed. The release verifier checked its signature against the app's embedded public key and rejected a one-byte mutation. It also checks the authenticated version against the app version; native updater configuration requires that binding. Notices include the new updater and signature dependencies. The private signing key is excluded from Git, app resources and public source selection.

Updater assets are prepared and verified locally before publication. The alpha feed must only advance after matching GitHub assets are public and verified. A full packaged Mac upgrade/restart was subsequently verified on 16 October with isolated 0.1.1 → 0.1.2 QA builds, a separate signing key, a loopback-only test feed and app identifier org.wattlenotes.updater-qa. The native UI rejected a tampered download while retaining the old binary, then installed the exact valid target binary and automatically relaunched (running state checked before reattaching). The edited note bytes, selected disposable notebook, Charcoal theme and startup-check opt-out survived. A fresh check offered no same-version update, and an offline check reported an error without installation. The normal app preference fingerprint was unchanged. The published 0.1.1 app itself has no updater and still requires a manual bootstrap installation. Browser tests mock or disable native APIs; the separate packaged checks establish native replacement and restart. The app is still unsigned by Apple, not notarized, and not configured for public Google sign-in. See [In-app alpha updates](updates.md) for key backup and publication ordering.

## Outstanding public-release checks

- Live Nextcloud backup and restore plus actual OS credential storage still require a configured test service. This is optional provider work; the user does not have Nextcloud and it is not a blocker for continuing local/Google features.
- Live Google OAuth and Google Drive require a configured Desktop OAuth client and owner consent. All completed Drive sync scenarios used the injectable transport test double.
- Windows and Linux native build/package/smoke checks were not executed on this Mac. The repository includes CI jobs for them.
- The x64 Mac check compiles the desktop code but does not establish packaged launch behavior on an Intel Mac.
- Production OAuth consent preparation, signing/notarization, and independent security review remain release work. The macOS bundle is a development alpha.

Follow `docs/release.md` before distributing the app as a supported public release.

## Production Google setup: maintainer acceptance, 16 October 2026

The maintainer reports successful Google sign-in/consent, encrypted synchronization and restoration into a fresh folder using the production Desktop OAuth client. Google Auth Platform Audience is In production. This is owner-reported live service acceptance, distinct from the automated transport fixtures. Multi-device conflict recovery, interruption/quota/revocation cases, recovery-key restore, and live Nextcloud acceptance were not included in that confirmation and remain open. Version 0.1.4 embeds this same client for normal sign-in without per-user setup; its build contains only installed-app client parameters, never user access/refresh tokens.

## Production Google settings cleanup: 0.1.5 alpha

Production UI excludes developer OAuth setup instructions, JSON import and manual client controls. Account loading or failure no longer exposes them. Existing notebook OAuth settings and tokens are preserved. Unconfigured production builds direct users to the official release instead of asking them to create a client. Only the development UI with an explicitly unbundled client exposes setup. Regression cases cover configured/unconfigured production settings and deferred/failed account loading.

Local validation: 89 frontend tests, 10 Node checks, 15 app browser checks, four archive-verifier tests and lint/TypeScript passed. Further release checks are recorded when completed; earlier native upgrade/restart and owner-reported live Google tests retain their original scope.

## Attachment-heavy sync responsiveness — 17 October 2026

Sync now uses a separate database connection while the primary notebook handle retains its process lock. A shared operation gate serializes local work and yields during Drive requests, allowing attachment reads, account settings and local saves to complete while a transfer waits. Duplicate sync and notebook/connection/encryption changes are rejected during an active pass. Per-pass Drive folder listing caches avoid repeated listing for every note or attachment; indexed note lookups and mapped scan lookups reduce local work.

Synthetic transport tests synced and restored 100 notes with 100 attachments, verified every attachment's bytes and bounded folder listings to seven per pass. A paused failing network request allowed image reads and a local save to finish before it resumed, retained the primary file lock and reacquired the operation gate for error handling. A concurrent-edit regression verifies that revisions referencing newly added attachments remain pending until their blob and parent dependencies are uploaded; a fresh-folder restore never receives incomplete attachment history.

The UI displays sync phases/counts, keeps autosave enabled and provides retry after a connection-settings load failure. The browser regression decodes a real PNG, saves an edit and loads connected settings while its mocked sync remains pending. Final validation passed: 94 frontend tests, 10 Node checks, 16 browser checks, 42 core integration tests and 10 native module tests, lint/TypeScript, frontend production build, strict desktop/all-target Clippy and formatting. The sync browser test was rerun after final progress-bar styling and portable keyboard changes, and its screenshot inspected. No live Drive account, real notebook, packaged app launch or new public release was used for this regression. This establishes responsiveness during sync; image failures independent of syncing still require an affected link or reproduction.

## Unchanged sync work and accurate transfer counts — 17 October 2026

The app checks Drive every 30 seconds for changes from other devices. Previously, download and mirror progress counted every metadata entry being checked, including unchanged objects. It also rewrote unchanged local attachments and downloaded its own new uploads on the following pass because their acknowledged versions were not cached yet.

Progress now counts actual transfers, and the toolbar labels metadata checks “Checking Drive…”. Successful uploads cache the server's completion version for the matching file ID; missing or uncertain completion metadata still requires an authenticated download before caching. Later version changes and missing history continue to trigger integrity checks. This uses Google's documented [resumable upload completion metadata](https://developers.google.com/workspace/drive/api/guides/manage-uploads) and [file version](https://developers.google.com/workspace/drive/api/reference/rest/v3/files) fields. Unchanged attachments retain their file timestamps, and reconciliation uses indexed single-note reads.

Expanded counters on the 100-note/100-attachment fixture verify zero uploads/downloads on idle passes, exactly two uploads for a one-note edit (its history entry and readable mirror), no unchanged attachment rewrites, zero downloads of acknowledged own uploads, and exactly one new history download for an edit from a second device. Missing-version fallback authenticates one blob and two history objects once, then subsequent passes transfer nothing. Existing tamper, missing-history, interrupted-transfer and concurrent-edit checks still pass. Full validation: 43 core integration tests, 11 native module tests (54 unique Rust checks), 94 frontend tests, 10 Node checks, all 16 browser checks, lint/build, strict desktop/all-target Clippy and formatting. The UI regression verifies checking phases have no invented transfer count. No live Drive account or real notebook was used; publication status is recorded separately.

During 0.1.7 release checks, the synchronous Markdown decoration fixture was made deterministic by completing its syntax tree before inspecting all decorations. CodeMirror can otherwise yield the initial parse under CPU load. All original decoration and source-preservation assertions remain. The full frontend suite passed after this correction. A concurrent browser run hit navigation timeouts under high host load; browser checks were rerun separately after native checks.

## App-only source packaging — 17 October 2026

Website implementation, screenshots and website-only capture/test configuration are maintained separately from the public app source. App packaging no longer reads website configuration or screenshots, writes website output or creates a website upload kit. App release metadata now lives under `release/github/release.json`. The source filter and independent verifier reject website paths, website-only tooling and local continuity files, including when unwanted files have valid archive checksums.

Validation passed: 94 frontend tests, 10 Node checks, six archive-verifier checks, lint/TypeScript and production frontend build. A clean export with no website directory built and packaged successfully, verifying all 925 public app source files against its workspace. The maintainer's 17 original website/config/test files retained their recorded hashes. Temporary verification files were removed; the native app binary, published release assets and live website were not changed. No new app release or updater-feed activation was required.
