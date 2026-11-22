# Changelog

All notable changes to the eight `@supersolutions/super-editor-*` packages (released together, same version). The document format stays `schemaVersion: 1`.

## 0.4.0

### Chat plugin

- **Approval wording.** The nine tools that ask before changing a document (`set_title`, `update_block_text`, `update_block`, `replace_text`, `delete_blocks`, `import_markdown`, `apply_transaction`, `undo`, `redo`) carry an `approval(input)` that words the host's approval card for the person: what will happen, one question and a verb, such as "This document will be titled “Q3 review”." / "Rename the document?" / Rename. No tool names, ids, versions or JSON. Deleting, removing text and replacing the whole document are marked `danger`. Hosts that do not read it are unaffected; Super Chat 0.3.0 reads it.
- Depends on `@supersolutions/super-protocol` 0.3.0 (was 0.2.0).

## 0.3.0

### Visual refresh

- **Default theme** now follows the Super Solution family: neutral `#fafafa` and `#0e0e10` grounds, one violet accent (`--se-accent`), and softer nested corners (`--se-radius-xs` 4px, `--se-radius-sm` 8px, `--se-radius` 12px, `--se-radius-lg` 16px). Hosts that set their own `--se-*` tokens keep them; hosts relying on the old defaults will see the new colors.
- **New tokens**: `--se-accent-strong` and `--se-accent-tint` (derived from `--se-accent`, so a host that sets only the accent gets matching selection colors), `--se-turn` and its variants, `--se-radius-xs`, `--se-radius-lg`, `--se-radius-pill`, `--se-dur-1` to `--se-dur-3`, `--se-ease-out`, `--se-ease-in-out`.
- **Chart palette**: the ten default series and the heat-map ends changed to the family palette; every series still reaches 3:1 on the surface in both themes.
- **Agent review**: a ready `<ProposalReview>` carries the amber waiting state; the agent badge is violet with a diamond, so it differs from a person's by shape as well as color.
- **No colored side stripes** on callouts, toasts, conflicts, diffs and proposal changes: tinted fills and full hairlines replace them, and moved blocks are dashed.
- **Accessibility**: 44px touch targets and 16px fields under `pointer: coarse`, `color-scheme` follows the chosen theme, and movement is opted into with `prefers-reduced-motion: no-preference`.

### Chat plugin

- **Agent tools**: `createEditorChatPlugin` now exposes the agent actions as `editor_*` tools, plus `editor_list_documents`, `editor_read_document`, `editor_apply_transaction`, `editor_undo` and `editor_redo`. Every write goes through the guarded transaction path, so a stale edit is refused. Each tool declares its authority (`read`, `draft` or `act`); a destructive tool refuses to run until the host reports that the user confirmed it.
- **`resolveDocument` and `agentActor`** options: reach documents that are not on screen and name the actor recorded on the agent's revisions.
- **Host theme**: a card follows the colours and fonts the host passes as `hostTheme`, without remounting.
- **Fix**: edits made in an editable card survive a theme switch and a remount by the host.

## 0.2.0

Additive release: no document-format change (`schemaVersion: 1`) and no breaking change to a public API. Existing code keeps working.

### Persistence

- **`DocumentStore` and `createStoreService`**: documents that live in a database or another service. `load` and a compare-and-swap `save` are all a host implements; the service applies guarded transactions with idempotent retry, serializes writes and reports a lost race as a `conflict` that writes nothing. `AsyncReportService`, `createMemoryStore`, stateless `applyToDocument`, `openSnapshot` and `runAgentActionAsync` come with it; `createHttpHandler` now accepts a `ReportService` or an `AsyncReportService`. The synchronous `ReportService` is unchanged. See `docs/PERSISTENCE.md`.

### Review of agent changes

- **`reviewProposal` and `<ProposalReview>`**: previews an agent's transaction (ready, stale or invalid; a one-sentence summary; blocks added, changed, removed or moved with before and after text) and offers Accept and Reject. `useProposalReview` gives the data without the component.

### Embedding

- **`'use client'`** on every React module that uses React at runtime (Next.js App Router).
- **Container-aware layout**: the document and the editor are size containers; the narrow-width rules are `@container` rules instead of viewport media queries.
- **Theming**: theme selectors have zero specificity (`:where`), so host rules win without tricks. New `theme="host"` follows an ancestor `.dark` class or `data-theme="dark"` (also `data-color-mode`, `data-bs-theme`).
- **Chart palette**: series 2 and 7 of the light palette (`#f97316`, `#ca8a04`) now reach 3:1 against white (`#ea580c`, `#a16207`); every default series color is tested for 3:1 in both themes.
- **Document title** wraps instead of being clipped (a growing text area replaces the single-line input).
- `sideEffects` is declared on the packages (the stylesheet keeps its side effect); the browser packages no longer declare `engines: node >=22`.

### Languages

- `locale` and `timeZone` format timestamp blocks and the "Updated" time (`Intl.DateTimeFormat`); without them the ISO text is shown as before.
- `messages` translates the interaction layer's own strings (notices, block-menu entries, shortcut help); `labels.classic` translates the classic editor controls; `labels.proposal` the review panel.

### Pasting and images

- Pasting HTML (web pages, Word, Google Docs) keeps headings, nested lists, quotes, code, tables, rules, links and inline marks (inert parsing, allow-list, https images only).
- `uploadImage` (and `maxImageBytes`) lets the editor upload pasted or dropped image files and insert image blocks; without it the editor says images cannot be added.

### Performance

- A one-block `apply` no longer re-validates the whole document: 10 ms at the 5,000-block limit (was 139 ms), 0.5 ms at 100 blocks. `npm run bench` measures it; a test guards a budget.

### Chat plugin and web component

- Chat plugin: `debounceMs`, `actor`, `messages`, `labels`; feeding the saved document back into the card no longer remounts the editor or drops the caret; `locale` reaches the renderer.
- `<super-editor>`: `readonly`, `density`, `locale`, `time-zone`, `actor`, `src`, `credentials`, the `labels` property, `reload()` and a `load` event; `theme="host"`.

### Tests and docs

- Real-browser tests (`npm run test:e2e`, Chromium through Playwright), `docs/PERSISTENCE.md`, `docs/INTEGRATION.md`, `CONTRIBUTING.md`, `SECURITY.md`; stale statements in the README, the agent guide and the release notes were corrected.

## 0.1.0

First release of the reset line. The packages move from the `@super-solution` npm scope to `@supersolutions`.

- The repository history and version numbers were reset on 2026-11-07. Earlier prerelease versions published under `@super-solution/editor-*` (`0.1.0-next.0` to `0.3.0-next.2`) were Apache-2.0 licensed for everyone who received them, but are superseded by this line.
- **License change.** `super-editor-core`, `-ui`, `-react`, `-element`, `-chat-plugin` and `-cli` are GPL-3.0-or-later; `super-editor-api` and `super-editor-mcp` are AGPL-3.0-or-later. A commercial license for closed-source use is available from SUPER SOLUTION LABS INC (contact@supersolution.io). Every source file carries an SPDX header, and each package ships the license text that applies to it.
- Install snippets no longer use the `@next` tag; this line publishes to `latest`.
- **Chat plugin credentials.** `createEditorChatPlugin({ headers })` no longer sends the headers to whatever `baseUrl` a card names: list trusted origins in `allowedServiceOrigins`, or build the URL yourself with `resolveServiceUrl`.

### Go and Python servers

- `backends/go` and `backends/python` now implement the whole core (validation, the 14 operations, nesting, rebase-safe, undo and redo), the read side (Markdown, HTML and text export, markdown import, stats, outline, search) and the HTTP API of `super-editor-api`: the same 21 actions, routes, status codes, headers, OpenAPI document and options. The Go server is `server.NewHandler` and `cmd/super-editor-server`; the Python server is `super_editor.server` (framework-neutral handler, WSGI adapter, `python -m super_editor.server`). Both are AGPL-3.0-or-later and reproduce `conformance/server.v1.json`.

### What the line contains

- **`super-editor-core`**: headless versioned documents, guarded transactions with block versions and revisions, schemas (`schemaVersion: 1`), templates and 21 semantic operations shared by every adapter: `get_outline`, `find_blocks`, `get_block`, `document_stats`, `export_markdown`, `export_html`, `export_text`, `list_revisions`, `list_templates`, `validate_transaction`, `insert_blocks`, `update_block_text`, `update_block`, `replace_text`, `move_blocks`, `delete_blocks`, `add_chart`, `add_citation`, `set_title`, `insert_template`, `import_markdown`.
- **`super-editor-ui` / `super-editor-react`**: DOM and React renderers, an interactive editor (slash menu, block gutter, formatting toolbar, find and replace, history with diff), charts and print/export styles.
- **`super-editor-element`**: the `<super-editor>` web component (`mode`, `theme`, `change`/`error` events). **`super-editor-chat-plugin`**: a super-chat plugin for the `super-editor.document` card (inline documents, editable; service references, read-only), built on the Apache `@supersolutions/super-protocol`.
- **`super-editor-mcp`**: an MCP server and dispatcher exposing 25 tools (`read_document`, `apply_transaction`, `undo`, `redo` plus the 21 operations above), 8 resources, 2 resource templates and 4 prompts.
- **`super-editor-api`**: an HTTP adapter with an OpenAPI document and a typed client. **`super-editor-cli`**: a local JSON CLI.
