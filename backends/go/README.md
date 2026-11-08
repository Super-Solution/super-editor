# Super Editor, Go

- `guarded`: guarded transactions on flat documents (base-revision and block-version guards, atomic apply,
  retired ids, idempotent retry).
- `documents`: block text extraction (`TextParts`), the structural diff between two documents
  (`DiffDocuments`) and one-line revision summaries (`SummarizeRevision`).

- `editor`: the session editor: guarded transactions over the full model (17 block types, nesting), all 14
  operations, rebase-safe stale transactions, undo and redo, the revision log (`editor.New`, `Apply`, `Undo`, `Redo`).
- `render`: the read side: inline markdown (`ParseInline`, `RunsToMarkdown`), Markdown, HTML and plain-text export
  (`ToMarkdown`, `ToHTML`, `ToPlainText`), `Stats`, `CountWords`, `Outline`, `FindBlocks` and block-level markdown
  import (`FromMarkdown`).
- `validation`: the document, transaction, actor, timestamp and URL validators (`ValidateDocument`, `ValidateTransaction`,
  `ReadActor`, `Timestamp`, `SafeURL`) with the reference's first-failure issues, JavaScript string lengths and key order.
  `Decode` reads JSON keeping member order.

- `server`: the 21 actions (`RunAction`) and the HTTP API (`NewHandler`, a plain `http.Handler`) with the same routes, status
  codes, headers and OpenAPI document as the TypeScript handler; options for the body limit, read-only mode, a fixed
  actor, a base path and CORS. It binds no port and authenticates nobody. AGPL-3.0-or-later.
- `cmd/super-editor-server`: serves one document file (`go run ./cmd/super-editor-server -document report.json -save`).
  Flags: `-addr`, `-read-only`, `-save`, `-base-path`, `-cors`, `-max-body-bytes`.

The TypeScript package in `packages/core` is the reference; the packages reproduce every case in
[`../../conformance`](../../conformance/README.md). Standard library only.

```bash
go test ./...                              # conformance cases
go test ./documents -bench . -benchmem     # about 18 µs per document diff of a few blocks
go vet ./... && gofmt -l .
```

GPL-3.0-or-later (the `server` package and `cmd` are AGPL-3.0-or-later); a commercial licence is available from SUPER SOLUTION LABS INC (contact@supersolution.io).
