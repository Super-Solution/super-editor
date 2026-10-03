# @super-solution/editor-mcp

JSON-RPC MCP tool dispatcher over the same guarded Core report service used by HTTP and UI adapters.

```js
import { createDocument, createEditor, createReportService } from '@super-solution/editor-core';
import { createMcpDispatcher } from '@super-solution/editor-mcp';
const dispatch = createMcpDispatcher(createReportService(createEditor(createDocument({ id: 'weekly', title: 'Weekly' }))));
console.log(dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
```

Supports `tools/list`, `tools/call`, and tools `read_document` (`{}`), `apply_transaction` (`{ transaction }`), `undo` and `redo` (`{ actor, expectedRevision }`). Core's validation and version guards are authoritative. Protocol errors and invalid arguments do not mutate state.

This is a dispatcher adapter, not a complete initialized MCP server, network transport or authenticated hosted service. The host supplies initialization/session handling, caller authorization and persistence. ESM, Node.js 22+, Apache-2.0.
