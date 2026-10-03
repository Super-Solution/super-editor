# Super Editor

Agent-first research report editor: headless versioned documents and guarded operations, with replaceable DOM and React presentation layers.

This is a local vertical slice for macro, stock, ETF, portfolio, and arbitrage **research reports**. It contains fictional examples and no brokerage, order execution, account data, or private application code.

## Status and licensing

The owner added the [Apache License 2.0](LICENSE) to upstream on 2026-10-03. This implementation preserves that LICENSE unchanged. The root workspace stays private; its six library packages declare `Apache-2.0` and include LICENSE, built ESM, declarations and package READMEs. The first release candidate is `0.1.0-next.0` on the `next` channel; see [controlled npm releases](docs/RELEASING.md).

Public SuperChat / SuperChart APIs could not be verified. Their integration points are custom host adapter contracts, not claims of working official SDK integration.

## Run locally

Node.js 22+ is required (validated on Node 24).

```sh
npm ci --ignore-scripts
npm run check
npm run build:demo
npm run example
npm run dev
```

Open the localhost URL printed by Vite. The React demo includes a research notebook, nested sections, H2/H3, typed inline formatting, tables, pie/bar/trend charts, citations, timestamps, page formatting, paragraph editing, undo/redo, JSON export, and an agent proposal conflict demonstration.

## Packages

| Package | Responsibility |
| --- | --- |
| `@super-solution/editor-core` | JSON schema v1, runtime validation, immutable snapshots, atomic typed operations, revisions and session history |
| `@super-solution/editor-ui` | DOM rendering and controls, block/chart renderer registry, CSS tokens, safe embed policy |
| `@super-solution/editor-react` | React subscription hook and composable report view/editor |
| `@super-solution/editor-api` | HTTP Request/Response adapter over Core's shared report service |
| `@super-solution/editor-mcp` | MCP JSON-RPC tool dispatcher over the same Core service |
| `@super-solution/editor-cli` | Local JSON files, lock and atomic replacement through Core |

Core imports no DOM, React, HTTP, or filesystem APIs. UI and React submit the same validated transactions as API, MCP and CLI. Build emits ESM and declarations into each package's `dist/`; public exports use built files, with TypeScript source paths only in the workspace compiler. `npm run release:check` packs and inspects all six artifacts and tests them in a separate consumer installation. No credentials are needed for this verification.

See [API contract](docs/API-CONTRACT.md), [architecture](docs/ARCHITECTURE.md), [security and host responsibilities](docs/SECURITY.md), and [provider verification](docs/PROVIDER-VERIFICATION.md). A working report fixture is in [examples/report.ts](examples/report.ts); [examples/headless.ts](examples/headless.ts) demonstrates a rejected stale agent edit.

Machine-readable discovery schemas are in [schemas/document-v1.schema.json](schemas/document-v1.schema.json) and [schemas/transaction-v1.schema.json](schemas/transaction-v1.schema.json). Core runtime validation additionally enforces semantic guards such as parent/citation references, ordering, versions, timestamps, and numeric budgets. Serialized fixtures live in `examples/fixtures/`.

The default stylesheet uses neutral inherited `--se-*` tokens; see [UI theme customization](packages/ui/README.md). Consumers can replace controls and renderers and override tokens without importing React or coupling their branding to Core. Paragraph controls are plain text editors: changing text replaces that paragraph's inline marks; unchanged text retains them. Rich text editing is a future extension.

## Minimal headless use

```ts
import { createDocument, createEditor, serializeDocument } from '@super-solution/editor-core';

const editor = createEditor(createDocument({ id: 'report-1', title: 'Macro weekly' }));
const result = editor.apply({
  id: 'proposal-1', actor: { id: 'research-agent', kind: 'agent' }, baseRevision: 0,
  operations: [{ type: 'insertBlock', block: {
    id: 'summary', parentId: null, citationIds: [],
    content: { type: 'paragraph', runs: [{ text: 'Draft thesis for human review.' }] }
  }}]
});
if (result.ok) console.log(serializeDocument(result.document));
else console.log(result.issues);
```

Each batch commits all operations or none. Stable block IDs and expected block versions allow precise incremental updates. Stale transactions reject by default; explicitly opted-in safe rebasing applies only to updates of unchanged blocks. A conflicting human edit is retained. Re-read the affected block and submit a new proposal for review.

Undo/redo and transaction retry records are bounded session state. JSON exports include the validated document and reserved block IDs; they do not include persisted audit/undo history. HTTP/MCP are adapters for host applications, not authenticated hosted services or a full MCP session implementation. This slice does not implement Word-compatible rich text/import/export, CRDT/OT collaboration, multi-user presence, pagination fidelity, or persistent collaborative storage.
