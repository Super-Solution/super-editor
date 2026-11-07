# Conformance data

Language-neutral test data for the Super Editor core. The TypeScript editor in `packages/core` is the
reference; every other backend must reproduce these scenarios exactly.

| File | What it pins |
| --- | --- |
| `guarded-apply.v1.json` | Guarded transactions on flat paragraph documents: `insertBlock`, `updateBlock`, `moveBlock`, `deleteBlock`, `setTitle`. 14 scenarios, 308 steps, covering base-revision and per-block version conflicts, not-found, duplicate and retired block IDs, bad ordering anchors, a clock that moves backwards, atomic rollback of a half-valid batch, and idempotent retry of the last transaction |
| `document-ops.v1.json` | Pure document functions: `text_parts` (the replaceable text of each of the 17 block types), `diff` (added, removed, changed and moved blocks, title, format and citation changes between two documents; 160 cases, 46 with moves) and `summarize_revision` (one-line history sentences for every operation type, 200 cases) |

In `guarded-apply.v1.json` each step gives the clock reading, the transaction and the exact outcome: the full document after a success, or
the issue codes and current revision after a refusal.

```bash
npx tsx --conditions=development scripts/export-conformance.ts   # regenerate guarded-apply from the TypeScript reference
npx tsx --conditions=development scripts/export-document-conformance.ts   # regenerate document-ops
npx tsx --conditions=development --test tests/conformance.test.ts # TypeScript still matches the file
(cd backends/go && go test ./...)                                 # Go port
(cd backends/python && pytest)                                    # Python port (ruff check . && mypy for lint and types)
```

If behaviour changes on purpose, regenerate, review the diff, and update every port. The Rust backend is
closed source and lives in a private repository; it tests against this same file.
