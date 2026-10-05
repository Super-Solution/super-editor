# Framework-independent UI

The UI consumes the Core document and operations. It owns DOM rendering and local draft state; it does not own persistence, business rules or collaborative storage.

```ts
import { createDocument, createEditor } from '@super-solution/editor-core';
import { mountEditor, renderDocument } from '@super-solution/editor-ui';
import '@super-solution/editor-ui/styles.css';

const editor = createEditor(createDocument({ id: 'research', title: 'Research report' }));
const mounted = mountEditor(container, editor, {
  actor: { id: 'researcher', kind: 'human' },
});
// Read-only alternative: container.append(renderDocument(editor.getSnapshot()));
// When the host route/component closes:
mounted.destroy();
```

`renderDocument(report, options)` returns a detached `HTMLElement`. `mountEditor(container, editor, options)` subscribes to the Core editor and returns an idempotent `destroy()`. For another DOM environment, pass `options.document`.

`blockRenderers` maps block types to `(block, context) => HTMLElement`; `chartRenderers` maps exact chart kinds to `(spec, context) => HTMLElement`. The context provides the DOM `document`, `report`, `options` and `renderDefaultBlock(block)`. Registered renderers are trusted host code. Unregistered charts retain a data table. Built-in pie, bar and trend charts use accessible SVG and table data.

The default controls add paragraphs, H2/H3 and sections, set font/page format and invoke Core undo/redo. `controls: false` removes them; a `controls(context)` callback replaces them. Plain text editing of a changed paragraph replaces its inline marks. Every save uses the revision and block version captured when the draft began. A conflicting save preserves the draft and displays the error; drafts also remain visible if the block is deleted or changes type. Reconciliation is explicit host/user work; this surface never removes guards or silently retries.

Embeds display links by default. The host may opt into `embedPolicy: { enabled: true, allowedOrigins: ['https://verified-provider.example'] }` after verifying its real provider. Entries must be exact HTTPS origins; wildcards, paths, suffix matches and credentials are rejected. Iframes retain `sandbox="allow-scripts"` and `referrerpolicy="no-referrer"`, without same-origin permission. This is an embed descriptor, not an assumed SuperChart SDK integration.

The stylesheet defaults to neutral colors. Tokens inherit from the host wrapper or report class, including `--se-bg`, `--se-surface`, `--se-text`, `--se-muted`, `--se-border`, `--se-accent`, `--se-subtle`, `--se-hover`, `--se-error`, `--se-error-bg`, `--se-error-border`, `--se-document-width`, `--se-font-sans`, `--se-font-serif`, `--se-font-mono`, `--se-chart-1` through `--se-chart-6`, and `--se-chart-axis`.

```css
.host-reports {
  --se-bg: #f5f5f5;
  --se-surface: #ffffff;
  --se-text: #222222;
  --se-muted: #666666;
  --se-border: #dddddd;
  --se-accent: #333333;
  --se-font-sans: Arial, sans-serif;
}
```

The stylesheet states what a CSS reset (Tailwind's preflight, modern-normalize) would otherwise take from the document: list markers (disc, circle and square for nested bullets, decimal for numbers and the sources list, none for to-do lists) and the size and weight of headings (`--se-h1-size`, `--se-h2-size`, `--se-h3-size`, `--se-heading-weight`). The rules are scoped to `.super-editor-document` and use class selectors with no `!important`, so a reset before or after the stylesheet does not remove them and a host can still out-rank them. Heat-map cell labels use whichever of `--se-chart-ink-dark` and `--se-chart-ink-light` reads better on the cell (WCAG contrast; 4.5:1 where either reaches it), computed from the colors the page's tokens really have, so dark pages and host palettes stay readable; SVG and PNG exports resolve the same choice from the export theme.

The host can omit the stylesheet and supply its own layout, or replace individual renderers and controls. The document page/font settings are presentation settings, not Word pagination or a full print-layout engine.
