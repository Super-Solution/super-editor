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

The dependency direction is Core -> nothing, UI -> Core, React -> Core/UI, Transports -> Core. UI rendering never defines document semantics. React is a thin subscription/composition adapter. Host chart providers are replaceable renderers; chart data lives in a serializable Core spec. Unknown chart kinds remain serializable and show a data fallback until a renderer is installed.

The ordered flat block list separates identity from position. Every block has a caller-assigned ID, parent ID, typed content, citations, monotonic per-block version, creation timestamp, and update timestamp. Only sections can parent blocks. Parent cycles, missing parents, duplicate IDs, invalid anchors, and unsafe URL schemes reject at runtime. Deleting a section deletes its subtree only with the exact document revision. IDs remain reserved after deletion and undo so old agent pointers cannot refer to unrelated new content.

The editor validates unknown JSON at every write boundary. It first checks document revision, then per-block version preconditions, then operations on a detached candidate document, and finally validates the candidate before publishing a new frozen snapshot. Each successful batch makes one revision and one subscription notification. Failed batches make neither.

Default revision policy rejects stale requests. `rebase-safe` permits only content update operations, and every targeted block must still have the expected version. Metadata and structural operations always need the exact document revision. This is conservative optimistic concurrency for a single host editor; it is not distributed conflict resolution. In a persistent host, enforce a compare-and-swap on stored document revision and authenticate/authorize the actor independently of the supplied JSON actor ID.

Undo/redo create new revisions, do not decrease block versions, and require the exact current revision. The bounded session history is separate from document serialization. Production hosts can persist immutable revisions and transaction idempotency records, but must define retention, access controls, durable recovery, and concurrent writers.

Format fields intentionally cover only screen/A4/letter presentation, generic font family, font size, and line height. Browser print styling is a preview. There is no promise of Word layout, DOCX fidelity, or a full Notion feature set.
