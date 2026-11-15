# Persistence: documents that live in a database

`ReportService` (`read`, `apply`, `undo`, `redo`) is synchronous because it wraps an in-memory editor. A host whose documents live in a database, an object store or another service implements **`DocumentStore`** instead (two methods) and gets everything else: guarded transactions, idempotent retries, the HTTP handler and the semantic actions.

```ts
import { createStoreService, type DocumentStore } from '@supersolutions/super-editor-core';
import { createHttpHandler } from '@supersolutions/super-editor-api';

const store: DocumentStore = {
  load: async () => (await db.row('select doc from reports where id = $1', [id]))?.doc,
  // Compare-and-swap: write only if the stored revision is still `expectedRevision`.
  save: async (document, expectedRevision, revision) => {
    const updated = await db.exec('update reports set doc = $2, revision = $3 where id = $1 and revision = $4', [id, document, document.revision, expectedRevision]);
    return updated === 1 ? { ok: true } : { ok: false };
  },
  // Optional: an audit log of accepted changes. With it, an exact retry of an accepted transaction answers `duplicate: true`.
  revisions: async () => db.rows('select revision from report_revisions where id = $1 order by number', [id]),
};

const service = createStoreService(store);         // AsyncReportService
const handler = createHttpHandler(service);          // the same routes, status codes and OpenAPI as the in-memory handler
```

## What `createStoreService` does

For each write it loads the document, applies the transaction with the usual guards (document revision, per-block versions, validation, rebase-safe policy) and calls `store.save(document, expectedRevision, revision)`. If `save` answers `{ ok: false }` because another writer got there first, **nothing is written** and the caller gets a `conflict` failure with the current revision; the caller re-reads and decides. Writes through one service object are serialized.

- **The store owns atomicity.** `save` must be a real compare-and-swap (a conditional `UPDATE`, a version check in a transaction, an `If-Match`). The core cannot make a read-then-write safe by itself.
- **No session history.** Undo and redo answer a `history` issue; apply a new transaction that reverses the change. Hosts that want undo keep their own revision log.
- **Timestamps** use a clock that never runs behind the document's `updatedAt`; pass `{ now }` to control it.
- **`createMemoryStore(document)`** is a store with real CAS semantics for tests, prototypes and single-process hosts.

## Stateless use

```ts
import { applyToDocument } from '@supersolutions/super-editor-core';

const result = applyToDocument(document, transaction);   // no session, nothing kept; the input is not modified
if (result.ok) await save(result.document);
```

## Actions and HTTP over a store

`runAgentActionAsync(service, name, input, context)` runs the 21 semantic actions over an `AsyncReportService`. `createHttpHandler` accepts either kind of service: with a store, each request reads the document once, runs the route on that copy and writes what it applied through the service (so the compare-and-swap decides). A lost race answers `409` with `currentRevision`; a store that cannot load answers a JSON `500`. `openSnapshot(service)` is the building block for hosts that want to run their own synchronous code on a store.

## Reviewing an agent's proposal first

`reviewProposal(document, transaction)` previews a transaction without applying it (status `ready`, `stale` or `invalid`, a one-sentence summary, the blocks that would be added, changed, removed or moved with before and after text). The React `ProposalReview` panel renders it with Accept and Reject. See [INTEGRATION.md](INTEGRATION.md#reviewing-agent-changes).
