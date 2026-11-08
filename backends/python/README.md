# super-editor-core (Python)

Guarded transactions on flat paragraph documents (`Editor`), block text extraction (`text_parts`), the
structural diff between two documents (`diff_documents`) and one-line revision summaries
(`summarize_revision`). The TypeScript package in `packages/core` is the reference; this port reproduces
every case in [`../../conformance`](../../conformance/README.md). Pure standard library, no dependencies.
Documents are decoded JSON.

```bash
pip install -e ".[dev]"
pytest                    # or: PYTHONPATH=src python -m unittest discover -s tests
ruff check . && mypy
```

`super_editor.validation` validates documents, transactions, actors, timestamps and URLs with the reference's
first-failure issues.

Not covered yet: nested blocks in transactions, markdown/HTML export
and word statistics (which need Unicode script data). See the conformance README for the exact scope.

GPL-3.0-or-later; a commercial licence is available from SUPER SOLUTION LABS INC (contact@supersolution.io).
