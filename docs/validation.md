# Implementation validation — 13–14 October 2026

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

## Local website and launch archive

The latest local website changes point source/license links to `protoray/wattle-notes` and downloads to GitHub Releases. Launch preparation now separates the static website ZIP from app/source assets in `release/github/`; website-hosted archives and the app demo are excluded. This is a local preparation change: no GitHub release or live WordPress update is implied by committing or pushing it.

The static launch kit includes a landing page, five actual app-preview theme screenshots, privacy/getting-started pages, Mac developer-alpha ZIP, matching GPL source ZIP, download checksums and release metadata. An optional external support link is hidden when unconfigured. The WordPress website was published on 15 October 2026 with the user's approval. The user subsequently requested removal of the live notebook demo; its public files and links were removed, and launch preparation now excludes it.

Earlier website browser tests covered desktop/mobile layout, theme selection, the former nested demo, local resource checks, exact download SHA-256 matches, zero third-party requests, and configured support-link visibility without a checkout. The current website tests replace demo editing with checks that its URLs return 404 and no page links to it. The screenshot capture check passed for all five themes. Desktop/mobile page screenshots were inspected and mobile heading spacing corrected.

The frontend suite passed 35 tests and the expanded release/launch script suite passed six tests. Both download ZIPs passed CRC/path checks; all public source-file hashes matched the source manifest, with local handoff, environment files and caches excluded. An isolated exported source copy passed a fresh dependency install (no reported vulnerabilities), frontend build, frontend/script tests, and native macOS Rust compilation check. A failed offline install was retried normally with a temporary cache; it did not indicate a source defect. Native compilation reuses the local dependency cache and does not establish Windows/Linux behavior or public signing.

`npm run launch:prepare` writes the hostable `website/dist/` and the upload archive `release/wattle-notes-launch-kit.zip`. See `launch.md` for instructions. Local HTTP checks establish a candidate artifact, not successful public hosting or public OAuth configuration.

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

## Outstanding public-release checks

- Live Nextcloud backup and restore plus actual OS credential storage still require a configured test service. This is optional provider work; the user does not have Nextcloud and it is not a blocker for continuing local/Google features.
- Live Google OAuth and Google Drive require a configured Desktop OAuth client and owner consent. All completed Drive sync scenarios used the injectable transport test double.
- Windows and Linux native build/package/smoke checks were not executed on this Mac. The repository includes CI jobs for them.
- The x64 Mac check compiles the desktop code but does not establish packaged launch behavior on an Intel Mac.
- Production OAuth consent preparation, signing/notarization, and independent security review remain release work. The macOS bundle is a development alpha.

Follow `docs/release.md` before distributing the app as a supported public release.
