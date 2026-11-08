# super-editor-core (Python)

The session editor (`Editor`), the validators, block text extraction (`text_parts`), the
structural diff between two documents (`diff_documents`) and one-line revision summaries
(`summarize_revision`). The TypeScript package in `packages/core` is the reference; this port reproduces
every case in [`../../conformance`](../../conformance/README.md). Pure standard library, no dependencies.
Documents are decoded JSON.

```bash
pip install -e ".[dev]"
pytest                    # or: PYTHONPATH=src python -m unittest discover -s tests
ruff check . && mypy
```

`super_editor.Editor` is the session editor: guarded transactions over the full model (17 block types, nesting),
all 14 operations, rebase-safe stale transactions, undo and redo and the revision log. (The earlier flat-document
editor is `super_editor.GuardedEditor`.) `super_editor.validation` validates documents, transactions, actors, timestamps and URLs with the reference's
first-failure issues.

The read side lives in `super_editor.export` (`to_markdown`), `html_export` (`to_html`), `text` (`to_plain_text`,
`document_stats`, `count_words`), `query` (`find_blocks`, `get_outline`, `ordered_blocks`), `inline` (inline markdown) and
`markdown_import` (`from_markdown`). Word counting uses the Unicode data of the running Python, so a Python and Node release
that disagree on a recent character can differ on exotic text. See the conformance README for the exact scope.

## HTTP server

`super_editor.server` runs the 21 actions (`run_action`) and the HTTP API with the same routes, status codes, headers and
OpenAPI document as the TypeScript handler. `Handler(EditorService(editor), Options(...)).handle(Request(...))` is
framework-neutral (a request in, a response out); `create_wsgi_app` adapts it to WSGI (behind gunicorn, uwsgi or any
WSGI server; it reads the raw request line from `RAW_URI`/`REQUEST_URI` so encoded slashes in IDs survive). Options: body
limit, read-only mode, a fixed actor, a base path and CORS. It authenticates nobody: put it behind your own gateway.

```bash
python -m super_editor.server --document report.json --addr 127.0.0.1:8787 --save
```

The runner uses the standard library's threaded WSGI server for local use. The package needs no dependencies.

GPL-3.0-or-later (`super_editor.server` is AGPL-3.0-or-later); a commercial licence is available from SUPER SOLUTION LABS INC (contact@supersolution.io).
