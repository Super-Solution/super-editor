# Engineering improvement log

Newest first. Each iteration records what was found, decided and checked, and what is left.

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
