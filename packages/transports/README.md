# Shared service and local adapters

The adapters call one `Editor` instance and preserve the Core's `ApplyResult`,
atomic batches, stable IDs, revision guards, and safe URL validation.

```ts
import { createEditor, createDocument } from '@super-editor/core';
import {
  createReportService, createHttpHandler, createMcpDispatcher,
} from '@super-editor/transports';

const service = createReportService(createEditor(createDocument({
  id: 'weekly-report', title: 'Weekly research',
})));
const handleRequest = createHttpHandler(service);
const dispatchTool = createMcpDispatcher(service);
```

The host owns persistence, authentication, authorization, and access to each
editor. These adapters do not bind a network port or perform trading.

`documentSchema` and `transactionSchema` export JSON Schema 2020-12 structures
with stable IDs `urn:super-editor:document:1` and `urn:super-editor:transaction:1`.
They describe the v1 storage and operation shapes. Core validation remains
authoritative for graph relationships, citation references, timestamps, URL
safety, matching chart/table dimensions, combined size limits, and conflict
checks. A schema check alone does not authorize or validate a document edit.

| HTTP route | Body | Result |
| --- | --- | --- |
| `GET /document` | None | Current `ResearchDocument` |
| `POST /transactions` | Core `Transaction` | Core `ApplyResult` |
| `POST /undo` | `{actor, expectedRevision}` | Core `ApplyResult` |
| `POST /redo` | `{actor, expectedRevision}` | Core `ApplyResult` |

Successful mutation results return 200, revision/version conflicts 409, and
invalid/rejected requests 400. Unsupported routes/methods return 404/405. JSON
bodies default to a 1 MiB limit; `createHttpHandler(service, {maxBodyBytes})`
changes it. Mutation requests accept `application/json` or no Content-Type.
Responses use `Cache-Control: no-store`. The host must enforce authentication
and browser origin/CSRF policy before forwarding requests.

The JSON-RPC adapter supports `tools/list` and `tools/call` with these tools:

| Tool | Arguments |
| --- | --- |
| `read_document` | `{}` |
| `apply_transaction` | `{transaction: Transaction}` |
| `undo` | `{actor, expectedRevision}` |
| `redo` | `{actor, expectedRevision}` |

```json
{
  "jsonrpc": "2.0",
  "id": "research-edit-1",
  "method": "tools/call",
  "params": {
    "name": "apply_transaction",
    "arguments": {
      "transaction": {
        "id": "edit-1",
        "actor": {"id": "research-agent", "kind": "agent"},
        "baseRevision": 0,
        "operations": [{"type": "setTitle", "title": "Weekly research update"}]
      }
    }
  }
}
```

Tool results contain JSON in both MCP `content` text and `structuredContent`.
Rejected Core operations set `isError: true`; protocol failures use JSON-RPC
error codes. Parsed requests and JSON strings are accepted. Valid notifications
execute without a response; batch arrays are unsupported. This is a **tool
transport adapter**, not a complete initialized/authenticated MCP server.
Initialization, capability negotiation, sessions, stdio/HTTP wire transport,
and permissions must be implemented by the host before MCP deployment.
Parsed envelopes, parameters, and argument objects are inspected through own
data-property descriptors before use. Accessors and failed Proxy introspection
are rejected without invoking property getters.

The local CLI uses the same service:

```sh
npm run cli -- init report.json --id weekly-report --title "Weekly research"
npm run cli -- read report.json
npm run cli -- apply report.json transaction.json
npm run cli -- help
```

`init` refuses an existing file. `apply` reads a Core transaction from a JSON
file, validates the whole batch, and saves via an atomic sibling-file rename.
Rejected changes leave the original bytes untouched. An exclusive
`report.json.lock` coordinates CLI writers; external writers must use the same
lock protocol. A crash can leave a lock requiring manual inspection/removal.
This is local filesystem coordination, not durable distributed concurrency.
CLI output is JSON except help; exit codes are 0 success, 1 IO failure, 2 invalid
input, and 3 conflict. JSON persistence contains the document state; bounded
undo/redo and transaction retry records exist only in a live Editor session.
