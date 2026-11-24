# Architecture and boundaries

```text
Trading / SuperChat / other host agents
      HTTP / MCP / CLI / direct service
                       |
                core Editor.apply
                       |
           validated immutable v1 document
                    /     \
              DOM UI      React hook + view/editor
                  \         /
              host block/chart renderers
```

The dependency direction is Core -> nothing, Opc -> nothing, Docx -> Core/Opc, UI -> Core, React -> Core/UI, Transports -> Core. The transports do not depend on each other and add no dependencies: what MCP, HTTP and CLI have in common (the semantic actions, their JSON Schemas, limits and error shape) is defined once in Core as `AGENT_ACTIONS`, and each transport only parses its own input format, supplies an actor and formats the result. A host can build a fourth surface from the same table. UI rendering never defines document semantics. React is a thin subscription/composition adapter. Host chart providers are replaceable renderers; chart data lives in a serializable Core spec. Unknown chart kinds remain serializable and show a data fallback until a renderer is installed.

The ordered flat block list separates identity from position. Every block has a caller-assigned ID, parent ID, typed content, citations, monotonic per-block version, creation timestamp, and update timestamp. Only containers (`section` and `toggle`) can parent blocks. Parent cycles, missing parents, duplicate IDs, invalid anchors, and unsafe URL schemes reject at runtime. Deleting a container deletes its subtree; the block-level `deleteBlock`/`deleteBlocks` operations are guarded by each target block's exact version. IDs remain reserved after deletion and undo so old agent pointers cannot refer to unrelated new content.

The editor validates unknown JSON at every write boundary. It first checks document revision, then per-block version preconditions, then operations on a detached candidate document, and finally validates the candidate before publishing a new frozen snapshot. Each successful batch makes one revision and one subscription notification. Failed batches make neither.

Default revision policy rejects stale requests. `rebase-safe` permits only the content operations `updateBlock` and `replaceText`, and every targeted block must still have the expected version. Metadata and structural operations always need the exact document revision. This is conservative optimistic concurrency for a single host editor; it is not distributed conflict resolution. In a persistent host, enforce a compare-and-swap on stored document revision and authenticate/authorize the actor independently of the supplied JSON actor ID.

Formats are a contract in Core (`Exporter`, `Importer`, the registry and loss warnings) with the heavy ones in their own packages: `opc` (zip and Office packages) and `docx` (Word) sit beside Core, and Core never imports them. See [FORMATS.md](FORMATS.md).

Hosts whose documents live in a database implement `DocumentStore` (see [PERSISTENCE.md](PERSISTENCE.md)): `createStoreService` loads, applies one guarded transaction and saves with a compare-and-swap on the revision, so the transports below run unchanged over a store.

Undo/redo create new revisions, do not decrease block versions, and require the exact current revision. The bounded session history is separate from document serialization. Production hosts can persist immutable revisions and transaction idempotency records, but must define retention, access controls, durable recovery, and concurrent writers.

Format fields intentionally cover only screen/A4/letter presentation, generic font family, font size, and line height. Browser print styling is a preview. There is no promise of Word layout or a full Notion feature set. Export to Word is a regenerated file, not a layout-faithful copy: what it cannot carry is reported as warnings (see [FORMATS.md](FORMATS.md)), and it has not been verified in Microsoft Word itself.
