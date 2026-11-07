# Backends

One folder per language. Each implements the same contract and is tested against the shared data in
[`../conformance`](../conformance/README.md). All code here is GPL-3.0-or-later; the AGPL servers are the
TypeScript `api` and `mcp` packages.

| Folder | Status |
| --- | --- |
| `typescript/` | Reference implementation: `api` (HTTP) and `mcp` servers |
| `go/` | Proof of concept: guarded transactions on flat documents |
| `python/` | Proof of concept: the same guarded transactions |

The proofs of concept cover the guarded-write rules only (version and revision guards, atomic apply, retired
IDs, idempotent retry) for five operation types. They do not validate content, support nesting, undo or redo,
or serve HTTP/MCP.
