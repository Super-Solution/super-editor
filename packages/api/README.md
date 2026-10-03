# @super-solution/editor-api

HTTP Request/Response adapter over a shared Core report service. It does not start a server, authenticate users or persist documents.

```js
import { createDocument, createEditor, createReportService } from '@super-solution/editor-core';
import { createHttpHandler } from '@super-solution/editor-api';
const handle = createHttpHandler(createReportService(createEditor(createDocument({ id: 'weekly', title: 'Weekly' }))));
const response = await handle(new Request('https://example.invalid/document'));
```

Routes: `GET /document`, `POST /transactions` (Core transaction), `POST /undo` and `/redo` (`{ actor, expectedRevision }`). Accepted edits return 200, conflicts 409, invalid requests 400. Atomic operations and guards come from Core. JSON bodies default to a 1 MiB byte limit, configurable with `{ maxBodyBytes }`. Responses use `Cache-Control: no-store`.

The host must authenticate and authorize callers and enforce origin/CSRF policy before forwarding requests. `createReportService` and its type are re-exported from Core for convenience. ESM, Node.js 22+, Apache-2.0. No trading or credential storage.
