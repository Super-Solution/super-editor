# API reference: actions, HTTP, MCP and CLI

One table of **actions** (`AGENT_ACTIONS` in `@super-solution/editor-core`) defines every semantic operation. The MCP tools, the HTTP routes under `/actions` and the CLI commands are thin wrappers over it, so they accept the same inputs and return the same results. How to use them is in the [agent guide](AGENT-GUIDE.md); this page is the reference.

Contents: [Conventions](#conventions) · [Actions](#actions) · [HTTP](#http) · [MCP](#mcp) · [CLI](#cli) · [Templates](#templates) · [Limits](#limits)

## Conventions

**Success.** Reads return a compact object with `ok: true` and the document `revision`. Edits return the same shape:

```ts
{ ok: true, revision: number, summary: string,
  added: string[], removed: string[], changed: string[], moved: string[],
  blocks: { id, type, version }[],          // the blocks that were added, changed or moved (up to 100; `truncated: true` beyond)
  titleChanged?: true, citations?: { added, removed, changed },
  dryRun?: true, revisionAfter?: number,     // dryRun: nothing was saved; revision is unchanged
  duplicate?: true }                         // an identical retry: nothing was applied again
```

Some actions add fields: `blockId` (`add_chart`), `citationId` (`add_citation`), `idPrefix` and `rootIds` (`insert_template`), `matchedBlocks` (`replace_text` without `blockId`), `mode` (`import_markdown`).

**Failure.** Every failure, from every transport, is:

```ts
{ ok: false, currentRevision: number,
  issues: { code: 'validation' | 'conflict' | 'not-found' | 'duplicate' | 'history',
            message: string, hint: string, path?: string, blockId?: string }[] }
```

`hint` is always present and says how to fix the call. `path` points into the input of the action (`input.blocks[1].content.runs[0].href`). Core failures (`apply_transaction`, `/transactions`) have the same shape; their `path` starts with `transaction.`.

**Guards.** `update_block_text`, `update_block`, `move_blocks`, `delete_blocks` and the single-block forms of `replace_text` and `add_citation` need `expectedVersion` (the block version you last read). A stale version is a `conflict` and the hint names the current one. `expectedRevision` (any write) fails with a conflict unless the document is at that revision. `conflictPolicy: "rebase-safe"` lets a text edit apply over unrelated changes when the block itself is unchanged.

**Write controls** accepted by every write action: `transactionId` (idempotency key; an identical retry with the same `expectedRevision` returns the first result), `expectedRevision`, `dryRun`.

**Actor.** The author recorded on a revision is provenance, not authentication. MCP: the `--actor` flag or `createMcpDispatcher(service, { actor })`. HTTP: the `actor` option (wins), else an `actor` object in the request body, else `http-client:agent`. CLI: `--actor`. Authenticate callers in the host.

## Actions

| Action | Access | Input (**required**) |
| --- | --- | --- |
| `get_outline` | read | maxDepth |
| `find_blocks` | read | type, text, parentId, within, ids, citationId, limit, offset, include |
| `get_block` | read | **blockId** |
| `document_stats` | read | (none) |
| `export_markdown` | read | blockId |
| `export_html` | read | blockId, standalone |
| `export_text` | read | blockId |
| `list_revisions` | read | limit, offset |
| `list_templates` | read | (none) |
| `validate_transaction` | read | **transaction** |
| `insert_blocks` | write | markdown or blocks, afterId, parentId, idPrefix |
| `update_block_text` | write, destructive | **blockId**, **expectedVersion**, **text**, format, conflictPolicy |
| `update_block` | write, destructive | **blockId**, **expectedVersion**, **content**, citationIds, conflictPolicy |
| `replace_text` | write, destructive | **find**, **replace**, blockId, expectedVersion, within, all, caseSensitive, conflictPolicy |
| `move_blocks` | write | **blocks** (`{ blockId, expectedVersion }[]`), **parentId**, afterId |
| `delete_blocks` | write, destructive | **blocks** |
| `add_chart` | write | **spec**, afterId, parentId, id, citationIds |
| `add_citation` | write | **title**, **url**, id, accessedAt, publishedAt, blockId, expectedVersion, marker |
| `set_title` | write, destructive | **title** |
| `insert_template` | write | **kind**, subject, idPrefix, afterId, parentId, setTitle |
| `import_markdown` | write, destructive | **markdown**, mode, setTitle, afterId, parentId, idPrefix |

Behaviour worth knowing:

- **Placement.** `afterId` is a sibling in the destination: a block ID inserts after it, `null` inserts first, omitting it appends to the end of `parentId` (the document root unless given). Markdown blocks go to `parentId`; blocks you send carry their own `parentId`.
- **`find_blocks`** returns `{ total, offset, count, truncated?, blocks }` in reading order. `include: "content"` returns full blocks. `text` matches case-insensitively against the block's visible text (title, paragraph text, list items, table cells, chart title and caption, image alt).
- **`update_block_text`** works on paragraph, heading, quote, callout, code, list (one item per line; `checked` and `indent` are kept by position), section and toggle. Inline markdown is parsed for paragraph, quote and callout unless `format` is `plain`. Other types return a `validation` issue that points to `replace_text` and `update_block`.
- **`replace_text`** replaces every occurrence unless `all: false`, case-insensitively unless `caseSensitive`. Matches may span formatting runs; the replacement takes the formatting where the match starts. With `blockId` it edits that block (needs `expectedVersion`); without it, every block containing the text (using current versions), limited by `within`; at most 256 blocks per call. No match is a `not-found`.
- **`insert_blocks`** takes `markdown` (converted to blocks with fresh IDs unless `idPrefix` is given) or `blocks` (`{ id, content, parentId?, citationIds? }[]`, parents first). Large inserts are split into 500-block batches inside one transaction.
- **`import_markdown`** `mode: "replace"` deletes every existing block first and imports the markdown as the new body; `setTitle` takes the title from a leading `# Title` line.
- **`add_citation`** with `blockId` also attaches the citation to the block's `citationIds`; `marker: true` appends an inline marker to paragraph, quote or callout text.
- **Exports** return `{ format, characters, text }`. `blockId` exports one block with its descendants. HTML is escaped static markup; `standalone: true` is a full page with a small stylesheet.
- **`list_revisions`** returns the revisions of the current editing session (the service's `revisions()`), newest first.
- **`validate_transaction`** applies a Core transaction to a scratch copy and returns what would change, or the issues. Nothing is saved.

Core extensions that make this possible: `ReportService.revisions?()`, `AGENT_ACTIONS`, `getAgentAction`, `runAgentAction`, `TRANSPORT_LIMITS`, the typed `AgentActionInputs` / `AgentActionOutputs` maps and the template functions.

## HTTP

`createHttpHandler(service, options)` returns `(request: Request) => Promise<Response>`. It binds no port and authenticates nobody.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | `{ ok: true, revision }` |
| GET | `/document` | The whole document |
| POST | `/transactions` | Apply a Core transaction (the body is the transaction) |
| POST | `/undo`, `/redo` | `{ actor, expectedRevision }`; session history |
| GET | `/outline?maxDepth=` | `get_outline` |
| GET | `/blocks?type=&q=&parentId=&within=&ids=&citationId=&limit=&offset=&include=` | `find_blocks`. `type` and `ids` take commas or repeats; `parentId=null` selects top-level blocks |
| GET | `/blocks/{id}` | `get_block` |
| GET | `/stats` | `document_stats` |
| GET | `/revisions?limit=&offset=` | `list_revisions` |
| GET | `/export.md`, `/export.html`, `/export.txt` | Downloadable text; `?blockId=`; `/export.html` is a full page unless `?standalone=false` |
| POST | `/import/markdown` | JSON `import_markdown` input, or raw markdown with `Content-Type: text/markdown` and the options as query parameters (`mode`, `afterId`, `parentId`, `setTitle`, `idPrefix`, `dryRun`, `actor=id[:kind]`) |
| GET | `/templates`, `/templates/{kind}?subject=&idPrefix=` | List templates; preview one (inserts nothing) |
| GET | `/actions` | Every action with description and JSON Schema |
| POST | `/actions/{name}` | Run any action: the JSON body is its input plus an optional `actor` |
| GET | `/openapi.json` | OpenAPI 3.1 description, generated from the route and action tables |
| GET | `/schemas/document.json`, `/schemas/transaction.json` | JSON Schema 2020-12 |

**Status codes.** `200` accepted (including `dryRun`); `400` invalid request or edit (unknown query parameter, bad input, `validation`); `403` read-only handler; `404` unknown route, action, block or template (`not-found`); `405` wrong method (with `Allow`); `409` conflict, duplicate ID or transaction, or nothing to undo; `413` body over the limit; `415` body not JSON. The original Core routes (`/transactions`, `/undo`, `/redo`) keep their rule: `409` for a conflict, otherwise `400`. All responses carry `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; reads that render a revision add `X-Document-Revision`. `HEAD` works like `GET` without a body.

**Options.**

| Option | Meaning |
| --- | --- |
| `maxBodyBytes` | Largest request body; default 1 048 576 |
| `actor` | A fixed `Actor` or `(request) => Actor`. Set it from your authenticated session; it wins over a body `actor` |
| `readOnly` | Refuse everything that can change the document (403) |
| `cors` | `{ origins: '*' \| string[], headers?, maxAge? }`. Off by default; browsers get no CORS headers unless set. Exact origins only. `Vary: Origin` is added for a specific origin. Preflight answers `204`; a disallowed origin gets `403` |
| `basePath` | Strip this prefix (for example `/api/reports/42`) before routing and list it in the OpenAPI `servers` |
| `now` | Clock for timestamps the actions create |

`GET /export.html` sends `Content-Security-Policy: default-src 'none'; img-src https:; style-src 'unsafe-inline'; sandbox` so a generated page stays inert even when opened directly.

**Typed client.** `createHttpClient({ baseUrl, fetch?, headers?, actor?, timeoutMs? })`:

```ts
const client = createHttpClient({ baseUrl: 'https://host/api', headers: () => ({ authorization: `Bearer ${token()}` }), actor: { id: 'bot', kind: 'agent' } });
const found = await client.actions.find_blocks({ type: 'chart' });      // typed input and result
const edit = await client.actions.update_block_text({ blockId, expectedVersion, text });
if (!edit.ok) console.log(edit.issues[0].hint);                           // a refused edit is returned, not thrown
await client.apply(transaction); await client.undo(actor, revision); await client.document(); await client.openapi();
await client.run('document_stats');                                       // by name, untyped
```

A network failure, a timeout (default 30 s) or a body that is not JSON throws `HttpClientError`.

## MCP

`createMcpDispatcher(service, options)` is a JSON-RPC 2.0 server core (`(message) => Promise<response | undefined>`); `runStdioServer(argv, io)` and the `super-editor-mcp` binary put it on stdin and stdout. Supported: `initialize` (protocol `2025-06-18`, `2025-03-26` or `2024-11-05`), `ping`, `notifications/*`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`. No JSON-RPC batches, no subscriptions, no sessions.

**Tools (25).** The four Core tools `read_document`, `apply_transaction`, `undo`, `redo`, then every action by name (above). Each has `title`, `description`, `inputSchema` and annotations:

- `readOnlyHint: true` for reads; for writes `destructiveHint: true` when the tool can delete or overwrite (`apply_transaction`, `undo`, `redo`, `update_block_text`, `update_block`, `replace_text`, `delete_blocks`, `set_title`, `import_markdown`) and `false` for additive or reordering tools (`insert_blocks`, `add_chart`, `add_citation`, `insert_template`, `move_blocks`).
- `idempotentHint: true` when repeating the call changes nothing more; `openWorldHint: false` always.

A tool result is `{ content: [{ type: 'text', text }], structuredContent, isError? }`. `structuredContent` is the action result; `content` carries the same JSON, except the export tools, whose `content` is the raw markdown, HTML or text. A refused edit is a normal result with `isError: true` and the failure object. Unknown tools and malformed requests are JSON-RPC errors (`-32602`, `-32600`, `-32601`).

**Resources.** `super-editor://document` (JSON), `document.md`, `outline`, `stats`, `citations`, `schema/document`, `schema/transaction`, `guide`; templates `super-editor://block/{id}` and `super-editor://section/{id}.md`. An unknown URI is error `-32002`.

**Prompts.** `draft_report` (`kind`, `subject`, optional `notes`), `review_report` (optional `focus`), `summarize_document` (optional `length`), `add_citations` (`sources`). Each returns user messages that tell the agent which tools to call in which order.

**Dispatcher options.** `actor`, `readOnly` (hide and refuse every write tool), `serverInfo`, `instructions`, `now`.

**stdio server.** `super-editor-mcp <document.json> [--actor <id[:kind]>] [--read-only] [--create --id <id> [--title <t>] [--template <kind>] [--subject <text>]]`, `--help`, `--version`; environment `SUPER_EDITOR_ACTOR`, `SUPER_EDITOR_READ_ONLY=1`. Messages are one JSON object per line; logs go to stderr only. Each edit takes the same `<file>.lock` the CLI uses, is applied, and is saved with a temporary file and a rename before the reply. If saving fails, memory is reloaded from disk and the call fails with a `conflict` and a hint. Edits made to the file by someone else are picked up before the next call (session undo history is dropped when that happens). If `<file>.history.jsonl` exists, every edit appends a line to it. A line over 4 MiB is refused once and skipped. Exit codes: `0` normal, `1` I/O, `2` invalid input or document.

## CLI

`super-editor <command> <document.json> [arguments] [options]`; `super-editor help [<command>]`.

| Command | Purpose |
| --- | --- |
| `init`, `new` | Create a document (`new` accepts `--template`, `--subject`, `--history`); never overwrites |
| `templates`, `tools` | List templates; list actions or print one action's JSON Schema |
| `read`, `apply` | Print the document; apply a Core transaction (file or `-`) |
| `validate` | Validate the document, optionally a `--transaction` against it |
| `outline`, `find`, `get`, `stats`, `revisions` | Reads (`find`: `--type`, `--text`, `--parent`, `--within`, `--ids`, `--cite`, `--limit`, `--offset`, `--full`) |
| `insert`, `import`, `add-template` | Add markdown or blocks, import markdown (`--mode append\|replace`), insert a template |
| `update-text`, `update`, `replace`, `title` | Change text or content; find and replace |
| `move`, `delete` | Reorder or remove blocks |
| `chart`, `cite` | Add a chart from a JSON spec; add a source |
| `export` | Markdown, HTML or text to stdout or `--out` |
| `call` | Run any action with `--input <json\|file\|->` |

Conventions: a block you edit is written `<blockId>@<version>` (versions come from `find` and `get`); `--unguarded` accepts a bare ID and uses the current version without a stale-read guard. `-` reads a file argument from standard input (`--markdown -`, `--spec -`, `--text-file -`, `--content -`). Placement is `--after <id>`, `--first`, `--parent <id|root>`. Editing commands also take `--actor <id[:kind]>` (default `cli:system`, or `SUPER_EDITOR_ACTOR`), `--dry-run`, `--expect-revision <n>`, `--json`.

**Output.** Text by default; `--json` prints the action result as one JSON line on stdout and failures as one JSON line on stderr (`read`, `apply`, `init` and `call` always answer with JSON). **Exit codes:** `0` success, `1` I/O failure (including a held lock), `2` invalid input or document, `3` revision or version conflict, `4` block, citation or text not found.

**Files.** Editing commands take `<file>.lock` exclusively, validate the whole change and replace the file atomically, only when the revision moved. A stale lock is never removed for you. `init --history` or `new --history` creates `<file>.history.jsonl`; while it exists, every CLI or stdio-server edit appends `{ number, at, actor, kind, transactionId, summary }`, and `revisions` reads it. A JSON file otherwise stores only its revision number.

## Templates

`createTemplate(kind, { idPrefix?, subject?, parentId? })` returns ordered `BlockInput[]` for `insertBlocks`; `equityTemplate`, `macroTemplate`, `portfolioTemplate`, `strategyTemplate`, `arbitrageTemplate`, `comparisonTemplate` and `blankTemplate` are the same functions. IDs are `<idPrefix>-<slug>` (the prefix defaults to the kind). `templateTitle(kind, subject)` gives the matching document title, `listTemplates()` the kinds with their section titles, `TEMPLATE_KINDS` and `isTemplateKind` the names. Templates contain structure and guidance only: empty tables, dash placeholders in metrics, "Chart placeholder" notes, a "Data and methodology" section and an analysis-only note.

## Limits

Core limits (`LIMITS`): 5 000 blocks, depth 64, 256 operations, 500 blocks per operation, 2 000 citations, 100 000 text characters, 20 000 chart points, 8 000 000 serialized characters. Transport limits (`TRANSPORT_LIMITS`):

| Name | Value | Where it applies |
| --- | --- | --- |
| `requestBytes` | 1 048 576 | HTTP body default (`maxBodyBytes`) |
| `markdownChars` | 1 000 000 | `markdown` in `insert_blocks`, `import_markdown` |
| `findDefault` / `findMax` | 50 / 200 | `find_blocks` |
| `revisionsDefault` / `revisionsMax` | 20 / 200 | `list_revisions` |
| `blocksPerCall` | 500 | one `insertBlocks` batch |
| `textPreviewChars` | 160 | text in block summaries |
| `resultBlocks` | 100 | touched blocks listed in a write result |
| `stdioMessageBytes` | 4 194 304 | one stdio JSON-RPC line |
| `fileBytes` | 33 554 432 | document and input files for the CLI and stdio server |

Limits are enforced where the data enters: schema checks in the action, the HTTP body reader, the stdio line reader and the file readers. A call over a limit fails with a `validation` issue; over HTTP a large body is `413`.
