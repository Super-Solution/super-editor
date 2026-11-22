# @supersolutions/super-editor-chat-plugin

Shows research documents as cards in [super-chat](https://github.com/Super-Solution/super-chat). It
implements the Apache-2.0 `ChatPlugin` contract from `@supersolutions/super-protocol`, so super-chat
loads it without depending on this package's licence.

```ts
import { createEditorChatPlugin } from '@supersolutions/super-editor-chat-plugin';
import { installChatPlugin, pluginRenderers } from '@supersolutions/super-chat-plugin';

const plugin = createEditorChatPlugin({ onChange: (doc) => save(doc) });
installChatPlugin(registry, plugin);
// <CardRendererProvider renderers={pluginRenderers([plugin])}> … </CardRendererProvider>
```

Card kind `super-editor.document`:
- `{ document, mode: "view" | "edit" }` — an inline report document. Edits stay local; `onChange` reports them.
- `{ service: { baseUrl, documentId } }` — read-only view of a document held by a running editor service
  (read from `${baseUrl}/documents/${documentId}/document` unless `resolveServiceUrl` says otherwise).
  A card is conversation content, so the address it names is not trusted, and no setup is needed to be safe:

  | Address named by the card | What happens |
  | --- | --- |
  | On the page's own origin | read with the `headers` option (your authentication) |
  | Another public `https` host | read **anonymously**: no headers, cookies or referrer; redirects are refused |
  | Plain `http`, a user name or password in the URL, `localhost`, a single-label or internal name (`.local`, `.internal`), or a private, loopback, link-local or cloud-metadata IP address | refused with a visible message; no request is made |
  | Built by your `resolveServiceUrl` | your decision: read with the `headers` option |

  `allowedServiceOrigins` is optional and only widens these rules for exactly the origins it lists (for another origin that
  should receive the headers, or an internal or local development service). A browser cannot see where a public name
  resolves, so a name pointing at a private address is not caught; it is still requested without credentials. Answers
  larger than the document size limit or that are not JSON are refused.

Load `@supersolutions/super-editor-ui/styles.css` once on the page.

## Agent tools

The plugin offers an agent the same guarded operations as the MCP server, named `editor_*`. A tool addresses a
document by `documentId`, or the most recent card on screen when it is omitted; `resolveDocument` adds documents
that are not on screen.

| Authority | Tools | Behaviour |
| --- | --- | --- |
| `read` | `editor_list_documents`, `editor_read_document`, `editor_get_outline`, `editor_find_blocks`, `editor_get_block`, `editor_document_stats`, `editor_export_*`, `editor_list_revisions`, `editor_list_templates`, `editor_validate_transaction` | Changes nothing |
| `draft` | `editor_insert_blocks`, `editor_move_blocks`, `editor_add_chart`, `editor_add_citation`, `editor_insert_template` | Adds to or rearranges a card in `edit` mode |
| `act` (asks first) | `editor_update_block_text`, `editor_update_block`, `editor_replace_text`, `editor_delete_blocks`, `editor_set_title`, `editor_import_markdown`, `editor_apply_transaction`, `editor_undo`, `editor_redo` | Overwrites or removes content |

An edit names the version it last read, and a stale edit is refused with a `conflict` issue. An `act` tool refuses
to run unless the host passes `confirmed: true` after asking the user. A card in `view` mode can be read but not
changed.

## Theme

When the host passes `hostTheme` in the card context, the card uses the host's colours and fonts. Otherwise it
follows `theme` (`light` or `dark`).

License: GPL-3.0-or-later. Closed-source use needs a commercial license from SUPER SOLUTION LABS INC (contact@supersolution.io).
