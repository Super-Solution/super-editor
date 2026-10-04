# @super-solution/editor-mcp

An MCP (Model Context Protocol) server for Super Editor documents: a stdio binary for a JSON file (`super-editor-mcp`) and the transport-free JSON-RPC core it is built on (`createMcpDispatcher`).

## Use with an MCP client

```sh
claude mcp add super-editor -- npx -y -p @super-solution/editor-mcp@next super-editor-mcp ./report.json --create --id report --template equity --subject ACME
```

```json
{ "mcpServers": { "super-editor": { "command": "npx", "args": ["-y", "-p", "@super-solution/editor-mcp@next", "super-editor-mcp", "/abs/report.json", "--actor", "claude:agent"] } } }
```

Options: `--actor <id[:kind]>`, `--read-only`, `--create --id <id> [--title] [--template <kind>] [--subject]`, `--help`, `--version`. Every accepted edit is saved atomically (under the same `<file>.lock` the CLI uses) before the tool call returns; edits made to the file by other tools are picked up before the next call.

## What it offers

- **25 tools**: the Core tools `read_document`, `apply_transaction`, `undo`, `redo` and 21 narrow ones: `get_outline`, `find_blocks`, `get_block`, `document_stats`, `export_markdown`, `export_html`, `export_text`, `list_revisions`, `list_templates`, `validate_transaction`, `insert_blocks`, `update_block_text`, `update_block`, `replace_text`, `move_blocks`, `delete_blocks`, `add_chart`, `add_citation`, `set_title`, `insert_template`, `import_markdown`. Each has a JSON Schema, a title and `readOnlyHint` / `destructiveHint` / `idempotentHint` annotations. Writes accept `dryRun`, `expectedRevision` and `transactionId`.
- **8 resources** (`super-editor://document`, `document.md`, `outline`, `stats`, `citations`, `schema/document`, `schema/transaction`, `guide`) and 2 templates (`block/{id}`, `section/{id}.md`).
- **4 prompts**: `draft_report`, `review_report`, `summarize_document`, `add_citations`.

Failures are normal tool results with `isError: true` and `{ ok: false, currentRevision, issues: [{ code, message, hint, path? }] }`. Core's version guards are authoritative: a stale `expectedVersion` is a conflict whose hint names the current version.

## Embed the dispatcher

```js
import { createDocument, createEditor, createReportService } from '@super-solution/editor-core';
import { createMcpDispatcher } from '@super-solution/editor-mcp';
const dispatch = createMcpDispatcher(createReportService(createEditor(createDocument({ id: 'weekly', title: 'Weekly' }))), { actor: { id: 'bot', kind: 'agent' }, readOnly: false });
const reply = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_outline', arguments: {} } });
```

The dispatcher implements `initialize`, `ping`, `tools/*`, `resources/*` and `prompts/*` for individual requests and notifications (no batches, no subscriptions). It has no transport or session state, so a host supplies the wire (`runStdioServer(argv, io)` for stdio), authentication, authorization and persistence. It imports no Node modules; only the `./stdio` entry point does.

Reference: [docs/API.md](../../docs/API.md#mcp). Agent workflow: [docs/AGENT-GUIDE.md](../../docs/AGENT-GUIDE.md). ESM, Node.js 22+, Apache-2.0.
