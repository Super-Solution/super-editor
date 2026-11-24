# Changelog

All notable changes to the ten `@supersolutions/super-editor-*` packages (released together, same version). The document format stays `schemaVersion: 1`.

## Unreleased

A minor release when it ships (new packages and new exports; nothing existing changes). Document format unchanged (`schemaVersion: 1`). Not published.

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
