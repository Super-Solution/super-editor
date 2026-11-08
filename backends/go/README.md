# Super Editor, Go

- `guarded`: guarded transactions on flat documents (base-revision and block-version guards, atomic apply,
  retired ids, idempotent retry).
- `documents`: block text extraction (`TextParts`), the structural diff between two documents
  (`DiffDocuments`) and one-line revision summaries (`SummarizeRevision`).

- `validation`: the document, transaction, actor, timestamp and URL validators (`ValidateDocument`, `ValidateTransaction`,
  `ReadActor`, `Timestamp`, `SafeURL`) with the reference's first-failure issues, JavaScript string lengths and key order.
  `Decode` reads JSON keeping member order.

The TypeScript package in `packages/core` is the reference; both packages reproduce every case in
[`../../conformance`](../../conformance/README.md). Standard library only.

```bash
go test ./...                              # conformance cases
go test ./documents -bench . -benchmem     # about 18 µs per document diff of a few blocks
go vet ./... && gofmt -l .
```

GPL-3.0-or-later; a commercial licence is available from SUPER SOLUTION LABS INC (contact@supersolution.io).
