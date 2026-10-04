# @super-solution/editor-core

Headless versioned research documents, typed atomic operations, stable block IDs, guarded revisions, serialization and bounded session undo/redo. No DOM, React, filesystem or network imports.

```js
import { createDocument, createEditor, createReportService } from '@super-solution/editor-core';
const editor = createEditor(createDocument({ id: 'weekly', title: 'Weekly research' }));
const service = createReportService(editor);
console.log(service.read());
```

`editor.apply(transaction)` checks `baseRevision` and block `expectedVersion`; rejected edits commit nothing. Default stale edits reject. `rebase-safe` permits only unchanged, version-guarded block content updates. Re-read after a conflicting human edit. Undo/redo require an exact document revision and are session state, not persisted audit history.

Helpers for agents and hosts (see docs/API-CONTRACT.md): `findBlocks`/`getOutline` to read, `b.*`, `chart.*`, `runs()` and the fluent `transaction(editor, actor)` to write, `toMarkdown`/`fromMarkdown`/`toHTML`/`toPlainText` to exchange, plus `stats`, `diffDocuments` and `summarizeRevision`.

```js
import { transaction, b, chart } from '@super-solution/editor-core';
const result = transaction(editor, { id: 'research-agent', kind: 'agent' })
  .insert([b.heading('h-1', 2, 'Price'), b.chart('c-1', chart.line({ title: 'BTC', labels: ['Mon', 'Tue'], values: [1, 2] }))])
  .commit(); // baseRevision and expectedVersion are filled from the snapshot
```

`documentSchema` and `transactionSchema` provide JSON Schema 2020-12 discovery; Core runtime validation additionally checks references, graph ordering, versions, dates and budgets. `createReportService` shares one Editor across adapters; actor IDs record provenance and do not authenticate a caller. The host owns authorization and persistence.

ESM, Node.js 22+ or a modern ES2022 browser/bundler. Apache-2.0; LICENSE is included. Research reporting only; no trade execution.

## Report templates

`createTemplate(kind, { idPrefix?, subject?, parentId? })` returns ordered `BlockInput[]` for an `insertBlocks` operation: `equity`, `macro`, `portfolio`, `strategy`, `arbitrage`, `comparison` or `blank` (also exported as `equityTemplate` and so on; `templateTitle`, `listTemplates`, `TEMPLATE_KINDS`). Templates are structure and guidance only (empty tables, placeholders, a "Data and methodology" section and an analysis-only note); they contain no data.

```js
import { createDocument, createEditor, createTemplate, templateTitle } from '@super-solution/editor-core';
const editor = createEditor(createDocument({ id: 'acme', title: templateTitle('equity', 'ACME') }));
editor.apply({ id: 'seed', actor: { id: 'agent', kind: 'agent' }, baseRevision: 0, operations: [{ type: 'insertBlocks', blocks: createTemplate('equity', { subject: 'ACME' }) }] });
```

## Agent actions

`AGENT_ACTIONS` is the table of semantic operations that the MCP tools, HTTP routes and CLI commands wrap: `get_outline`, `find_blocks`, `get_block`, `insert_blocks`, `update_block_text`, `replace_text`, `move_blocks`, `delete_blocks`, `add_chart`, `add_citation`, `insert_template`, `import_markdown`, exports and more. Each has a description, a JSON Schema and honest access flags; `runAgentAction(service, name, input, { actor })` validates the input, builds one guarded transaction and returns a compact result (`{ ok: true, revision, changed, blocks: [{ id, type, version }] }`) or `{ ok: false, issues, currentRevision }` with a hint on every issue. It never throws. A host can build its own tool surface from it, or use `@super-solution/editor-mcp`, `-api` and `-cli`. `ReportService.revisions?()` is optional so a host with durable history can list it. See [docs/API.md](../../docs/API.md).
