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

Load `@supersolutions/super-editor-ui/styles.css` once on the page.

License: GPL-3.0-or-later. Closed-source use needs a commercial license from SUPER SOLUTION LABS INC (contact@supersolution.io).
