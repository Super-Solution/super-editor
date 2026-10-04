# @super-solution/editor-api

HTTP `Request` / `Response` adapter and typed client over a shared Core report service. It does not start a server, authenticate users or persist documents: the host does that.

```js
import { createDocument, createEditor, createReportService } from '@super-solution/editor-core';
import { createHttpHandler, createHttpClient } from '@super-solution/editor-api';

const service = createReportService(createEditor(createDocument({ id: 'weekly', title: 'Weekly' })));
const handle = createHttpHandler(service, { actor: request => ({ id: userFrom(request), kind: 'agent' }) });
const response = await handle(new Request('https://example.invalid/outline'));

// Typed client (works against any server that mounts the handler)
const client = createHttpClient({ baseUrl: 'https://host.example.com/api', headers: { authorization: `Bearer ${token}` } });
const found = await client.actions.find_blocks({ type: 'chart' });
const edit = await client.actions.update_block_text({ blockId: 'summary', expectedVersion: 3, text: 'New **text**.' });
if (!edit.ok) console.log(edit.issues[0].hint); // refused edits are returned, not thrown
```

## Routes

`GET /health`, `/document`, `/outline`, `/blocks?type=&q=&parentId=&within=&ids=&citationId=&limit=&offset=&include=`, `/blocks/{id}`, `/stats`, `/revisions`, `/export.md`, `/export.html`, `/export.txt`, `/templates`, `/templates/{kind}`, `/actions`, `/openapi.json`, `/schemas/document.json`, `/schemas/transaction.json`; `POST /transactions`, `/undo`, `/redo`, `/import/markdown`, `/actions/{name}` (any of the 21 semantic actions by name: `insert_blocks`, `update_block_text`, `replace_text`, `move_blocks`, `delete_blocks`, `add_chart`, `add_citation` and more). `GET /openapi.json` is an OpenAPI 3.1 document generated from the live route and action tables (`createOpenApiDocument()`).

Every failure has one JSON shape: `{ ok: false, currentRevision, issues: [{ code, message, hint, path?, blockId? }] }`. Status codes: 400 invalid, 403 read-only, 404 not found, 405 wrong method (with `Allow`), 409 conflict, 413 body too large, 415 not JSON. Accepted edits are 200. Atomic operations and version guards come from Core.

## Options

`maxBodyBytes` (default 1 MiB), `actor` (a fixed actor or a function of the request; wins over a body `actor`), `readOnly`, `cors` (`{ origins: '*' | string[], headers?, maxAge? }`, off by default), `basePath`, `now`. Responses use `Cache-Control: no-store`. Generated HTML exports carry a restrictive `Content-Security-Policy`.

The host must authenticate and authorize callers and enforce origin/CSRF policy before forwarding requests. The actor in a request is provenance, not authentication. `createReportService` is re-exported from Core. Full reference: [docs/API.md](../../docs/API.md); agent workflow: [docs/AGENT-GUIDE.md](../../docs/AGENT-GUIDE.md). ESM, Node.js 22+ (any runtime with `fetch`), Apache-2.0. No trading or credential storage.
