# Changelog

All notable changes to the ten `@supersolutions/super-editor-*` packages (released together, same version). The document format stays `schemaVersion: 1`.

## Unreleased

A minor release when it ships: new optional fields and actions, nothing existing changes. Document format unchanged (`schemaVersion: 1`). Not published.

### Accessibility, found by axe and by keyboard

- **The `/` menu is an ARIA 1.2 editable combobox.** While it is open the editing field becomes the `combobox` that owns it (`aria-expanded` is not allowed on a `textbox`, which axe reported as critical) and goes back to a `textbox` when it closes. Headings keep their heading semantics while edited; every other field has a name (`fieldParagraph`, `fieldListItem`, `fieldCell(row, column)`, … in `interactionLabels`) and `aria-placeholder`.
- **A keyboard user can get in.** Down (or Enter) on the focused document surface starts at the first block, a visually hidden live region says "Heading selected: …", and Enter on a block with no text (an embed, an image) says so instead of doing nothing. New: `interaction.selection.first()`, `interaction.openSelected()`, the shortcut ids `selection.begin` and `selection.beginEdit`, labels `blockSelected` and `surfaceHint`.
- Toasts are no longer list items (axe `aria-allowed-role`), the slash menu and the shortcut dialog body are keyboard-focusable scroll regions, the shortcut dialog no longer adds a second banner and contentinfo landmark, and text takes the direction of its own script (`unicode-bidi: plaintext` on rendered blocks, `dir="auto"` on editable fields).
- **Tests and docs.** `e2e/a11y.e2e.ts`: axe-core 4.14.0 (devDependency only, exact pin, MPL-2.0, no dependencies, no install scripts) in nine states at 1280 and 390 px in light and dark, a keyboard-only flow, IME composition through the DevTools protocol and right-to-left text. `e2e/helpers.ts` takes `SUPER_EDITOR_CHROMIUM` (use an installed browser) and `SUPER_EDITOR_E2E_SANDBOX=1`. New [ACCESSIBILITY.md](docs/ACCESSIBILITY.md) lists what is checked and, plainly, what is not (no real screen reader, no real IME, one browser engine, no VPAT).
- The workspace demo gives the block gutter room beside the text instead of on top of it, and puts the status bar in a landmark.
- **Docs cannot drift silently.** `tests/docs.test.ts` and `npm run release:check` compare the README with the code: its `Version` line against `package.json` and every manifest, its package table and folder layout against the release contract, and its "not implemented" sentence against the exporters that ship (the README still said 0.3.0 and "no Word export"). The agent guide must name every block type.
- `npm run bench:size` (`benchmarks/size.mjs`) reports the minified and gzip size of each entry point.

### `<super-editor mode="edit">` says what it is

- The element's edit mode has always mounted the classic editor (a textarea per block), not the interactive `ReportEditor`; the docs said "edit" and left the difference to be found. Now: `data-editor="basic"` on the element while in edit mode (removed in view mode), one `console.warn` per page the first time it mounts the basic editor (`defineSuperEditor({ warn: false })` silences it), a boxed explanation in `docs/INTEGRATION.md` and the element README, and the same note in the accessibility limits. Nothing else about the element changes.
- New `examples/vue/ReportEditor.vue` and `examples/svelte/ReportEditor.svelte`, with the `change`-event pitfall handled (the toolbar's native `change` events bubble through the element). Not compiled in this repository (no Vue or Svelte dependency); `tests/examples-framework.test.ts` fails if they name an attribute, method or event the element does not have.
- **Not done:** a vanilla-DOM interactive editor (so the element becomes the full editor). The interaction store in `-ui` is DOM-independent, so it is feasible; it is a separate, larger change and is listed in the PR as open.

### Paste says what it left out, and notices can be translated

- **`PasteWarning`s from `htmlToBlocks`.** New optional `warnings` array in `HtmlPasteOptions` (existing callers and the return type are unchanged). Seven kinds: blocks, list items, over-long text, table rows and columns over the limits, images that are not https, links with a disallowed address (their text is kept), and HTML over 1,000,000 characters. Each carries `code`, `count`, an English template `message` and `params`. The interactive editor shows one `info` notice after the paste (`FeedbackEvent.warnings` has the structured form). Relative and in-page links, styles and scripts stay silent.
- **Notices are templates.** `'Pasted {count} blocks'` instead of an interpolated string nobody could translate (also copy, duplicate, delete, move, turn into, insert, image upload and size). The translator takes `(text, params)`, fills `{placeholders}` and accepts a function per message for languages with other plural rules (`Intl.PluralRules`). `FeedbackEvent` gains `template` and `params`; new exports `counted`, `MessageParams`, `PasteWarning`, `PasteWarningCode`. A plain-string `messages` dictionary keeps working. Notices that were English-only because of interpolation (the previous `Pasted 2 blocks`, `Turned 2 blocks into heading1`, `Added a block inside the section`) now have keys; `Turned … into {type}` now says "Heading 1" instead of the internal id.
- **Not covered:** messages that come from the core (validation issues) stay English and are mapped by `code`; the `interactionLabels` functions (`blocksSelected`, …) were already translatable and are unchanged.

### A guard against a replace that touches more than you meant

- **`replace_text` takes `expectedMatches` and always reports `replacements`.** The number of replacements you expect (1 means "change exactly one place"); a different count fails with `conflict` at `input.expectedMatches`, changes nothing, and says the real count and what to do. The result now carries `replacements` (and still `matchedBlocks` without `blockId`), dry runs included. It is an action option, not an operation field, so documents and transactions are unchanged; MCP, HTTP and the CLI (`replace --expect <n>`) get it from the shared action table. Cannot be combined with `conflictPolicy: "rebase-safe"` (the count is only true for the revision it was made on); a stale `expectedVersion` is still a `conflict` on the block. Go and Python servers have the same behaviour, pinned by the regenerated `conformance/server.v1.json`.

### Long-lived documents: reserved IDs

- **An edit no longer reads every deleted ID.** The `retiredBlockIds` list is shared between snapshots and validated once, not once per edit: a one-block edit in a document that reserves 99,500 deleted IDs takes 2 ms (median) instead of 51 ms (1.3 ms with none), the 500-block delete 9 ms instead of 87 ms. `benchmarks/apply.ts` measures it, `tests/performance.test.ts` guards it, and `tests/retired-ids.test.ts` pins that a reserved ID is still never reused, also across undo and redo.
- **A warning before the wall.** From 80,000 reserved IDs every successful `apply` carries `warnings: [{ code: 'retired-ids-near-limit', message, hint, used, limit }]` (new `EditorWarning` type, `RETIRED_LIMIT` and `RETIRED_WARNING` exports), and write actions pass it through. TypeScript editor only: the Go and Python editors apply the same rules but do not warn.
- **A hint at the wall.** The edit that would pass 100,000 is refused with a `validation` issue at `document.retiredBlockIds` whose `hint` says what to do. Same text in the TypeScript, Go and Python validators (each backend test reads the TypeScript source to keep it so). Compaction (forgetting old IDs) is not done: it would let an old reference point at new content, so it is the owner's decision.

## 0.7.0

A minor release: two new packages and new exports; nothing existing changes. Document format unchanged (`schemaVersion: 1`).

### Export and import with an honest loss report

- **A format contract in core.** `Exporter`, `Importer`, `FormatRegistry` (`createFormatRegistry`), `FormatWarning`, `FidelityTable`, `scanFeatures`, `lossWarnings` and `chartRowsWarning`. Every result carries `warnings`: one per affected feature (not per block) with a stable `code`, a `hint`, a `count` and the first block ids. Bad documents, unknown options and invalid bytes come back as `issues`, never as a throw. See [FORMATS.md](docs/FORMATS.md).
- **Built-in formats on the contract**: `markdownExporter`, `htmlExporter`, `textFormatExporter` (each with its fidelity table) and `markdownImporter`, which takes the title from `options` or the first `# ` line (never invents one), refuses invalid UTF-8, and reports HTML, setext headings, deep headings, footnotes, flattened inline formatting and non-https images with the source line. `chartFallback` is exported so other formats write charts the same way.
- **New package `@supersolutions/super-editor-opc`**: a dependency-free ZIP and OPC reader and writer (deterministic output, STORE or DEFLATE, CRC, path safety, entry, size and zip-bomb limits, content types and relationships).
- **New package `@supersolutions/super-editor-docx`**: `exportDocx` and `docxExporter` write a Word file in the browser and Node, with real headings, numbering, tables with a repeating header row, hyperlinks, a Sources section, header and footer fields, page setup and fonts and language options. Charts become data tables, images become alt text (nothing is embedded), and each of those is a warning. Checked with python-docx and LibreOffice and against Word's element order; **not opened in Microsoft Word**, and tracked changes and comments are not implemented.
- **Tracked changes**: `exportDocxRedline({ before, after, actor })` and `exportProposalDocx(document, transaction)` in the docx package write the difference between two versions, or what an agent's reviewed proposal would change, as Word tracked changes: inserted and deleted blocks, word-by-word changes in text blocks (each CJK character counts as a word), new title and sources. Accept all gives the new document and reject all the old one (tested). Tables, lists and charts that changed are shown as old deleted and new inserted; moves and page format are not tracked; each limit is a warning (`REDLINE_LIMITS`). Checked in LibreOffice; not in Microsoft Word.
- Release wiring: ten packages in the release contract, build, verify and publish workflow (order core, opc, docx, ui, …). New package names still need npm Trusted Publishing before a release.

## 0.6.0

A minor release: a new block type is added and nothing existing changes. Document format unchanged (`schemaVersion: 1`).

### A document can hold a chat plugin's card

- **New block `card`**: `{ type: 'card', kind, spec, alt, title? }`. `kind` is a namespaced card kind (`super.plot`, `super-chart.chart`), `spec` is that card's own JSON, and `alt` (required) says in words what it shows. The spec is not interpreted but is checked as data: plain objects and arrays, finite numbers, valid text, at most 32 levels and 100,000 values, and a `kind` inside it must match. TypeScript, Go and Python validate it the same way (new conformance cases); `b.card()` builds one; `BLOCK_TYPES` ends with `card`.
- **Drawn by the chat plugin that made it.** `cardMounts` on `renderDocument`, `mountEditor`, `ReportView` and `<super-editor>` maps card kinds to super-protocol `CardMount`s, so a Super Chart chart or a Super Plot figure is live inside a report. Mounts are told placement `document`. Without a mount, or when it fails, the block shows its title and alt text. `releaseCards(root)` destroys mounts in detached DOM.
- **Everywhere else it is its words.** Markdown, HTML and plain-text exports, print, search and replace use the title and alt text (replace changes those, never the spec).
- **Chat plugin**: `createEditorChatPlugin({ cardMounts })` passes them to the document in the chat, and the manifest declares a `panel` capability for `super-editor.document`, so a chat with a side panel can open a document there.

## 0.5.0

Two behaviour changes that make bad input visible instead of quietly accepting it, so this is a minor release. Everything else in this version is internal hardening from 15 audit rounds (correctness, reliability, packaging); see `docs/engineering/improvement-log.md`. Document format unchanged (`schemaVersion: 1`).

### Text that is not valid Unicode is refused

- **Unpaired surrogates are rejected.** A string with half of a surrogate pair (`"a\ud800b"`: valid JSON, not valid text) is refused by validation with an explicit `validation` issue that names the path and the index, in the TypeScript core, the Go server and the Python server (Go refuses it while decoding the request or file, with a 400 and the byte offset). Before, TypeScript and Python stored it and Go silently turned it into U+FFFD. Nothing is replaced: every valid character stays supported, including emoji, rare ideographs and combining sequences, which are surrogate pairs in UTF-16. Hosts that build text by cutting strings should cut at a character boundary (`clipText` does).
- **Files that are not UTF-8 are refused.** The CLI, the MCP server and the Go decoder no longer read a Big5, GBK or truncated file with U+FFFD in place of the bad bytes, which the next save would store. They stop with "is not valid UTF-8 text". (The HTTP adapters already did.)
- The conformance data gained 15 text cases (`validation.v1.json`); Go skips none of them, it refuses the lone-surrogate ones at decode time.

### Chat plugin: safe by default, nothing to configure

- **Service addresses named by a card are judged first.** A `super-editor.document` card can name `service.baseUrl`, and a card is conversation content. `createEditorChatPlugin({ headers })` no longer sends the headers to whatever origin a card names. With no configuration: an address on the page's own origin gets them; any other public `https` address is read anonymously (no headers, cookies or referrer; redirects refused); plain `http`, credentials in the URL, `localhost`, single-label and internal names (`.local`, `.internal`) and private, loopback, link-local, carrier-grade-NAT or metadata IP addresses are refused with a visible message and no request. A URL built with `resolveServiceUrl` is still the host's own decision and gets the headers.
- **`allowedServiceOrigins` is optional.** It is not needed for a service on the page's own origin or on a public `https` host. List an origin only to send it the headers when it is a different origin, or to allow a plain-`http` or private one (an internal service, a local development server). An entry that is not an origin throws at creation.
- Service answers are read through a size-capped reader (`LIMITS.json`); a non-JSON answer gives a clear message.

### Repository

- `npm run bench:core` (timings of the other hot paths) next to `npm run bench`; the Python server saves through a temporary file that keeps the document's permissions and follows symlinks; the README and `docs/engineering/` record the 15 audit rounds.

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

### Go and Python servers

- `backends/go` and `backends/python` now implement the whole core (validation, the 14 operations, nesting, rebase-safe, undo and redo), the read side (Markdown, HTML and text export, markdown import, stats, outline, search) and the HTTP API of `super-editor-api`: the same 21 actions, routes, status codes, headers, OpenAPI document and options. The Go server is `server.NewHandler` and `cmd/super-editor-server`; the Python server is `super_editor.server` (framework-neutral handler, WSGI adapter, `python -m super_editor.server`). Both are AGPL-3.0-or-later and reproduce `conformance/server.v1.json`.

### What the line contains

- **`super-editor-core`**: headless versioned documents, guarded transactions with block versions and revisions, schemas (`schemaVersion: 1`), templates and 21 semantic operations shared by every adapter: `get_outline`, `find_blocks`, `get_block`, `document_stats`, `export_markdown`, `export_html`, `export_text`, `list_revisions`, `list_templates`, `validate_transaction`, `insert_blocks`, `update_block_text`, `update_block`, `replace_text`, `move_blocks`, `delete_blocks`, `add_chart`, `add_citation`, `set_title`, `insert_template`, `import_markdown`.
- **`super-editor-ui` / `super-editor-react`**: DOM and React renderers, an interactive editor (slash menu, block gutter, formatting toolbar, find and replace, history with diff), charts and print/export styles.
- **`super-editor-element`**: the `<super-editor>` web component (`mode`, `theme`, `change`/`error` events). **`super-editor-chat-plugin`**: a super-chat plugin for the `super-editor.document` card (inline documents, editable; service references, read-only), built on the Apache `@supersolutions/super-protocol`.
- **`super-editor-mcp`**: an MCP server and dispatcher exposing 25 tools (`read_document`, `apply_transaction`, `undo`, `redo` plus the 21 operations above), 8 resources, 2 resource templates and 4 prompts.
- **`super-editor-api`**: an HTTP adapter with an OpenAPI document and a typed client. **`super-editor-cli`**: a local JSON CLI.

### Word pictures, and formats for HTTP, MCP and the CLI

- **`resolveImage` for `exportDocx`.** A host-provided function turns an image block's address into PNG, JPEG or GIF bytes, and the picture is embedded (media part, relationship, inline drawing scaled to the text width, alt text kept, caption kept). The package never fetches a URL itself (the address comes from a document an agent can edit: SSRF). Bytes are validated by header, limited (500 pictures, 10 MB each, 64 MB in all, 30,000 px a side), each address is asked once, and the file is byte-identical whatever order the answers arrive in. A failing resolver leaves a link; one `image-not-embedded` warning reports how many, why and which blocks. A redline refuses the option. Checked in python-docx (pictures and alt text) and LibreOffice (drawn into a PDF); not in Microsoft Word.
- **Pluggable extra actions for transports.** `createHttpHandler`, `createMcpDispatcher`, the MCP stdio server and `runCli` take an optional `actions` list (`[...AGENT_ACTIONS, ...formatActions(registry)]`); `resolveActions` validates it at start (duplicate or reserved names, missing `run`, bad schema throw a `TypeError` that says which). `formatActions(registry)` adds `list_formats` and `export_document` (text or base64, warnings included, one block with `blockId`, at most 8 MB). The shared `AGENT_ACTIONS`, the default OpenAPI document and the Go and Python conformance are unchanged: a server that is not given the list behaves exactly as before. New exports: `TransportAction`, `ActionTable`, `resolveActions`, `runTransportAction`, `formatActions`, `FORMAT_EXPORT_BYTES`; in `-docx`: `ResolveImage`, `DocxImageRequest`, `IMAGE_LIMITS`, `sniffImage`.
- **Not done:** the Go and Python servers do not serve format actions (exporters exist only in TypeScript); the chat plugin does not offer them; `.docx` import.

### Proposals: an in-memory review slice (no schema change)

- **`createProposalBox(service, options)` and `proposalActions(box)`** add `propose_transaction`, `list_proposals` and `resolve_proposal` to a transport through the `actions` list. An agent's transaction is checked like an edit and then **waits unapplied**; a person lists what is waiting (`review: ready | stale | invalid`, per-change before and after text) and accepts or rejects. Accepting needs the reviewed `expectedRevision`, applies the proposal's own transaction through the service (so every guard and, over `createStoreService`, the compare-and-swap decide; a lost race leaves it pending), and records the person on the proposal and the author on the revision. A stale proposal is refused, never rebased. Same id and content is idempotent; a different change under the same id is a `duplicate` issue.
- **Only a person resolves.** Default: the call's actor has `kind: "human"`; `canResolve` overrides. Over MCP the server's actor decides and an `actor` argument is refused; over HTTP the `actor` option wins over the body. Actor kinds are provenance, not authentication, and the docs say so.
- **`readOnlyOk` on a transport action** lets a read-only HTTP endpoint or MCP server serve a write action that never touches the document: `propose_transaction` is served there, `resolve_proposal` is not. MCP annotations stay honest (`readOnlyHint: false`).
- Limits: 100 waiting and 200 remembered (configurable), refused with a hint when full. **Not done** (listed in `docs/OPEN-DECISIONS.md`): accepting individual changes of one transaction, word-level diff in core, persistence across restarts, comments, a `ProposalReview` panel bound to the box, the Go and Python servers. No document, schema or `AGENT_ACTIONS` change.

### A Markdown read view with block ids

- **`export_markdown({ withIds: true })`** (and `toMarkdown(document, { withIds: true })`): every block is preceded by `<!-- id=BLOCK_ID v=VERSION -->`, so an editing agent reads the prose and gets the ids and versions in one call instead of a `find_blocks` per section; `blockId` reads one section. A new optional field on an existing action: the Go and Python ports implement it, and `conformance/render.v1.json` (`markdownWithIds`), `conformance/server.v1.json` and the three copies of `server-spec` were regenerated (a private implementation that tests against these files needs the same). The `read_document` tool description now points to it.
- Not done: chunked reading by size (sections are the chunks), a `GET /export.md` option, and the chat plugin's `getSelection` hook.
- Python lint: the earlier retired-ID and `expectedMatches` changes left five `ruff` line-length errors in `backends/python`; fixed (no text changed).
