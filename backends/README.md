# Backends

One folder per language. Each implements the same contract and is tested against the shared data in
[`../conformance`](../conformance/README.md). The libraries are GPL-3.0-or-later; the servers (the TypeScript `api`
and `mcp` packages, the Go `server` package and `cmd/super-editor-server`, the Python `super_editor.server`
package) are AGPL-3.0-or-later.

| Folder | Status |
| --- | --- |
| `typescript/` | Reference implementation: `api` (HTTP) and `mcp` servers |
| `go/` | The full core (validation, 14 operations, nesting, rebase-safe, undo/redo), the read side (Markdown/HTML/text export, markdown import, stats, outline, search) and the HTTP server with the same contract as the TypeScript handler |
| `python/` | The same, as `super_editor` (src layout, typed): `super_editor.server` is a framework-neutral handler with a WSGI adapter and a `python -m super_editor.server` runner |

Every behaviour is pinned by generated data: `validation`, `editor`, `document-ops`, `render` and, for the HTTP layer,
`server.v1.json` (1,450 recorded requests and responses, including every option). MCP is not ported: the HTTP
`POST /actions/{name}` route exposes the same action table.
