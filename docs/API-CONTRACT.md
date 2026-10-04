# Super Editor local integration contract (v0.1 baseline, v0.2 additions)

The owner initialized upstream `main` with the Apache-2.0 LICENSE in commit `549d85b6b00682f34452d6e97fc1b3ca1c8a1698`; LICENSE is preserved unchanged. The six `@super-solution/editor-*` packages share version `0.1.0-next.0` for the first `next` prerelease. The root workspace remains private. These names replace the earlier unpublished `@super-editor/*` contract.

- `@super-solution/editor-core`: JSON v1 document, runtime validation, immutable `createEditor(document, options)`, `createDocument({id,title}, options)`, `parseDocument(json)`, `serializeDocument(document)`, and typed operations in `packages/core/src/types.ts`.
- `@super-solution/editor-ui`: framework-independent `renderDocument(document, options)` / `mountEditor(container, editor, options)`, replaceable block and chart renderers. No DOM dependency in core.
- `@super-solution/editor-react`: `useEditor(editor)`, `ReportView`, `ReportEditor`; renders the same core document and submits core transactions. Replaceable renderers and controls.
- `@super-solution/editor-core` also exports `createReportService(editor)`, `ReportService`, and document/transaction discovery schemas. The facade shares an Editor; it contains no network or filesystem logic.
- `@super-solution/editor-api`: `createHttpHandler(service)` uses native Request/Response and the shared Core service.
- `@super-solution/editor-mcp`: `createMcpDispatcher(service)` provides JSON-RPC tool discovery/calls over the same service.
- `@super-solution/editor-cli`: `runCli`, `CLI_HELP`, and the `super-editor` binary perform guarded local JSON operations. There is no aggregate transports package, trading or credential storage.

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

## v0.2 core additions (schemaVersion stays 1)

Everything below is additive and optional: documents and transactions written for v0.1 stay valid.

- Inline marks: `strike`, `underline`, `highlight` (`yellow|green|blue|pink|gray`) and `citationId`, an inline citation marker that must reference an id in `document.citations`.
- Block types: heading level 1, `quote`, `callout` (`info|success|warning|danger|note`), `code`, `divider`, `image` (HTTPS only), `toggle` (a container like `section`), `metrics`, `toc`, `pageBreak`. Lists gain `style` (`bullet|number|todo`), `checked[]` and `indent[]` (0 to 3 per item); tables gain `align[]`, `caption` and `headerColumn`; embeds gain `height` (200 to 1200).
- Chart kinds `line`, `area`, `donut`, `scatter`, `histogram`, `candlestick`, `heatmap`, `waterfall` next to `pie`, `bar`, `trend`; unknown kinds remain valid and show a data table. Optional chart fields: `stacked`, `horizontal`, `yAxis`, `xLabel`, `caption`, `source`, `annotations`, per-series `color`, and the typed data `points` (scatter), `ohlc` (candlestick), `matrix` (heatmap). `labels` and `series` stay required for every kind and carry the fallback data table.
- Containers: `section` and `toggle` may parent blocks. Anything else as a parent is rejected.
- Operations: `insertBlocks` (ordered, all-or-nothing), `duplicateBlock` (deep copy; `newIds` maps the block and every descendant), `replaceText` (case-insensitive unless `caseSensitive`, first match unless `all`, matches may span inline runs, `not-found` when nothing matches), `deleteBlocks`, `moveBlocks`, `updateCitation` and `removeCitation` (also strips `citationIds` entries and inline `citationId` markers). `replaceText` may rebase like `updateBlock`; every other new operation needs the exact document revision.
- Issues may carry `hint`, an actionable remediation (for example the current block version after a conflict, or the allowed properties after an unknown one).
- `LIMITS` gained the v0.2 field budgets (`blocksPerOperation`, `annotations`, `ohlc`, `heatmapCells`, `metrics`, `embedHeightMin/Max`, and others). The runtime also exports `BLOCK_TYPES`, `CHART_KINDS`, `HIGHLIGHTS`, `CALLOUT_TONES`, `OPERATION_TYPES`, `CONTAINER_TYPES` and `isContainerType`.
- Flat block order is kept in pre-order (a container is followed by its subtree) for blocks the editor places, but consumers must still walk `parentId` rather than rely on it.


## v0.2 helper modules (`@super-solution/editor-core`, pure TypeScript, no DOM)

- **Query:** `findBlocks(doc, { type, text, caseSensitive, parentId, ids, citationId, within, limit })`, `getBlock`, `childrenOf`, `ancestorsOf` (outermost first), `descendantsOf`, `orderedBlocks` (reading order), `getOutline(doc)` (`{ id, type: 'section' | 'heading', title, level, children }[]`) and `blockText(block)`.
- **Builders:** `b.<blockType>(id, ...)` returns a `BlockInput` for every block type (last argument `{ parentId, citationIds, ... }`); ``runs('**b** _i_ ~~s~~ `c` [l](https://...) [^cite-id]')`` parses inline markdown-lite, `plainRuns(text)` does not; `chart.<kind>({...})` returns a `ChartSpec` and fills the labels/series fallback for scatter, candlestick and heatmap; `op.<operation>(...)` returns each `Operation`; `createBlockId(prefix, reservedOrDocument)` and `reservedIds(doc)` mint unused IDs.
- **Fluent transactions:** `transaction(editor, actor, { id?, conflictPolicy? })` collects `.insert()`, `.update()`, `.replaceText()`, `.move()`, `.remove()`, `.duplicate()`, `.setTitle()`, `.setFormat()`, `.addCitation()`, `.updateCitation()`, `.removeCitation()`. It takes `baseRevision` and every `expectedVersion` from the snapshot at creation time and tracks blocks changed earlier in the same batch. `.commit()` applies it and returns an `ApplyResult`; unknown block IDs come back as `not-found` issues, and a concurrent edit makes `.commit()` fail with `conflict`.
- **Export and import:** `toMarkdown(doc)` (GFM tables, GitHub alerts, footnotes; charts become data tables), `fromMarkdown(md, { idPrefix, parentId? })` returns `BlockInput[]`, `toHTML(doc, { standalone? })` returns escaped static HTML without scripts or iframes, and `toPlainText(doc)`.
- **Analysis:** `stats(doc)` (words with CJK-aware counting, characters, blocks by type, charts, tables, images, citations, `readingMinutes`), `diffDocuments(a, b)` (`added`, `removed`, `changed`, `moved` block IDs plus title, format and citation changes) and `summarizeRevision(revision)` (one sentence).
- **Issues:** every failed `apply` carries a `hint`. `withHints`, `defaultHint` and `formatIssues` are available for validation results and for CLI or model-facing messages.
