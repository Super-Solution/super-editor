# @super-solution/editor-cli

Local JSON research report CLI using the shared Core validation and transaction engine.

```sh
npx --package @super-solution/editor-cli@next super-editor help
super-editor init report.json --id weekly --title "Weekly research"
super-editor read report.json
super-editor apply report.json transaction.json
```

`init` refuses overwrite. `apply` validates the whole batch, takes a local lock, and atomically replaces the file only on success. Revision and block-version guards are required. Undo/redo history is session-only; use a long-lived Core service for it. No network server or trading execution.

The package root exports `runCli`, `CLI_HELP`, and `CliOutput`; `./cli` exposes the same implementation. Exit codes: 0 success, 1 I/O failure, 2 invalid input, 3 revision conflict. ESM, Node.js 22+, Apache-2.0.
