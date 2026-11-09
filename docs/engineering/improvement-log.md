# Engineering improvement log

Newest first. Each iteration records what was found, decided and checked, and what is left.

## Library excellence directive: 15 rounds (2026-11-08)

Constraints for every round: public API stays compatible, nothing is published, licences and git history are not touched, no
new dependencies. Each round audits one area, reproduces what it finds, fixes it with a regression test and runs the local
gate (`npm run build`, `npm test`, `go vet` and `go test`, `ruff`, `mypy` and `pytest`). Scores are in `scorecard.md`.

Local setup note: `package-lock.json` still lists only `packages/*` as workspaces and `@supersolutions/super-protocol` is not
on npm, so `npm ci` fails on a fresh clone (the release steps in `docs/RELEASING.md` regenerate the lockfile after that
package is published). To build here, `npm install --no-package-lock` with the protocol package linked from super-chat.

### Round 1: Markdown export fidelity

* **Method.** A seeded fuzz (6,000 documents per seed, adversarial text such as `*`, `_`, `` ` ``, `[`, `<`, `&amp;`, `#`, `>`,
  CJK and emoji in paragraphs, quotes, headings and lists) exports to Markdown, imports it again with `fromMarkdown` and
  compares block count, block type and text. A separate fuzz drove `createEditor` with random insert, update, move, delete,
  duplicate, replace and citation operations plus undo and redo (6,300 runs): no defect, so the engine was left alone.
* **Defect 1: a heading ending in ` #` lost the `#`.** `## Learning C #` reads back as the heading `Learning C` (the `#` is
  an ATX closing sequence). Affected headings, section titles and the document title. Fix: a trailing `#` run that follows
  whitespace (or is the whole text) is escaped (`\#`).
* **Defect 2: a blank line inside a paragraph split it in two on re-import.** A run containing `\n\n` (or newlines around
  whitespace-only lines) exported as `  \n  \n`, which is a blank line. Consecutive line breaks now collapse into one hard
  break, in paragraphs, quotes and callouts.
* **Ports.** `render.v1.json` gained a `markdown-edges` document, a title ending in `#` and five more run texts; the Go
  (`EscapeHeadingText`, `blankLines`) and Python (`escape_heading_text`, `_BLANK_LINES`) ports were changed to match and fail
  against the new data without the change.
* **Still open (rare).** A paragraph that starts with four or more spaces reads back as an indented code block, and a list
  item such as `--- ---` reads back as a thematic break. Both need a decision on how much leading whitespace to preserve.
* **Gate.** TypeScript 369 tests, Go (`go vet`, `go test`), Python (`ruff`, `mypy`, 16 tests) pass.

### Round 2: validation hot path (performance)

* **Method.** `npm run bench` (new, `scripts/bench-core.ts`) builds documents of 500, 2,000 and 5,000 paragraphs and times
  a single `updateBlock`, `validateDocument`, the exports, `undo` plus `redo` and serialization. A CPU profile of
  `validateDocument` on 5,000 blocks showed `timestamp` (about 500 ms of 2.5 s over 30 runs), `object` and the document
  being serialized twice for the size limit.
* **Changes.** `timestamp` remembers up to 1,024 strings it already proved valid (a document repeats a handful across
  thousands of blocks; the check is a pure function of the string). `object` no longer allocates an array per key. The
  total-size check adds the envelope to the running total of the per-block sizes it already computed instead of
  stringifying every block again; the new boundary test pins that the result is byte-exact (accepted at exactly
  `LIMITS.json`, refused at one more).
* **Result (5,000 blocks, same machine).** `validateDocument` 58 ms to 29 ms; one `updateBlock` through `apply` 82 ms to
  48 ms; `serialize` 62 ms to 46 ms. The remaining cost is per-field path strings built eagerly for every field, which
  would need a lazy-path rewrite of the validator; not attempted.
* **Gate.** TypeScript 370 tests pass; Go and Python untouched.

### Round 3: copy-on-write commits (performance, correctness-neutral)

* **Method.** The profile after round 2 showed `clone(snapshot)` (a JSON round trip of the whole document) and a deep
  `freeze` on every commit, even for a one-block edit.
* **Change.** `apply` now builds a shallow candidate that shares the frozen blocks of the current snapshot. The first write
  to a block (`updateBlock`, `moveBlock`, `moveBlocks`, `replaceText`, `removeCitation`) swaps in a private copy;
  blocks inserted by the same transaction are already private; deletes only record the version a retired ID takes with it.
  Document-level validation still rebuilds a fresh tree, so nothing is shared with the committed snapshot.
* **Evidence.** The editor fuzz (round 1) fails immediately if `own` stops copying (a write to a frozen block surfaces as
  "could not be applied safely", which the fuzz treats as a defect), and passes 8,000 runs with the change. A new test
  (`a commit leaves earlier snapshots untouched...`) pins that a snapshot taken before an edit, a move, a text replacement
  and a citation removal is byte-identical afterwards, and that undo restores it.
* **Result (5,000 blocks).** One `updateBlock` through `apply`: 48 ms to 38 ms (82 ms before round 2). `validateDocument`
  (29 ms) is now the floor for a commit; `undo` and `redo` are still dominated by whole-document comparisons (122 ms for the pair).
* **Gate.** TypeScript 371 tests pass; Go and Python untouched.

### Round 4: package metadata (consumption)

* **Method.** Loaded every built package in plain Node and in jsdom and compared the globals, the document head and the
  custom element registry before and after: importing a package does nothing by itself, and server-side import is safe.
  Then read the eight `package.json` files as a consumer's tools would.
* **Defects.** (1) No `sideEffects` field, so bundlers had to keep every module of every package. (2) `exports` offered only
  the `import` condition, so `require("@supersolutions/super-editor-core")` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`
  (Node 22 can `require()` an ES module, but only through a `default` or `require` condition), as did any resolver that
  does not pass the `import` condition. (3) No `main`, which legacy resolvers still read.
* **Fix.** `sideEffects: false` (the UI package: `["**/*.css"]`, because `styles.css` is imported for its effect), a
  `default` condition mirroring `import` for every entry, and `main`. The release contract (`releasePackages`) still
  passes. `tests/package-metadata.test.mjs` pins all three and loads `core` and `api` through both `require()` and `import()`.
* **Not changed.** The packages stay ESM only; no CommonJS build was added (no new tooling, and Node 22 is the engine floor).
* **Gate.** TypeScript 373 tests pass.

### Round 5: Unicode at the edges (surrogate pairs)

* **Method.** A property fuzz of the pure inline algebra (`toggleMark`, `setLink`, `setHighlight`, `insertText`,
  `deleteRange`, `splitRuns`, `sliceRuns`, `normalizeRuns`, 90,000 random run lists with markers, links, emoji and CJK):
  text and citation markers are preserved, results are normalized, offsets agree. No defect there. Then a search for every
  place that cuts user text with `slice`.
* **Defect 1 (API output).** The text preview of `find_blocks`, `get_outline` and friends cut at 159 UTF-16 units. A paragraph of
  emoji came back ending in a lone high surrogate (`"\ud83d…"`): well-formed JSON text but not valid Unicode, so a Python
  client cannot print it and a Go client sees U+FFFD. The same cut applied to a title imported from Markdown (`setTitle`
  clipped at 1,000 units, which would persist the half pair in the document), to the "renamed the document to" revision
  summary and to the UI's paste conversion of toggle and section titles.
* **Fix.** `clipText(text, max)` (new, additive export of `@supersolutions/super-editor-core`) backs off one unit when the cut
  lands inside a pair; the four call sites use it. Test: `clipText and the text previews never leave half of a surrogate pair`
  (fails without the change).
* **Defect 2 (UI).** `wordRangeAt`, which picks the word for a collapsed-caret format command and for double-click, tested
  one UTF-16 unit at a time, so a word containing a rare ideograph (CJK Extension B) or a mathematical letter stopped at
  it. It now walks by character, and a caret between the two halves of a pair belongs to the whole character.
* **Known difference kept.** The Go and Python ports count previews and some limits in code points, TypeScript in UTF-16
  units; for text outside the BMP the cut points still differ (documented in iteration 2).
* **Gate.** TypeScript 374 tests pass.

### Round 6: saving documents to disk (CLI, MCP, Go and Python servers)

* **Method.** Round 8 of the earlier series fixed the CLI losing a document's permission bits on save. This round
  checked the same property, and symlinks, in every other writer: the MCP file store, the Go server's `-save` and the
  Python server's `--save`. Reproduced with a `0644` document and a symlink to it.
* **Defects.**
  * MCP file store: every edit reset the document to `0600` (the CLI had been fixed, this twin had not).
  * CLI and MCP: an edit through a symlink (`report.json -> ~/Dropbox/report.json`) renamed the temporary file over the
    link, so the link became a regular file and the real document silently stopped receiving edits.
  * Go server: always wrote `0644` (a private `0600` document became world-readable on the first save), used the fixed
    name `<file>.tmp` (two processes collide; a planted symlink at that name is followed) and replaced symlinks.
  * Python server: same fixed `.tmp` name and symlink replacement; permissions followed the umask.
* **Fix.** All four resolve the symlink first and replace the real file, keep its permission bits, and use a unique
  exclusively created temporary file in the same directory (`fsync` before the rename). New tests: CLI and MCP symlink and
  permission tests, `TestWriteAtomicKeepsPermissionsAndSymlinks` (Go), `test_server_saving.py` (Python). The TypeScript and Go
  tests fail without the change.
* **Not changed.** The lock file (`<file>.lock`) and the history log still live next to the name the user passed, not next
  to the link target, so a link and its target do not share a lock. Moving them would orphan history logs created next to a link.
* **Gate.** TypeScript 376 tests, `go vet` and `go test`, `ruff`, `mypy` and `pytest` (17 tests) pass.

### Round 7: the typed HTTP client

* **Method.** Read `createHttpClient` for what happens when the server misbehaves, and reproduced it against a real
  `http.createServer` that sends the headers and a partial body and never ends the response.
* **Defect.** `timeoutMs` was cleared as soon as the response headers arrived, so a stalled body hung `await response.text()`
  forever: the documented "timeout (default 30 s)" did not cover it (3 s later the call was still pending). A custom `fetch`
  that ignores the abort signal also hung.
* **Fix.** One deadline now covers send and body, raced against both so a `fetch` that ignores the signal is cut off too.
  New option `signal`: aborting it cancels the requests in flight and refuses new ones (`HttpClientError`, "was aborted"),
  the usual need of a UI that unmounts. Documented in `docs/API.md`.
* **Tests.** A stalled body, a `fetch` that never settles and the caller's signal (before and after a request) in
  `tests/http.test.ts`; the stalled-body case fails without the fix.
* **Gate.** `npm run build` (includes the test type check) and TypeScript 376 tests pass.

### Round 8: undo and redo cost (resumed after an interruption)

* **Method.** `npm run bench` showed `undo` plus `redo` at 122 ms on 5,000 blocks, three times a normal edit. History restore
  deep-copied the stored document and serialized every block twice (current and target) just to compare them.
* **Change.** Restore starts from a shallow copy (blocks are rewritten anyway, content is only replaced, validation rebuilds
  the tree) and compares blocks with a structural `sameJson` instead of `JSON.stringify` twice per block. Version, reserved-ID
  and ordering rules are untouched.
* **Evidence.** The editor fuzz (undo restores the exact previous content, full unwind reaches the empty document, no
  version regresses) passes 4,000 more runs; undo plus redo drops from 122 ms to 74 ms at 5,000 blocks.
* **Reviewed, no change.** The web component and the React binding: subscriptions are released on disconnect or unmount,
  loading an invalid document keeps the previous one and emits `error`, and importing either package is safe on the server.
* **Gate.** `npm run build`, TypeScript 376 tests pass.

### Round 9: documentation against the product

* **Method.** Read the README claim by claim against the code and ran `npm run example`.
* **Defects.** The README said paragraph controls are plain-text editors and that rich text editing is "a future extension",
  but the default `ReportEditor` has had in-place inline formatting, a `/` menu, drag and drop and history for a while; only
  `interaction={false}` is plain text. The "Run locally" block gave `npm ci` with no hint that it needs the unpublished
  protocol package, and `npm run bench` was not mentioned.
* **Fix.** README corrected on all three. `go test -race ./...` also re-run green.
* **Gate.** TypeScript 376 tests pass (the docs test still holds).

### Round 10: the chat plugin (security)

* **Method.** Read `createEditorChatPlugin` as an attacker who controls the content of a chat message would.
* **Defect (credential leak).** A `super-editor.document` card can name a `service: { baseUrl, documentId }`. The plugin built
  the URL from the card and attached the host's `headers()` (for example a bearer token) to the request, so any card, written
  by a model or another participant, could make the user's browser send the host's credentials to an origin of the
  attacker's choice. A second gap: `response.json()` buffered an unbounded body.
* **Fix.** Headers go only to a URL the host built (`resolveServiceUrl`) or to an origin in the new `allowedServiceOrigins`
  (default none; the request is otherwise made anonymously, so a protected service answers 401 and the card shows the error).
  The body is read through a size-capped reader (`LIMITS.json`), refused early on a large `content-length`, and a non-JSON answer
  gives a clear message. This is a behaviour change of an unreleased 0.1.0 option, recorded in `CHANGELOG.md`; hosts that
  relied on the old behaviour add their origin to `allowedServiceOrigins`.
* **Tests.** An untrusted origin gets no credential, a listed one does, a host-built URL does, an oversized and a non-JSON
  answer are refused (fails without the change); the existing service test lists its origin.
* **Not changed.** A card can still make the browser issue an anonymous GET to any http(s) URL, as a markdown image
  already can; the protocol's `validateEditorCardSpec` (Apache, in super-chat) accepts any http(s) `baseUrl`.
* **Gate.** `npm run build`, TypeScript 377 tests pass.

### Round 11: HTML output against hostile content (security)

* **Method.** Wrote a fuzz that puts script tags, attribute breakouts, `</style>` and `</textarea>` closers, `onerror`/`onload`
  payloads and `javascript:`/`data:` URLs into every text field (title, headings, runs, lists, tables, chart spec, embed, image,
  citation, metrics, callout) and parsed `toHTML` (normal and standalone) and the DOM renderer under jsdom, counting script
  elements, `on*` attributes and unsafe URL schemes. A second pass tried hostile URL schemes (case, whitespace, tab, NUL, `//`,
  `data:`) and hostile chart colours.
* **Result.** No defect. Text and attributes are escaped, validation rejects every unsafe URL scheme and colour before it can
  reach a renderer, and the one input that passes (a quote inside an https URL) is escaped in the attribute.
* **Regression guard.** The hostile corpus is now a `hostile-markup` document (7 payloads times 14 block types) plus a hostile
  title in `conformance/render.v1.json`, so the Go and Python renderers must escape byte-for-byte like the reference. Both pass
  unchanged. Before this the ports were only covered by two incidental `script` strings.
* **Gate.** `npm run build`, TypeScript 377 tests, Go and Python conformance green.

### Round 12: Markdown export that re-imports as something else

* **Method.** Round-tripped awkward text through `toMarkdown` and `fromMarkdown`: dash runs, delimiter rows, fences, setext
  underlines, leading indentation, HTML.
* **Defects.** (1) A list item or paragraph of dashes and spaces such as `--- ---` was exported unescaped, so the re-import read
  a divider and the item vanished. (2) A paragraph whose lines look like a table (`| a | b |` over `|---|---|`) re-imported as a
  table block. Both are data changes on export, not display quirks.
* **Fix.** `escapeLineStarts` also escapes a line made only of dashes and spaces, and the first character of a table
  delimiter row (it needs a pipe, so ordinary dash rules are unaffected). Ported to Go and Python and pinned by new cases in the
  `markdown-edges` conformance document (lists, paragraphs, quotes and callouts).
* **Tests.** A round-trip test that fails without the change, plus the regenerated render conformance in all three languages.
* **Still open.** `fromMarkdown` has no indented code blocks, so our own re-import is fine (a paragraph with 4+ leading
  spaces comes back with the indentation trimmed), but another CommonMark reader would show such a paragraph as code. The
  exporter keeps run-leading whitespace verbatim; trimming it would change the document's text, so it stays a recorded choice.
* **Gate.** `npm run build`, TypeScript 378 tests, Go and Python green, `ruff` clean.

### Round 13: the MCP stdio transport under hostile input

* **Method.** Fed the dispatcher 30 malformed JSON-RPC messages (wrong types for `id`, `method` and `params`, prototype names as
  tool, prompt and resource names, 5,000-deep nesting) and read the stdio reader as a client that never sends a newline would.
* **Dispatcher.** No defect: every case answers with a JSON-RPC error and none throws.
* **Defects (stdio).** (1) After the first oversized line was reported, later chunks of the same line were appended to the buffer
  again until a newline arrived, so a client streaming an endless line grew the server's memory without bound. (2) A line over the
  limit that arrived whole with its newline was never checked and went to `JSON.parse`. (3) A client that closed its end of the
  pipe made the next write raise an unhandled `EPIPE` that crashed the process with a stack trace.
* **Fix.** The line splitting moved to a small `createLineReader` (limit counted in bytes, one report per oversized line, the
  rest of a dropped line discarded as it arrives). A stdout `error` now ends the server with exit code 1.
* **Tests.** A reader test that asserts nothing is buffered while a dropped line streams in, whole-line and multibyte limits, and
  the `EPIPE` exit. Existing stdio tests unchanged.
* **Gate.** `npm run build`, TypeScript 380 tests.

## Iteration 1 (2026-11-08): audit and server scoping

### Inspected

* The TypeScript workspace (`packages/*`, the AGPL `api` and `mcp` backends), the conformance data, and the Go
  and Python ports.
* `npm run build` (tsc project build plus package build) and `npm test` (361 tests) pass; `go vet` and
  `go test` pass for `guarded` and `documents`; Python `ruff`, strict `mypy` and the conformance tests pass.
* The HTTP handler (`backends/typescript/api/src/http.ts`, `routes.ts`) was read for the usual failure modes:
  body limit enforced per route, exact-origin CORS with `Vary`, base-path stripping, `HEAD` without a body,
  405 with `Allow`, read-only mode refusing every route marked `write`, and one failure shape for every
  error. No defect found, so nothing was changed in TypeScript.

### Finding that changes the plan: a Go or Python server is not a thin layer yet

The request was to serve the editor from Go and Python. The HTTP contract (`docs/API.md`) is a thin wrapper in
TypeScript only because the core underneath it is complete. The Go and Python ports are deliberate proofs of
concept and cover a small part of that core:

| Needed by the HTTP contract | TypeScript core | Go / Python ports |
| --- | --- | --- |
| Whole-document validation (17 block types, limits, URL rules) | yes | **no** (content is opaque) |
| Operations | 14 | 5 (`insertBlock`, `updateBlock`, `moveBlock`, `deleteBlock`, `setTitle`) |
| Nesting (`section`, `toggle`), `afterId` placement in a subtree | yes | **no** (flat documents only) |
| `conflictPolicy: "rebase-safe"`, `replaceText`, citations | yes | **no** |
| Undo and redo | yes | **no** |
| Markdown, HTML and text export; markdown import; stats | yes | **no** (`text_parts`, diff and revision summary only) |
| Actions table, OpenAPI and JSON Schemas | yes | **no** |

A server built now would have to accept documents it cannot validate and could answer only `/health`,
`/document` and a subset of `/transactions`. That is a demo, not an implementation of the contract, and it would
let invalid content be stored and served, so none was built.

### Proposed order (each step ends with conformance data and ports that reproduce it)

1. **Validation.** Export the TypeScript validator's verdicts (valid documents, and invalid ones with issue
   codes and paths) as `conformance/validation.v1.json`; port to Go and Python.
2. **Remaining operations and nesting**, extending `guarded-apply.v1.json` (the file is regenerated from the
   TypeScript reference, so the new scenarios come for free).
3. **Export** (`toMarkdown`, `toHTML`, `toPlainText`, `stats`). Word statistics need Unicode script data, which
   the Go and Python standard libraries lack; decide between a table generated from the reference and a
   dependency.
4. **HTTP**: the actions table and routes, with the OpenAPI document and JSON Schemas generated from the same
   TypeScript tables and checked in as data. Same contract and error codes as the TypeScript handler, plus the
   chart indicators server's conventions (catalog, stable error codes, limits).

Steps 1 and 2 are mostly mechanical now that the conformance machinery exists; step 3 carries the one real
design question; step 4 is small once the rest is true.

### Remaining

* Everything above. Undo/redo (session history) is the other piece that has to be ported before step 4 can
  claim the full contract.

## Iteration 2 (2026-11-08): the Go and Python servers

Iteration 1 found that a Go or Python server was not a thin layer yet and proposed four steps. All four are done, and each
ended with generated data that both ports reproduce.

### What was built

| Step | Result | Pinned by |
| --- | --- | --- |
| 1. Validation | Whole-document, transaction, actor, timestamp and URL validators with the reference's first-failure issues | `validation.v1.json` (1,437 cases) |
| 2. Operations | All 14 operations, nesting, `rebase-safe`, `replaceText`, citations, undo and redo, the revision log | `editor.v1.json` (39 scenarios, 1,146 steps) |
| 3. Export | Markdown, HTML, text, stats, outline, search and markdown import; word counting from Unicode script tables generated from the reference | `render.v1.json` |
| 4. HTTP | The 21 actions, every route, OpenAPI and the options, as a Go `http.Handler` and a Python handler with a WSGI adapter | `server.v1.json` (1,450 exchanges), `server-spec.v1.json` |

The action table, JSON Schemas, OpenAPI document, routes, limits and report templates are not re-typed in Go or Python:
`scripts/export-server-spec.ts` writes them once from the TypeScript package and a test fails when an embedded copy is
stale. Inputs are checked against the action schemas by a small JSON Schema subset (type, enum, const, bounds, length,
pattern, items, properties, required, `additionalProperties: false`, `anyOf`, local `$ref`) that reports the first failure
with the same message, path and hint as the reference.

### Behaviour that had to be copied by hand

These are the places where the obvious port differs from JavaScript, and what pins each one:

- String lengths are UTF-16 code units; `\s` is JavaScript's set; numbers print the way `String(number)` does.
- Object key order follows JavaScript (array-index keys first, then insertion order), because the first validation failure
  depends on it. Go decodes into an ordered object type for this; Python's dicts keep insertion order.
- Regexes that need backtracking (RE2 has no backreferences) are written by hand in Go; the one multiline `$` pattern maps
  `\r`, U+2028 and U+2029 to `\n` first.
- `fetch` labels a string body without a content type `text/plain`, which is how the reference produces its 415 answers; the
  tests do the same.

### Known differences (all outside what the shared data covers)

- Lone surrogates in strings are not supported in Go or Python; the reference accepts them.
- Characters outside the Basic Multilingual Plane are counted by code point in a few size limits, not by UTF-16 unit.
- The Unicode data of the running Go or Python can differ from Node's on a character added recently (word counts, case
  folding).
- Go's `net/http` refuses a malformed percent-escape in the request line before any handler runs, so those requests never
  reach it; the conformance test skips them and asserts there are only a few.
- A `HEAD` request returns the headers of the matching `GET`; the recorded bodies are not compared.

### Improvements made along the way

- `scripts/export-server-conformance.ts` replaces `crypto.randomUUID` with a counter, so the fixture is reproducible
  byte for byte; before, every regeneration changed every generated transaction id.
- The Go command and the Python runner can save the document after each accepted edit (`-save`, `--save`) by writing a
  temporary file and renaming it over the target.

### Remaining

- MCP is not ported; `POST /actions/{name}` exposes the same action table over HTTP.
- No authentication, rate limiting or persistence layer ships with either server; the handlers expect a gateway.
- The Rust backend (closed source) has to reproduce `server.v1.json` and `server-spec.v1.json` before it can claim the
  contract.

## Rounds of 15 (audit, fix, local gate, push)

### Round 1 (2026-11-08): concurrency of the Go and Python servers

- **Data race in the Go handler.** The OpenAPI document was built lazily without synchronization; two concurrent first
  requests wrote the same field. `go test -race` could not see it because no test was concurrent. Fixed with `sync.Once`,
  and `TestConcurrentRequests` (16 goroutines mixing reads, writes and the OpenAPI route) now fails without the fix under `-race`.
- **`-save` was not serialized** in the Go command or the Python runner: two simultaneous edits could interleave on the
  temporary file. Edits and their saves now run under one lock, so the file always holds the last accepted edit (checked
  with 8 threads x 10 edits against the Python runner: the file ended valid at revision 34; the 409s are the expected
  optimistic-concurrency answers for a stale base revision).
- The Go command now sets read, write and idle timeouts and a header size limit.
- Audit: `npm audit` (0 vulnerabilities), `go test -race ./...`, ruff, strict mypy and pytest are green.

### Round 5 (2026-11-08) — WSGI Content-Length

* Audit: the Python WSGI adapter and `python -m super_editor.server`. Locking is sound (`Editor` holds an
  `RLock`, `_Saving` serializes edit plus save). One bug: the adapter trusted `str.isdigit()` before
  `int()`, but `"²".isdigit()` is true and `int("²")` raises, so a hostile `Content-Length` escaped as an
  unhandled error (a bare 500) instead of the handler's 413.
* Fix: the adapter now matches `[0-9]+` (ASCII only). The handler already refuses anything else with 413.
* Tests: `tests/test_server_wsgi.py` (two cases; the non-ASCII one fails without the fix).
* Gate: `ruff check`, `ruff format --check`, strict `mypy`, `pytest` (16 tests, 3450 subtests) pass.

### Round 8 (2026-11-08) — CLI saves keep file permissions

* Audit: the TypeScript HTTP body reader (already streaming and bounded, `\d` is ASCII-only: fine) and the
  CLI's `persistAtomic`. The temporary file is created `0600` and renamed over the document, so a document
  shared with a group (`0640`, `0644`) became owner-only on its first CLI edit.
* Fix: for an overwrite, the temporary file takes the permission bits of the file it replaces; creating a
  new document is unchanged (`0600`).
* Test: `saving an edit keeps the permissions of the document it replaces` (fails without the fix; skipped on
  Windows).
* Gate: `npx tsc -b` and the TypeScript suite (267 tests) pass; Go and Python are untouched.

### Round 12 (2026-11-08) — three-way differential on hostile requests

* Audit: the same 39 hostile requests (BOMs, UTF-16, `1e400`, 400-digit integers, 50,000-deep JSON, duplicate
  and `__proto__` keys, malformed percent escapes, odd methods, bad query numbers and Markdown imports)
  through the TypeScript handler, the Go server and the Python handler, comparing status and first error
  code. Go and Python agree on every request. Two apparent differences are harness artefacts (Go's `net/http`
  rejects a malformed percent escape before the handler, as the conformance runner already knows; the Go
  server stamps real time, which sits before the fixture's future dates).
* Finding, in the TypeScript reference: the input checker looked a property up with `properties[key]`, so
  keys named like `Object.prototype` members (`__proto__`, `constructor`, `toString`, ...) found a "schema" and
  bypassed `additionalProperties: false`; Go and Python rejected them as unknown, TypeScript accepted them.
* Fix: own-property lookup (`Object.hasOwn`).
* Test: `tests/actions.test.ts` (fails without the fix).
* Gate: `npx tsc -b` and the TypeScript suite pass; Go and Python untouched and already correct.
