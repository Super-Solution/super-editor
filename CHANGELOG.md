# Changelog

All notable changes to the eight `@supersolutions/super-editor-*` packages (released together, same version). The document format stays `schemaVersion: 1`.

## 0.1.0 (unreleased)

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
