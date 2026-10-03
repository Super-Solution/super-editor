# Super Editor v0.1 local integration contract

Verified 2026-10-03: the owner initialized upstream `main` with the Apache-2.0 LICENSE in commit `549d85b6b00682f34452d6e97fc1b3ca1c8a1698`. This implementation is based on that commit and preserves LICENSE unchanged. These private local workspace packages are not published.

- `@super-editor/core`: JSON v1 document, runtime validation, immutable `createEditor(document, options)`, `createDocument({id,title}, options)`, `parseDocument(json)`, `serializeDocument(document)`, and typed operations in `packages/core/src/types.ts`.
- `@super-editor/ui`: framework-independent `renderDocument(document, options)` / `mountEditor(container, editor, options)`, replaceable block and chart renderers. No DOM dependency in core.
- `@super-editor/react`: `useEditor(editor)`, `ReportView`, `ReportEditor`; renders the same core document and submits core transactions. Replaceable renderers and controls.
- `@super-editor/transports`: `createReportService(editor)`, HTTP request handler, MCP tool dispatcher, and local CLI use the same `editor.apply()` path. No trading or credentials in these packages.

Documents have `schemaVersion: 1`, monotonic `revision`, stable caller-assigned block IDs, ordered flat blocks with `parentId` pointing only to sections, citations with access/publication timestamps, and page/font formatting. Blocks include sections, H2/H3, paragraphs with typed inline marks/links, lists, tables, extensible chart specs (`pie`, `bar`, `trend` by default), URL-based SuperChart embed descriptors, and timestamps. No raw HTML block.

```ts
const editor = createEditor(createDocument({id: 'macro-weekly', title: 'Macro weekly'}));
const result = editor.apply({
  id: 'agent-20261003-1', actor: {id: 'research-agent', kind: 'agent'},
  baseRevision: editor.getSnapshot().revision,
  operations: [{type: 'insertBlock', block: {
    id: 'macro-summary', parentId: null, citationIds: [],
    content: {type: 'paragraph', runs: [{text: 'Illustrative research only.'}]}
  }}]
});
```

Each batch is atomic. A validation/conflict result commits nothing. Every update/move/delete supplies `expectedVersion`. Default stale-document behavior is `reject`. `rebase-safe` explicitly permits only version-guarded content updates on unchanged blocks, allowing an agent to update one block after a human changed a different block. Structural/metadata updates require the exact document revision. Same-block human edits require re-read and a new proposal. Never silently overwrite or retry by removing guards.

Transaction IDs support identical immediate retries; reusing an ID is an error except an exact retry of the latest successful apply. Older consumed IDs are rejected. The session stores up to 100,000 consumed IDs, then rejects new transactions rather than forgetting old IDs. The `history:` transaction ID prefix is reserved. Undo/redo are bounded session history with exact revision guards and create new revisions, preserving monotonic block versions and reserved IDs. The persistent `retiredBlockIds` reservation ledger can include active IDs restored by undo. JSON persistence saves document state, not the session undo/retry log. Durable history, authorization, storage concurrency, and real-time multi-user collaboration belong to the host.

`insertBlock` and `moveBlock` use `afterId`: omitted appends among siblings, `null` prepends, and a block ID inserts after that destination sibling. Deleting a section deletes its entire subtree, guarded by the exact document revision. A safe rebased update must preserve the block content type.

Runtime budgets: 5,000 blocks, section depth 64, 256 operations per batch, 2,000 citations, 20,000 chart points, chart value magnitude at most 1e15, and 8,000,000 serialized document characters. Only valid UTC ISO timestamps are accepted; timestamps cannot precede creation and editor clocks cannot run backward. HTTP additionally limits request bytes (default 1 MiB). See exported `LIMITS` for detailed field budgets.

HTTPS/HTTP links only; credentials and dangerous schemes are rejected. Embeds require HTTPS and an explicit host allowlist from the host application, defaulting to link-only display. Text uses DOM text nodes / escaped React content. Raw HTML is not accepted. Custom renderers are host-trusted code.

The public SuperChat/SuperChart API has not yet been verified. No guessed package import or claimed provider integration: SuperChat can call the service transaction contract; a host can register a real SuperChart renderer once its API and allowed origins are confirmed.
