# Changelog

All notable changes to the six `@super-solution/editor-*` packages (released together, same version). Prereleases ship on the `next` npm channel. The document format stays `schemaVersion: 1`; every change below is additive.

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
