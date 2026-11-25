# Integrating Super Editor in an app

## Next.js and other server-rendering frameworks

Every React module that uses React at runtime starts with `'use client'`, so `ReportView`, `ReportEditor`, the panels and the hooks can be imported from a Server Component file. Import the stylesheet once from a layout: `import '@supersolutions/super-editor-ui/styles.css'`. The packages declare `sideEffects` so bundlers can drop unused code (only the stylesheet has side effects).

## Layout follows the container

The document (`.super-editor-document`) and the editor wrapper (`.super-editor`) are size containers (`container-type: inline-size`). The narrow-width rules (smaller title, two-column metrics, full-width images, the gutter room in the editor) are `@container` rules, so an editor in a 360px side panel on a 1440px screen gets the narrow layout, and a 900px column on a phone-sized viewport does not. Side padding is `min(var(--se-pad-x), max(1rem, 7%))`: it gives way as the column narrows. You do not need a `ResizeObserver`.

Notes: the container needs a width from its parent (a block, a flex or grid item that stretches). A `display: inline-block` or shrink-to-fit parent collapses an inline-size container; give it a width. To opt out, set `container-type: normal` on `.super-editor-document` and `.super-editor`. Pointer and hover rules (`pointer: coarse`, `hover: none`), reduced motion and print stay media queries: they describe the device, not the width.

## Theming

All colors, fonts, spacing and shape are `--se-*` custom properties (see `tokens.css`). The built-in theme selectors have **zero specificity** (`:where(...)`), so a plain host rule wins without `!important` or selector tricks:

```css
.my-app [data-se-theme] { --se-text: #111; --se-accent: #0a5; --se-font-sans: "Inter", sans-serif; }
```

`theme` takes `light` (default), `dark`, `auto` (follows `prefers-color-scheme`) or **`host`**, which follows your page's own switch: an ancestor with class `dark` or `data-theme="dark"`, `data-color-mode="dark"` or `data-bs-theme="dark"`. Charts read the same tokens, and their ten default series colors reach 3:1 against the page surface in both themes (WCAG 1.4.11).

## Languages and formats

- `labels` (all components) translates the UI strings, including the classic editor controls (`labels.classic`) and the proposal panel (`labels.proposal`).
- `interactionLabels` and `slashLabels` translate the interactive editor's components and slash menu.
- `messages` translates the interaction layer's own strings (notices, block-menu entries, shortcut help), keyed by the English text: `messages={{ 'Block ID copied': '區塊 ID 已複製', Duplicate: '複製' }}`. Messages that come from the core (validation issues) carry a stable `code` you can map yourself.
- `locale` and `timeZone` format timestamps and the "Updated" time for people (`Intl.DateTimeFormat`, medium date and short time; the machine-readable `dateTime` and a tooltip keep the ISO value). Without either, the ISO text is shown as before.

## Pasting and images

Pasting HTML (a web page, Word, Google Docs) keeps headings, lists (with nesting), block quotes, code, tables, rules, links and bold/italic/underline/strike/code. The HTML is parsed inertly and only an allow-list of structure is read; styles, scripts, event handlers, `data:` images and unsafe links are dropped.

Images arrive as files (a screenshot, a drag from the desktop). Give the editor `uploadImage: (file) => Promise<{ url, alt?, caption? }>` and it uploads pasted or dropped image files (png, jpeg, gif, webp, avif; up to `maxImageBytes`, default 20 MB) and inserts image blocks with the returned **https** address. Without a handler the editor says so instead of silently ignoring the file.

## Reviewing agent changes

```tsx
<ProposalReview document={document} proposal={pending} editor={editor} preview
  onAccept={() => clear()} onReject={() => clear()} onResult={(result) => toastFromApplyResult(result)} />
```

Shows who proposed the change and against which revision, what it would add, change, remove or move (before and after text), and whether it can still be applied; Accept is disabled for a stale or invalid proposal. `preview` adds "Show in document", the document as it would be with the changed blocks marked. `reviewProposal` and `useProposalReview` give the same data without the component. The panel applies nothing until Accept.

## Chat plugin

`createEditorChatPlugin({ onChange, debounceMs, actor, messages, labels })`: `debounceMs` delays `onChange` (a pending call is flushed when the card is removed); a host that saves `onChange` and feeds the saved document back into the card spec does not lose the caret (the echo is recognized by id and revision; a newer revision remounts); the actor id, the plugin's own texts and the editor's labels are configurable; `locale` from the chat context reaches the renderer. A `service` reference stays read-only (the protocol rejects `mode: "edit"` with a service).

## Web component and other frameworks

`defineSuperEditor()` registers `<super-editor>`. Attributes: `mode="view|edit"`, `readonly`, `theme`, `density`, `locale`, `time-zone`, `actor`, `src` (a URL whose JSON body is the document), `credentials`. Property `labels`; methods `load(document)` and `reload()`; events `change`, `error`, `load`.

```html
<!-- Vue / Svelte / Angular / plain HTML: it is a custom element -->
<super-editor mode="edit" theme="host" locale="de-DE" src="/api/reports/7/document"></super-editor>
```

```ts
const element = document.querySelector('super-editor')!;
element.addEventListener('change', (event) => save((event as CustomEvent).detail.document));
```

In Vue, add `isCustomElement: (tag) => tag === 'super-editor'` to the compiler options; in Angular add `CUSTOM_ELEMENTS_SCHEMA`; in Svelte no setup is needed. Set rich properties (`labels`) on the element instance, not as attributes.

## Performance

A single-block edit does not scale with document size: `apply` keeps validated blocks and re-validates only what changed (about 10 ms at the 5,000-block limit, measured by `npm run bench`; a budget test guards it). The React renderer virtualizes large documents.

## Tests

`npm test` runs the unit and jsdom suites. `npm run test:e2e` runs real-browser tests (Chromium through Playwright): typing, bold, the slash menu, HTML paste, container-query layout, theme bridging, a console-error check, and the accessibility suite (axe, keyboard-only, input-method composition, right-to-left text; see [ACCESSIBILITY.md](ACCESSIBILITY.md)). Set `SUPER_EDITOR_CHROMIUM=/path/to/chrome` to use a browser you already have instead of Playwright's download.
