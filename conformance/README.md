# Conformance data

Language-neutral test data for the Super Editor core. The TypeScript editor in `packages/core` is the
reference; every other backend must reproduce these scenarios exactly.

| File | What it pins |
| --- | --- |
| `guarded-apply.v1.json` | Guarded transactions on flat paragraph documents: `insertBlock`, `updateBlock`, `moveBlock`, `deleteBlock`, `setTitle`. 14 scenarios, 308 steps, covering base-revision and per-block version conflicts, not-found, duplicate and retired block IDs, bad ordering anchors, a clock that moves backwards, atomic rollback of a half-valid batch, and idempotent retry of the last transaction |
| `validation.v1.json` | The validators: documents, transactions, actors and timestamps, each with the exact normalized value or the first issue (code, message, path, hint); 1,437 cases from hand-written edge cases plus seeded single mutations, 101 distinct failures. URL cases are marked `portRejects` where the reference accepts a form (IPv6, IDN hosts) the Go and Python ports refuse on purpose |
| `editor.v1.json` | The whole session editor: all 14 operations, nested sections and toggles, rebase-safe stale transactions, idempotent retry, undo and redo with history limits, the revision log, clock failures and version overflow. 39 scenarios, 1,146 steps: hand-written edge cases plus seeded random walks. Each step is `apply`, `undo` or `redo` with the clock, the input and the full outcome (document and revision, or every issue with message and hint) |
| `document-ops.v1.json` | Pure document functions: `text_parts` (the replaceable text of each of the 17 block types), `diff` (added, removed, changed and moved blocks, title, format and citation changes between two documents; 160 cases, 46 with moves) and `summarize_revision` (one-line history sentences for every operation type, 200 cases) |
| `render.v1.json` | The read side: inline markdown (`runs`, `inlineToPlain`, `runsToMarkdown`; 1,368 parsed strings plus 500 run lists), `fromMarkdown` (894 inputs, all block types, options and ID-prefix errors), and for 23 whole documents the Markdown, HTML (also standalone), plain-text export (default and bare variants), `stats`, `getOutline` and 529 `findBlocks` queries, plus `countWords` for Latin and CJK text |
| `server-spec.v1.json` | Not test data: the contract tables the TypeScript package generates and the Go and Python servers embed (the 21 action definitions with their JSON Schemas, the routes, the OpenAPI document, the document and transaction schemas, the limits and the report templates with a prefix and a subject placeholder). The copies in `backends/go/server/spec.json` and `backends/python/src/super_editor/server_spec.json` are byte-identical; a test fails when one is stale |
| `server.v1.json` | The HTTP layer: 14 scenarios, 1,450 requests with the clock, the request and the exact response (status, every header, JSON or text body). One scenario walks every route; one pins each option (body limit, read-only, fixed actor, base path, wildcard and exact CORS); six are seeded random walks steered by the live document (writes, conflicts, undo and redo, dry runs, rebase-safe retries); one sends mutated inputs to every action and odd JSON bodies. Generated ids (`import_markdown-<16 hex>`) are compared with the random suffix blanked |

In `guarded-apply.v1.json` each step gives the clock reading, the transaction and the exact outcome: the full document after a success, or
the issue codes and current revision after a refusal.

```bash
npx tsx --conditions=development scripts/export-conformance.ts   # regenerate guarded-apply from the TypeScript reference
npx tsx --conditions=development scripts/export-document-conformance.ts   # regenerate document-ops
npx tsx --conditions=development scripts/export-validation-conformance.ts # regenerate validation (seeded, deterministic)
npx tsx --conditions=development scripts/export-editor-conformance.ts     # regenerate the editor scenarios
npx tsx --conditions=development scripts/export-render-conformance.ts     # regenerate the read side (reads editor.v1.json)
npx tsx --conditions=development scripts/export-server-spec.ts            # regenerate the shared spec and its three copies
npx tsx --conditions=development scripts/export-server-conformance.ts     # regenerate the HTTP scenarios (seeded, deterministic)
npx tsx --conditions=development --test tests/conformance.test.ts # TypeScript still matches the file
(cd backends/go && go test ./...)                                 # Go port
(cd backends/python && pytest)                                    # Python port (ruff check . && mypy for lint and types)
```

If behaviour changes on purpose, regenerate, review the diff, and update every port. The Rust backend is
closed source and lives in a private repository; it tests against this same file.
