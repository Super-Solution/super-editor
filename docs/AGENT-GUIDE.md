# Agent guide: building reports with Super Editor

This guide is for agents and for the people wiring agents up. It covers how to connect (MCP, CLI, HTTP or in-process), the editing loop, and what to do when an edit is refused. Reference tables are in [API.md](API.md).

Super Editor edits one **versioned report document**. Everything an agent does is a small, guarded, all-or-nothing edit, so a mistake or a conflict with a person's edit never leaves a half-applied document.

## The model in one minute

- A **document** has a title, an ordered tree of **blocks**, a list of **citations** and a **revision** number that grows with every accepted edit.
- A **block** has an ID you choose (`sec-1`, `macro.summary`), a type, typed content, optional citations and a **version** that grows whenever the block changes. IDs of deleted blocks are never reused.
- Block types: `section`, `toggle` (both can contain blocks), `heading` (levels 1 to 3), `paragraph`, `list` (bullet, numbered, to-do, nested), `table`, `chart`, `embed`, `timestamp`, `quote`, `callout`, `code`, `divider`, `image`, `metrics`, `toc`, `pageBreak`. There is no raw HTML block.
- **Guards**: an edit that overwrites, moves or deletes a block names the version you last read. If the block changed since, the edit is refused with a `conflict` and a hint that contains the current version. Nothing is applied. You read again and decide.

## Connect

### MCP (Claude Desktop, Claude Code, Cursor and other MCP clients)

`super-editor-mcp` serves one JSON document file over stdio. Every accepted edit is saved atomically to the file before the tool call returns; edits made to the file by other tools are picked up before the next call.

```sh
# Claude Code
claude mcp add super-editor -- npx -y -p @super-solution/editor-mcp@next super-editor-mcp ./report.json --create --id report --template equity --subject ACME

# Read-only access for a reviewing agent
claude mcp add super-editor-review -- npx -y -p @super-solution/editor-mcp@next super-editor-mcp ./report.json --read-only
```

```json
{
  "mcpServers": {
    "super-editor": {
      "command": "npx",
      "args": ["-y", "-p", "@super-solution/editor-mcp@next", "super-editor-mcp", "/absolute/path/report.json", "--actor", "claude:agent"]
    }
  }
}
```

`--actor <id[:kind]>` is recorded as the author of every edit. `--create` makes the file when it does not exist (with `--id`, optional `--title`, `--template`, `--subject`). The stdio server ships from `0.3.0-next.0`; the dispatcher it is built on (`createMcpDispatcher`) has been available since `0.1.0-next.0`.

The server offers 25 tools, 8 resources, 2 resource templates and 4 prompts (see [API.md](API.md#mcp)). A client that only reads `tools/list` already sees descriptions and JSON Schemas, plus `readOnlyHint` / `destructiveHint` annotations so it can ask a person before a destructive call.

### CLI

```sh
npx -p @super-solution/editor-cli@next super-editor help
super-editor new report.json --id acme-q3 --template equity --subject ACME
super-editor outline report.json
```

Every command that edits takes a lock, validates the whole change and replaces the file atomically. `--json` prints machine-readable results; exit codes are `0` ok, `1` I/O, `2` invalid input, `3` conflict, `4` not found. Use it from any agent that can run a shell. `super-editor tools` lists the actions the commands wrap; `super-editor call <file> <action> --input '{...}'` runs any of them.

### HTTP

`createHttpHandler(service, options)` is a `(Request) => Promise<Response>` function: mount it in Node, Bun, Deno, a Cloudflare Worker or any framework. It does not listen on a port and does not authenticate. Put your own authentication in front of it and tell it who the caller is:

```ts
const handle = createHttpHandler(service, { actor: request => ({ id: userFrom(request), kind: 'agent' }) });
```

Agents use `GET /openapi.json` to discover the API, or the typed client:

```ts
const client = createHttpClient({ baseUrl: 'https://host/api', headers: { authorization: `Bearer ${token}` } });
const found = await client.actions.find_blocks({ text: 'revenue', type: 'paragraph' });
```

### In-process

`createReportService(editor)` is the one shared service. `runAgentAction(service, 'update_block_text', input, { actor })` runs any action without any transport, and `AGENT_ACTIONS` gives a host the names, descriptions and JSON Schemas to build its own tool surface (for example inside a product's own agent runtime).

## The editing loop

1. **Look cheaply.** `get_outline` shows sections and headings. `document_stats` shows size. Avoid `read_document` on large documents.
2. **Find what you will change.** `find_blocks` returns `{ id, type, version, parentId, text }` summaries. Filter by `type`, `text`, `within` (a section), `parentId`, `citationId` or `ids`.
3. **Make one narrow edit** with the version from step 2.
4. **Use the result.** Every edit returns `blocks: [{ id, type, version }]` for what it touched, so you can chain another edit on those blocks without reading again.

```text
get_outline()                         -> sections: summary, performance, risk ...
find_blocks({ within: "equity-summary", type: "paragraph" })
                                      -> [{ id: "equity-summary-thesis", version: 1, text: "State the thesis ..." }]
update_block_text({ blockId: "equity-summary-thesis", expectedVersion: 1,
                    text: "ACME grew revenue **12%** while margins held." })
                                      -> { ok: true, revision: 2, blocks: [{ id: "equity-summary-thesis", version: 2 }] }
add_citation({ title: "ACME annual report", url: "https://example.com/10k",
               blockId: "equity-summary-thesis", expectedVersion: 2, marker: true })
                                      -> { ok: true, citationId: "src-1", blocks: [{ ..., version: 3 }] }
```

### Tools at a glance

| Goal | Tool |
| --- | --- |
| See the structure | `get_outline`, `document_stats`, `find_blocks`, `get_block` |
| Add content | `insert_blocks` (markdown or blocks), `add_chart`, `add_citation`, `insert_template`, `import_markdown` |
| Change content | `update_block_text`, `update_block`, `replace_text`, `set_title`, `move_blocks` |
| Remove content | `delete_blocks` |
| Check before committing | `dryRun: true` on any write, `validate_transaction` |
| Get it out | `export_markdown`, `export_html`, `export_text` |
| Full control | `apply_transaction`, `undo`, `redo`, `read_document` |
| Context | `list_revisions`, `list_templates` |

## Writing content

**Inline text** in paragraphs, quotes and callouts is markdown-lite: `**bold**`, `_italic_`, `~~strike~~`, `` `code` ``, `[label](https://url)` and `[^citation-id]`. Anything unmatched stays literal, so ordinary prose is safe. Pass `format: "plain"` to `update_block_text` to keep text literally.

**Markdown** passed to `insert_blocks` or `import_markdown` becomes blocks: ATX headings (levels deeper than 3 become 3), paragraphs, bullet, numbered and task lists with nesting, tables, fenced code, quotes and GitHub alerts (`> [!NOTE]`), `---` dividers, `***` page breaks, `[TOC]` and HTTPS image lines. List items and table cells are plain text. Raw HTML is not interpreted.

**Structured blocks** (tables, metrics, callouts with titles) go in with `insert_blocks` and a `blocks` array, or replace a block's whole content with `update_block`:

```json
{ "blocks": [
  { "id": "risk-table", "parentId": "risk", "content": { "type": "table", "columns": ["Metric", "Value"], "rows": [["Volatility", "18%"]], "align": ["left", "right"], "caption": "Risk metrics" } },
  { "id": "kpis", "content": { "type": "metrics", "items": [{ "label": "Return", "value": "12.4%", "change": 1.5, "tone": "up" }] } }
] }
```

Parents come before children in the array. Only `section` and `toggle` blocks can be parents. Image and embed URLs must be `https://`.

## Charts

`add_chart` takes one `spec`. Every kind needs `kind`, `title`, `labels` and `series` (one value per label, same length for every series).

| Kind | Needs | Notes |
| --- | --- | --- |
| `line`, `trend`, `area` | labels, series | `area` supports `stacked` |
| `bar` | labels, series | `stacked`, `horizontal` |
| `pie`, `donut` | labels, one non-negative series | |
| `histogram` | bin labels, one series of counts | |
| `waterfall` | step labels, one series of signed changes | |
| `scatter` | `points: [{ series, x, y }]` | labels/series are the data-table fallback |
| `candlestick` | `ohlc: [{ t, o, h, l, c, v? }]` | `l <= o, c <= h`; labels/series fall back to closes |
| `heatmap` | `matrix: { rows, columns, values }` | labels/series fall back to rows |

Also set `source` (human text such as "OKX daily candles"), `asOf` (UTC time), `unit`, `yAxis: { label, format: number|percent|currency|compact, min, max, currency }`, `caption` and `annotations: [{ label, at, value? }]` (where `at` is one of the labels). Always state the data source.

```json
{ "spec": { "kind": "line", "title": "Rebased performance (start = 100)", "labels": ["Mon", "Tue", "Wed"],
  "series": [{ "name": "ACME", "values": [100, 102, 101] }, { "name": "Benchmark", "values": [100, 101, 100] }],
  "yAxis": { "label": "Index" }, "source": "Example feed", "asOf": "2026-10-05T09:00:00Z" },
  "parentId": "equity-performance" }
```

An unknown `kind` is stored and rendered as a data table, so a new renderer can adopt it later.

## Citations

`add_citation` adds a source (`title`, `url`, optional `publishedAt`; `accessedAt` defaults to now). With `blockId` and `expectedVersion` the block cites it; with `marker: true` an inline marker is appended to paragraph, quote and callout text. In markdown or inline text, `[^id]` is a marker for an existing citation. Citations that nothing references are allowed. Removing a citation (via `apply_transaction` `removeCitation`) also removes every reference to it.

## Templates

`list_templates` and `insert_template` give you the skeleton of a report: `equity`, `macro`, `portfolio`, `strategy`, `arbitrage`, `comparison` or `blank`. Each has sections, tables, metric placeholders and "Chart placeholder" notes, and ends with "Data and methodology" and an analysis-only note. Insert one, then fill it in: `update_block_text` for text, `add_chart` for charts (delete the placeholder note with `delete_blocks`), `update_block` for tables and metrics. Templates contain no data and no invented numbers.

## When an edit is refused

Every failure, from every transport, has one shape:

```json
{ "ok": false, "currentRevision": 7,
  "issues": [{ "code": "conflict", "message": "Block changed; re-read before proposing another edit.",
               "blockId": "equity-summary-thesis", "path": "input.expectedVersion",
               "hint": "Block \"equity-summary-thesis\" is now at version 2 (you sent 1). Re-read it and retry with expectedVersion 2 if your edit still applies." }] }
```

`code` is one of `validation`, `conflict`, `not-found`, `duplicate`, `history`. `path` points into your input (`input.blocks[2].content.runs[0].href`). `hint` always says what to do. Over MCP a failure is a normal tool result with `isError: true`; over HTTP it is 400, 403, 404, 409, 413, 415 or 405; the CLI exits 2, 3 or 4 and prints the same fields.

| Code | Meaning | What to do |
| --- | --- | --- |
| `conflict` | The block or document changed since you read it | `get_block`, check the new content, retry with the new `expectedVersion` if the edit still applies. Never remove the guard |
| `validation` | The input is wrong; `path` and `hint` say how | Fix the input and retry |
| `not-found` | The block, citation or text does not exist | `find_blocks` or `get_outline` to see current IDs |
| `duplicate` | The ID is taken (deleted IDs stay taken) | Pick a fresh ID or omit it |
| `history` | Nothing to undo or redo in this session | Re-read |

For text edits that should survive unrelated changes elsewhere in the document, pass the `expectedRevision` you read and `conflictPolicy: "rebase-safe"`: the edit applies if the block itself is unchanged.

## Staying safe

- **Preview** any write with `dryRun: true`. The result is what would happen (`revisionAfter`, `added`, `removed`, `changed`); nothing is saved.
- **Retry safely** by sending a `transactionId` and the same `expectedRevision`: an identical retry returns the first result with `duplicate: true` instead of applying twice.
- **Undo** (`undo`, `redo`) covers this editing session only and needs the current `expectedRevision`. A server restart starts with no history. The CLI cannot undo; keep a copy before `import --mode replace`.
- **Replace and delete** are visible in `readOnlyHint` / `destructiveHint` annotations. `delete_blocks` on a section deletes everything inside it.
- **Do not invent**. Cite sources, state data sources on charts and say so when data is missing. Reports here are analysis, not advice.

## Limits

| Limit | Value |
| --- | --- |
| Blocks per document | 5 000; nesting depth 64 |
| Blocks per insert call | 500 (larger inserts are split automatically up to the document limit) |
| Operations per transaction | 256 |
| Text per field | 100 000 characters; list item or table cell 10 000; title 1 000 |
| Table | 100 columns, 2 000 rows, 20 000 cells |
| Chart | 20 000 points, 100 series, 100 annotations, heatmap 200 by 200 |
| Citations | 2 000 |
| `find_blocks` | 200 results per call (default 50) |
| Markdown per call | 1 000 000 characters |
| HTTP request body | 1 MiB by default (`maxBodyBytes`) |
| MCP stdio message | 4 MiB per line |
| Document or input file (CLI, stdio server) | 32 MiB |

The Core `LIMITS` object and `TRANSPORT_LIMITS` export every number. A call over a limit fails with a `validation` issue and a hint.

## Recipes

**Draft an equity report.** `insert_template({ kind: "equity", subject: "ACME", setTitle: true })`, then `get_outline`, then per section `find_blocks({ within })` and `update_block_text` / `update_block`, `add_chart` for each placeholder, `add_citation` with `marker`, `delete_blocks` for the placeholder notes, `export_markdown` to read it back.

**Fix a number everywhere.** `replace_text({ find: "12.4%", replace: "12.8%" })` edits every block containing it. Add `within` to limit it to one section, `dryRun: true` to see which blocks match.

**Reorder sections.** `move_blocks({ blocks: [{ blockId, expectedVersion }], parentId: null, afterId })`. Children move with their section.

**Import notes.** `import_markdown({ markdown, mode: "append" })` adds them; `mode: "replace"` replaces the whole body (preview with `dryRun`).

**Review without editing.** Start the server with `--read-only`, or use only `readOnlyHint` tools.

## Anti-patterns

- Reading the whole document before every edit. Use the outline and `find_blocks`.
- Guessing a version. Read it.
- Retrying a conflict unchanged. Read the hint, re-read the block, decide.
- Putting HTML in text. It is shown literally; use the block types.
- One huge `apply_transaction` for a text change. `update_block_text` and `replace_text` are smaller and say why they fail.
- Charts without `source`, or with series of different lengths.

## Composing your own surface

Hosts do not have to use the transports. Everything is a separable piece: `@super-solution/editor-core` has the document, the operations, the pure helpers (`findBlocks`, `getOutline`, `toMarkdown`, `fromMarkdown`, `stats`, `diffDocuments`), the builders (`b`, `chart`, `op`, `transaction`), the templates and the action table. A host that keeps documents in a database implements `ReportService` (`read`, `apply`, `undo`, `redo`, optionally `revisions`) over its own storage and gets every action, the HTTP handler, the MCP dispatcher and the client for free. See [API.md](API.md), [SECURITY.md](SECURITY.md) and the runnable [examples](../examples/README.md).
