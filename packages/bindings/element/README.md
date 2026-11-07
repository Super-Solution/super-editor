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
- Edit mode is the same local surface as `mountEditor`; persistence stays with the host.

License: GPL-3.0-or-later. Closed-source use needs a commercial license from SUPER SOLUTION LABS INC (contact@supersolution.io).
