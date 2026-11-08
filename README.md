# Super Editor

Agent-first research report editor: headless versioned documents and guarded operations, with replaceable DOM and React presentation layers.

This is a local vertical slice for macro, stock, ETF, portfolio, and arbitrage **research reports**. It contains fictional examples and no brokerage, order execution, account data, or private application code.

## Where things live

Folders group packages by role, so another UI framework or language is one more folder. npm names do not depend on the folder.

```
packages/core, ui, cli      headless model, DOM renderer, command line
packages/bindings/          one folder per UI framework: react, element (web component)
packages/integrations/      chat-plugin (super-chat)
backends/typescript/        api, mcp (AGPL servers)
backends/go, backends/python  the full core, read side and HTTP server in Go and Python, tested against conformance/
```

## Status and licensing

Version `0.1.0`. The repository history and version numbers were reset on 2026-11-07; earlier prerelease versions on npm are superseded.

Super Editor is **dual-licensed** by SUPER SOLUTION LABS INC:

| Package | License |
| --- | --- |
| `@supersolutions/super-editor-core`, `-ui`, `-react`, `-cli`, and everything else in this repository | [GPL-3.0-or-later](LICENSES/GPL-3.0-or-later.txt) |
| `@supersolutions/super-editor-api`, `@supersolutions/super-editor-mcp`, the Go `server` package and `cmd/super-editor-server`, the Python `super_editor.server` package (server components) | [AGPL-3.0-or-later](LICENSES/AGPL-3.0-or-later.txt) |

You may use, modify and redistribute these packages under those terms, which include sharing your own source code when you distribute a combined work (and, for the AGPL packages, when users interact with a modified version over a network). If you want to use Super Editor in a closed-source product, or otherwise cannot comply with the GPL/AGPL, buy a **commercial license** from SUPER SOLUTION LABS INC: [contact@supersolution.io](mailto:contact@supersolution.io).

Each source file carries an `SPDX-License-Identifier` header, and each published package includes the license text that applies to it. The root `LICENSE` is the GPL-3.0 text. The root workspace stays private. See [controlled npm releases](docs/RELEASING.md).

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

Open the localhost URL printed by Vite. The React demo is a small workspace built from the packages the way a host would use them: a page switcher (two fixtures and every report template), the interactive `ReportEditor`, an outline that follows the page, find and replace, History with diffs and restore, an Agent panel that drives `runAgentAction` (a refused stale edit, a rebase-safe one, dry runs), Sources, theme and density switches, a save indicator, and JSON, Markdown, HTML, text and print export. Its code is the composition example: see [examples/README.md](examples/README.md#the-workspace-demo).

## Packages

| Package | Responsibility |
| --- | --- |
| `@supersolutions/super-editor-core` | JSON schema v1, runtime validation, immutable snapshots, atomic typed operations, revisions and session history |
| `@supersolutions/super-editor-ui` | DOM rendering and controls, block/chart renderer registry, CSS tokens, safe embed policy |
| `@supersolutions/super-editor-react` | React subscription hook and composable report view/editor |
| `@supersolutions/super-editor-element` | `<super-editor>` web component: view or edit a document in any framework |
| `@supersolutions/super-editor-chat-plugin` | super-chat plugin (Apache `super-protocol` contract) that shows documents as chat cards |
| `@supersolutions/super-editor-api` | HTTP Request/Response adapter over Core's shared report service |
| `@supersolutions/super-editor-mcp` | MCP JSON-RPC tool dispatcher over the same Core service |
| `@supersolutions/super-editor-cli` | Local JSON files, lock and atomic replacement through Core |

Core imports no DOM, React, HTTP, or filesystem APIs. UI and React submit the same validated transactions as API, MCP and CLI. Build emits ESM and declarations into each package's `dist/`; public exports use built files, with TypeScript source paths only in the workspace compiler. `npm run release:check` packs and inspects all eight artifacts and tests them in a separate consumer installation. No credentials are needed for this verification.

See [API contract](docs/API-CONTRACT.md), [architecture](docs/ARCHITECTURE.md), [security and host responsibilities](docs/SECURITY.md), and [provider verification](docs/PROVIDER-VERIFICATION.md). A working report fixture is in [examples/report.ts](examples/report.ts); [examples/headless.ts](examples/headless.ts) demonstrates a rejected stale agent edit.

Machine-readable discovery schemas are in [schemas/document-v1.schema.json](schemas/document-v1.schema.json) and [schemas/transaction-v1.schema.json](schemas/transaction-v1.schema.json). Core runtime validation additionally enforces semantic guards such as parent/citation references, ordering, versions, timestamps, and numeric budgets. Serialized fixtures live in `examples/fixtures/`.

The default stylesheet uses neutral inherited `--se-*` tokens; see [UI theme customization](packages/ui/README.md). Consumers can replace controls and renderers and override tokens without importing React or coupling their branding to Core. Paragraph controls are plain text editors: changing text replaces that paragraph's inline marks; unchanged text retains them. Rich text editing is a future extension.

## Drive it from an agent

Three transports wrap the same guarded operations, so an agent can use whichever it already speaks:

- **MCP**: `npx -y -p @supersolutions/super-editor-mcp super-editor-mcp ./report.json --create --id report --template equity` serves a JSON file to Claude Desktop, Claude Code, Cursor or any MCP client: 25 tools with schemas and read-only / destructive annotations, resources, prompts.
- **CLI**: `super-editor outline | find | insert | update-text | replace | move | delete | chart | cite | export | import | stats` with `--json` and exit codes (3 conflict, 4 not found).
- **HTTP**: `createHttpHandler(service)` (a fetch-style handler), `GET /openapi.json`, a typed `createHttpClient`.

Edits that overwrite or delete name the block version the agent last read, so a stale proposal is refused with a hint instead of overwriting a person's work. Report templates (`equity`, `macro`, `portfolio`, `strategy`, `arbitrage`, `comparison`) give the agent a skeleton to fill. Start with the [agent guide](docs/AGENT-GUIDE.md); the reference is [docs/API.md](docs/API.md), the threat notes are in [docs/SECURITY.md](docs/SECURITY.md), runnable samples are in [examples/](examples/README.md), and changes are in the [changelog](CHANGELOG.md).

## Minimal headless use

```ts
import { createDocument, createEditor, serializeDocument } from '@supersolutions/super-editor-core';

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
