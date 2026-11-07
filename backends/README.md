# Backends

One folder per language. Each implements the same contract and is tested against the shared data in
[`../conformance`](../conformance/README.md). All code here is GPL-3.0-or-later; the AGPL servers are the
TypeScript `api` and `mcp` packages.

| Folder | Status |
| --- | --- |
| `typescript/` | Reference implementation: `api` (HTTP) and `mcp` servers |
| `go/` | Proof of concept: `guarded` (transactions on flat documents) and `documents` (block text, document diff, revision summaries) |
| `python/` | Proof of concept: the same, as `super_editor` (src layout, typed) |

The proofs of concept cover the guarded-write rules (version and revision guards, atomic apply, retired
IDs, idempotent retry) for five operation types, plus the pure document functions. They do not validate whole
documents, support nesting, undo or redo, export markdown/HTML, or serve HTTP/MCP.
