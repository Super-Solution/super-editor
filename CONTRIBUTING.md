# Contributing

Super Editor is dual-licensed (GPL-3.0-or-later for the libraries, AGPL-3.0-or-later for the servers; a commercial license is available from SUPER SOLUTION LABS INC). By submitting a change you agree it may be distributed under those licenses and under the commercial license. Every source file keeps its `SPDX-License-Identifier` header.

## Before you open a pull request

```sh
npm ci
npm run check          # build + all unit and jsdom tests
npm run test:e2e       # real-browser tests (needs Chromium: npx playwright install chromium)
npm run bench          # optional: cost of a one-block edit as documents grow
```

- The document format stays `schemaVersion: 1`. A change to validation, operations or limits must also pass the Go and Python conformance tests (`conformance/`), which the TypeScript exporters generate.
- Strings the UI shows go through `labels` (or `messages` for the interaction layer); do not hard-code English in a component.
- New public API needs a test and a line in `CHANGELOG.md`. Documentation changes are checked by `tests/docs.test.ts`.
- Keep the public API generic: no application-specific names, hosts or data.

Security issues: see [SECURITY.md](SECURITY.md).
