# Contributing

Wattle Notes is GPL-3.0-or-later. Submit original work or properly attributed, license-compatible contributions. Contributions are licensed under the project's GPL terms. Keep third-party notices and dependency lockfiles current. Disclose material AI assistance in your pull request and review generated code as you would any other contribution.

Use the repository-root commands in README.md. Add regression tests for behavior changes, especially storage recovery, encryption, sync, and preview isolation. Run frontend lint/build/tests, Rust tests/Clippy, and formatting checks before submitting a pull request.

Use descriptive names and focused modules. TypeScript uses Prettier and ESLint; Rust uses rustfmt and Clippy. Keep credentials, notes, build output, and local caches out of commits.

Pull requests should state the user-visible problem, the resulting behavior, and verification performed. Include screenshots for interface changes. Document encrypted-format or migration changes before implementing them; retain backward compatibility or refuse unsupported data without modifying existing notes.

Do not implement cryptographic primitives. Do not introduce telemetry or note-content network requests as an incidental dependency change. Do not copy reference-app source or assets.

Report security issues privately to the repository owner's contact listed on the eventual public repository. Until that repository/contact exists, avoid posting sensitive note data or exploitable credentials in issues. Provide a minimal synthetic reproduction instead.
