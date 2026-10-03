# React adapter

`useEditor(editor)` subscribes to immutable Core snapshots with `useSyncExternalStore` and supports SSR. `ReportView` renders a document; `ReportEditor` renders it with optional local controls and guarded text edits.

```tsx
import { useMemo } from 'react';
import { createDocument, createEditor } from '@super-editor/core';
import { ReportEditor } from '@super-editor/react';
import '@super-editor/ui/styles.css';

export function ResearchReport() {
  const editor = useMemo(() => createEditor(createDocument({
    id: 'research', title: 'Research report',
  })), []);
  return <ReportEditor editor={editor} actor={{ id: 'researcher', kind: 'human' }} />;
}
```

Keep the `editor` instance stable for the document session. Changing it resets local draft/error state and releases the former subscription; matching block IDs and revisions cannot transfer a draft across editor instances. Saves preserve the captured exact revision and block version. Conflicting, deleted or replaced block drafts remain available for review or explicit discard within the same editor session.

Both views accept `blockRenderers`, `chartRenderers`, `embedPolicy` and `className`. React renderers receive `(blockOrSpec, context)` and return a `ReactNode`; `context.renderDefaultBlock(block)` renders the default block. `ReportView` also accepts `renderBlockActions(block)`. `ReportEditor` accepts `renderControls: false` or a callback receiving `{ editor, report, actor, applyResult }`. Hosts can submit typed Core operations from their own controls.

```tsx
<ReportView
  document={report}
  blockRenderers={{ heading: (block, context) => (
    <header className="host-heading">{context.renderDefaultBlock(block)}</header>
  ) }}
  chartRenderers={{ verifiedCustomKind: (spec) => <HostChart spec={spec} /> }}
/>
```

React escapes text and validates link/embed URLs using Core/UI helpers. There is no raw HTML API. Host renderers are trusted application code. Import the shared UI stylesheet for neutral defaults and inherited `--se-*` theme tokens, or supply your own CSS. No chart provider SDK, business logic, real-time collaboration or Word editing engine is bundled.
