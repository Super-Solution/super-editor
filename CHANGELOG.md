# Changelog

All notable changes to the six `@super-solution/editor-*` packages (released together, same version). Prereleases ship on the `next` npm channel. The document format stays `schemaVersion: 1`; every change below is additive.

## 0.3.0-next.2 (2026-10-05)

- **Demo workspace** (`npm run build:demo`, `examples/demo/`): pages for the research report, every block and chart, each template kind and an empty page; outline rail; interactive editor with find and replace; history with diff and restore; an Agent tab that drives `runAgentAction` (including a refused stale update, a rebase-safe one and dry runs); sources; per-part switches; theme and density; JSON, Markdown, HTML, text and print export; phone drawers. Built only from the public exports.
- Fixed: `FindReplace` keeps focus in the panel after "Replace all" disables its button, so Escape still closes it.

### Host robustness (`editor-ui`, `editor-react`)

Four problems a Next.js + Tailwind host hit when it adopted the editor, each of which it had worked around in its own CSS.

- Fixed: **toolbar swatches no longer restyle chart swatches.** The highlight palette in the formatting toolbar was `.se-surface .se-swatch`, which also matched the chart legend and tooltip swatches inside the surface and turned them into large grey dots. The toolbar buttons are now `.se-highlight-swatch` (inside `.se-highlight-swatches`); `.se-swatch` belongs to charts only. A test checks that no interaction rule can match anything inside a chart.
- Fixed: **heat-map labels are readable on every cell.** The label ink was a fixed dark colour chosen from the light theme, so it vanished on dark cells and near zero on a dark page. The chart engine now picks, per cell, whichever of two ink tokens (`--se-chart-ink-dark`, `--se-chart-ink-light`; black and white by default) has the higher WCAG contrast on that cell's fill, 4.5:1 wherever either reaches it. In SVG and PNG exports the fill is known exactly, so the choice is exact. On a page it is made from the colours the page's `--se-heat-*` tokens really have, read once the chart is on screen and again when the theme changes (so `data-se-theme`, a class, a media query or a host palette all work). Each label also carries `data-print-ink`, which `print.css` uses for the light palette that printing switches to. New exports: `contrastRatio`, `pickInk`, `parseColor`, `readTokenColors`, `watchTheme`, `MIN_TEXT_CONTRAST`, `TokenColors`.
- Fixed: **overlays are no longer trapped by an ancestor's containment.** The shortcut dialog and the toast stack are `position: fixed`, which an ancestor with `transform`, `filter`, `container-type`, `contain` or `will-change` turns into "fixed to that ancestor". `ReportEditor` now renders both through a portal under `document.body`, inside a `<div class="super-editor se-portal">` that keeps the editor's `data-se-theme`, `data-se-density`, `dir` and `lang` (and follows later changes), so the `--se-*` tokens apply; the wrapper generates no box. Focus moves into the dialog and back, Tab stays inside it, Escape closes it, and opening it while typing no longer counts as leaving the editor. Nothing is portaled during server rendering. New `portalContainer` prop on `ReportEditor`, `InteractiveSurface` and `ToastProvider` (an element, a function returning one, or `false` for the old in-place rendering), plus `PortalProvider`, `OverlayPortal` and `usePortalSetting`. A stand-alone `ToastProvider` still renders in place. `react-dom` is now a peer dependency of `editor-react`. The popups that follow the text (slash menu, toolbars, block menu, link editor) are absolutely positioned inside the editor, are not affected, and stay where they are.
- Fixed: **a CSS reset no longer strips the document's list markers and heading styles.** Under `ol, ul { list-style: none }` and `h1..h6 { font-size: inherit; font-weight: inherit }` the document lost its bullets, numbers and heading weights. The stylesheet now states them outright, scoped to `.super-editor-document` and by list class, without `!important`: bullets are disc, circle, square as they nest, numbers and the sources list are decimal, to-do lists stay marker-free with their own checkbox, and headings take `--se-h1-size` to `--se-h3-size` with the new `--se-heading-weight` (700). A test runs a small cascade over the real stylesheet and DOM with a reset loaded before and after the editor stylesheet.
- Fixed: **component buttons keep their own size.** The generic control rule was `.super-editor button` (one class and one type), which outranked `.se-chart-button`, `.se-legend-button` and `.se-link-button`; it is now `.super-editor :where(button, select, input)`, so any component class defined later wins.
- Fixed: **document links keep their underline under a reset.** The link rule set only the colour, so `a { text-decoration: inherit }` removed the underline; it now states `text-decoration-line: underline` at one class of specificity (`.super-editor-document :where(a)`), so citation markers and table-of-contents links still stay plain.
- New tokens: `--se-chart-ink-dark`, `--se-chart-ink-light`, `--se-heading-weight`, `--se-z-dialog` (60) and `--se-z-toast` (1000).

## 0.3.0-next.1 (2026-10-05)

### Editor interaction (`editor-ui`, `editor-react`)

- **`ReportEditor` is interactive by default**: click text to edit it in place. Typing is buffered and committed as a guarded `updateBlock` by a human actor; Enter splits, Backspace at the start merges. Pass `interaction={false}` for the previous Edit-button editor.
- **Headless controller** `createInteraction(editor, options)` in `editor-ui` owns selection, drafts, commands, the slash menu, drag and drop, the shortcut registry, Markdown-style input rules and the clipboard, so any host (or an agent harness) can drive the editor without React. Pure planners (`planInsert`, `planDelete`, `planDuplicate`, `planMove`, `planTurnInto`, `planPaste`, ...) return Core operations.
- **Section hover and drag**: a block gutter with a drag handle and `+`, a hover outline, multi-block selection (click, Mod-click, Shift-click, Shift+Arrow, Mod+A), a drop indicator, and keyboard moves (Alt+Shift+ArrowUp/ArrowDown).
- **Slash menu** (`/`) with fuzzy search over every block kind and chart templates; **turn into**, duplicate, delete with Undo, and a block action menu.
- **Formatting**: a selection toolbar for bold, italic, code, strike and links (https only unless `linkSchemes: "http-https"`), Markdown shortcuts (`# `, `- `, `1. `, `[] `, `> `, ```` ``` ````, `---`), and a shortcut help sheet (`Mod+/`) whose bindings are configurable.
- **Editing blocks in place**: lists and todos, tables (cells, add/remove rows and columns), callouts, and a chart editor for title, kind (only kinds the data fits), caption, source, unit and axis labels; the data itself is not edited there.
- **Conflicts never overwrite**: a change made elsewhere while you type shows "Keep my version" / "Use the latest". Refused edits become toasts through `toastFromApplyResult`; `onFeedback` replaces the built-in toasts and `onReload` adds a Reload action.
- **Theme**: the interaction CSS reads only `--se-*` tokens; `data-se-theme` and `data-se-density` on the editor wrapper reach popups and toasts.
- Fixed: `interaction={false}` keeps the view's `labels` and drops only interaction props.

## 0.3.0-next.0 (2026-10-05)

Editor interaction (hover handles, drag, slash menu, selection, shortcuts) follows in `0.3.0-next.1`.

### Rendering, charts and panels (`editor-ui`, `editor-react`)

- **Every v0.2 block renders** in the headless DOM renderer (`renderDocument`) and the React `ReportView`, with the same structure: headings 1-3, marks, todo/indented lists, quote, callout, code, divider, image, toggle, metrics, TOC, page break, and tables with align, caption, header column and sticky header. Citation markers are `[n]` superscripts with a hover card that links to the references list.
- **Chart engine**: line, area (stacked), bar (grouped, stacked, horizontal), pie, donut, scatter, histogram, candlestick with volume, heatmap with a colour bar, waterfall. Nice ticks; number, percent, currency and compact formats; series toggles, tooltip and crosshair, keyboard navigation, annotations; responsive relayout; an accessible data table; SVG and PNG export.
- **Panels**: `Outline`, `FindReplace` (Mod+F / Mod+H, guarded `replaceText`), `StatusBar`, `SaveIndicator`, toasts with a conflict toast and Reload, `RevisionHistory` with diff marks, empty states, skeletons, an editable `DocumentHeader` and `CitationHoverCard`.
- **Theme and print**: `--se-*` tokens with a 10-colour series palette and density through `data-se-density`. Dark is opt-in through `data-se-theme="dark" | "auto"`. Print honours the document format (A4 or letter), uses the light palette and expands toggles.
- **Robustness**: a per-block error boundary, rendering memoised by block id and version, viewport mounting above 300 blocks (`virtualize={false}` for server-rendered hydration), landmarks and a polite live region, and a `labels` prop for every string.
- **Unsafe URLs** in links, citations, images and embeds go through core `safeUrl`; images and embeds must be https.

### Agent transports: MCP, HTTP, CLI

- **Shared action table.** `AGENT_ACTIONS` and `runAgentAction` in `editor-core` define 21 semantic operations once (`get_outline`, `find_blocks`, `get_block`, `document_stats`, `export_markdown`, `export_html`, `export_text`, `list_revisions`, `list_templates`, `validate_transaction`, `insert_blocks`, `update_block_text`, `update_block`, `replace_text`, `move_blocks`, `delete_blocks`, `add_chart`, `add_citation`, `set_title`, `insert_template`, `import_markdown`). Each validates its input against a JSON Schema, builds one guarded transaction, supports `dryRun`, `expectedRevision` and `transactionId`, and returns compact results (touched block IDs and versions) or failures with a `hint`. Typed `AgentActionInputs` / `AgentActionOutputs`, `TRANSPORT_LIMITS`, optional `ReportService.revisions()`.
- **`editor-mcp`**: a real server. `createMcpDispatcher` now answers `initialize`, `ping`, `tools/*`, `resources/*` and `prompts/*`; 25 tools with titles and `readOnlyHint` / `destructiveHint` / `idempotentHint` annotations, 8 resources and 2 resource templates, 4 prompts (`draft_report`, `review_report`, `summarize_document`, `add_citations`), a `readOnly` mode and a configurable actor. New binary `super-editor-mcp <document.json>` (stdio, `--actor`, `--read-only`, `--create --template`) that saves every edit atomically under the CLI's lock file and picks up outside edits. Entry point `@super-solution/editor-mcp/stdio` (`runStdioServer`).
- **`editor-api`**: new routes `GET /outline`, `/blocks` (filters), `/blocks/{id}`, `/stats`, `/revisions`, `/export.md|.html|.txt`, `/templates`, `/templates/{kind}`, `/actions`, `/openapi.json`, `/schemas/*.json`, `/health`; `POST /import/markdown` (JSON or raw markdown) and `POST /actions/{name}`. A generated OpenAPI 3.1 document (`createOpenApiDocument`), `createHttpClient` (typed per action, refused edits returned not thrown), CORS and `OPTIONS` (off by default, exact origins), `readOnly`, `basePath`, an `actor` option that wins over a body actor.
- **`editor-cli`**: new commands `new`, `templates`, `tools`, `validate`, `outline`, `find`, `get`, `stats`, `revisions`, `insert`, `import`, `add-template`, `update-text`, `update`, `replace`, `title`, `move`, `delete`, `chart`, `cite`, `export`, `call`. Edits name `<blockId>@<version>`; `--json`, `--dry-run`, `--expect-revision`, `--actor`, `-` for standard input; exit code 4 for not found; optional `<file>.history.jsonl` revision log. `init`, `read` and `apply` behave as before.
- **Errors.** One failure shape everywhere, `{ ok: false, currentRevision, issues: [{ code, message, hint, path?, blockId? }] }`; `hint` is always present. HTTP status codes are refined (404 not found, 413 body too large, 415 not JSON, 403 read-only); the original Core routes keep their 409-or-400 rule.
- **Limits.** Enforced and documented in one place (`TRANSPORT_LIMITS`, docs/API.md): request body 1 MiB, markdown 1,000,000 characters, 200 `find_blocks` results, 4 MiB per stdio line, 32 MiB per file.

### Templates

- `createTemplate(kind, options)` and `equityTemplate`, `macroTemplate`, `portfolioTemplate`, `strategyTemplate`, `arbitrageTemplate`, `comparisonTemplate`, `blankTemplate` return ordered `BlockInput[]` (structure and guidance only, with a "Data and methodology" section and an analysis-only note). `templateTitle`, `listTemplates`, `TEMPLATE_KINDS`.

### Docs, examples, release

- New: [docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md), [docs/API.md](docs/API.md), a security section for image and embed URLs and for the transports in [docs/SECURITY.md](docs/SECURITY.md), package READMEs, [examples/README.md](examples/README.md).
- Examples: `all-blocks.ts` (every block, chart kind and mark; fixture `examples/fixtures/all-blocks.v1.json`), `headless-charts.ts`, `mcp-client.ts`, `cli-walkthrough.ts`, `http-agent.ts`.
- Release: `tests/bump-version.test.mjs` and a [RELEASING.md](docs/RELEASING.md) note for `scripts/bump-version.mjs`; `release:check` now also exercises the new CLI commands and the `super-editor-mcp` binary from the packed tarballs.

### Changed behaviour to know about

- The MCP `tools/list` now returns 25 tools instead of 4 (the four originals come first and are unchanged).
- Oversized HTTP bodies are `413` (were `400`); a non-JSON content type is `415` (was `400`). Failure bodies of unknown routes and wrong methods use the common failure shape instead of `{ "error": "..." }`.
- Failures from `/transactions`, `/undo`, `/redo` and the MCP Core tools gain a `hint` where the check did not supply one.
- `super-editor` and `super-editor-mcp` also start when launched through a package-manager symlink (the main-module check now compares real paths).

## 0.2.0-next.0

- Core v0.2 document model: new block types, inline marks, chart kinds, operations, validation, JSON Schemas; pure helpers (`findBlocks`, `getOutline`, builders, `toMarkdown` / `fromMarkdown` / `toHTML` / `toPlainText`, `stats`, `diffDocuments`, `summarizeRevision`); issue hints.

## 0.1.0-next.0

- First candidate: six scoped packages, Core document and operations, DOM and React views, HTTP adapter, MCP tool dispatcher, local CLI, controlled npm releases.
