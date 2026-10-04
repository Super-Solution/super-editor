# @super-solution/editor-cli

Local JSON research-report CLI over the shared Core validation and transaction engine. Made for agents (every command has `--json` and distinct exit codes) and for people.

```sh
npx --package @super-solution/editor-cli@next super-editor help
super-editor new report.json --id aapl-q3 --template equity --subject AAPL
super-editor outline report.json
super-editor find report.json --type paragraph --text revenue
super-editor update-text report.json aapl-q3-summary-thesis@1 --text "Revenue grew **12%**."
super-editor insert report.json --markdown notes.md --after aapl-q3-summary
super-editor chart report.json --spec chart.json --parent aapl-q3-performance
super-editor cite report.json --title "Annual report" --url https://example.com/10k --block aapl-q3-summary-thesis@2 --marker
super-editor export report.json --format html --out report.html
```

## Commands

`init`, `new` (from a template), `templates`, `read`, `apply` (a Core transaction), `validate`, `outline`, `find`, `get`, `stats`, `revisions`, `insert`, `import`, `add-template`, `update-text`, `update`, `replace`, `title`, `move`, `delete`, `chart`, `cite`, `export`, `tools`, `call` (run any action by name with a JSON input). `super-editor help <command>` shows the options.

A block you change is named `<blockId>@<version>` (versions are in the output of `find` and `get`). A stale version is a conflict (exit 3); the hint names the current one. `--unguarded` accepts a bare ID and uses the current version without that protection. `--dry-run` previews, `--expect-revision <n>` guards the document, `--actor <id[:kind]>` records the author, `-` reads a file argument from standard input.

`--json` prints one JSON line (the same result objects as the MCP tools and HTTP actions); without it, output is readable text. Failures print the same issues with hints. **Exit codes:** 0 success, 1 I/O failure (including a held lock), 2 invalid input, 3 revision or version conflict, 4 not found.

## Files

`init` and `new` refuse to overwrite. Editing commands take an exclusive `<file>.lock`, validate the whole batch and replace the file atomically only on success; a stale lock is never removed for you, and other writers must use the same lock protocol (the `super-editor-mcp` server does). Create `<file>.history.jsonl` (`init --history`) and every edit appends a line that `revisions` reads. Undo/redo history is session-only and not available from the CLI. No network server, no trading execution, no credential storage.

The package root exports `runCli`, `CLI_HELP`, `COMMANDS` and `CliOutput`; `./cli` exposes the same implementation. Reference: [docs/API.md](../../docs/API.md#cli). Agent workflow: [docs/AGENT-GUIDE.md](../../docs/AGENT-GUIDE.md). ESM, Node.js 22+, Apache-2.0.
