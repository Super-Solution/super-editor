# @supersolutions/super-editor-element

The `<super-editor>` web component: show or edit a research document in any framework or none.

```ts
import { defineSuperEditor } from '@supersolutions/super-editor-element';
import '@supersolutions/super-editor-ui/styles.css';

defineSuperEditor();                        // registers <super-editor>
const el = document.querySelector('super-editor')!;
el.setAttribute('mode', 'edit');            // default is "view"
el.load(reportDocument);                    // false + an `error` event if the document is invalid
el.addEventListener('change', (e) => save(e.detail.document));
```

- Attributes: `mode="view|edit"`, `theme="light|dark|auto"`. Events: `change`, `error`.
- Light DOM: load the UI stylesheet once and style with the `--se-*` tokens.
- `el.editor` exposes the core editor for hosts that apply guarded transactions themselves.
- **Edit mode is the basic editor** (the same local surface as `mountEditor`: a textarea per text block), not the interactive `ReportEditor` from `super-editor-react` (no `/` menu, block selection, keyboard navigation between blocks, rich paste), and it is not covered by the accessibility tests. The element sets `data-editor="basic"` in edit mode and logs one `console.warn` per page; `defineSuperEditor({ warn: false })` silences the message. Persistence stays with the host.
- A `change` listener also sees the toolbar's native `change` events (they bubble): act only when `event.target` is the element.

License: GPL-3.0-or-later. Closed-source use needs a commercial license from SUPER SOLUTION LABS INC (contact@supersolution.io).
