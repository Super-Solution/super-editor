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
