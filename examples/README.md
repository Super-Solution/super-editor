# Examples

Run from the repository root after `npm ci --ignore-scripts`. Every script runs the TypeScript source through `tsx`; each one is also exercised by `tests/examples-agent.test.ts`, so they stay working.

| Example | What it shows | Run |
| --- | --- | --- |
| `headless.ts` | A stale agent edit refused next to a human edit | `npm run example` |
| `report.ts` | The fictional research notebook used by the demo and the tests | (imported) |
| `all-blocks.ts` | One document with every block type, chart kind, inline mark, callout tone and list style. The stored fixture is `fixtures/all-blocks.v1.json` (regenerate with `npm run build && node scripts/export-fixtures.mjs`) | (imported) |
| `headless-charts.ts` | Analysis numbers to chart specs (`chart.*` builders) to a guarded transaction, then a Markdown export | `npx tsx --conditions=development examples/headless-charts.ts` |
| `http-agent.ts` | A typed `createHttpClient` session against `createHttpHandler`: template, outline, guarded edit, refused stale edit with its hint, chart, export | `npx tsx --conditions=development examples/http-agent.ts` |
| `cli-walkthrough.ts` | Twelve real `super-editor` commands that build a report in a JSON file, with exit codes (including the conflict, exit 3) | `npx tsx --conditions=development examples/cli-walkthrough.ts` |
| `mcp-client.ts` | A minimal MCP client over stdio driving `super-editor-mcp`: initialize, list tools, edit with versions, see a stale edit refused, read a resource and a prompt | `npx tsx --conditions=development examples/mcp-client.ts /tmp/demo-report.json` |
| `demo.tsx` and `demo/` | The workspace demo: a Notion / Google Docs style React app built only from the public package exports | `npm run dev` |

## The workspace demo

`npm run dev` serves `index.html`, which loads `examples/demo.tsx`. It is a working editor workspace and, at the same time, the example of how the packages compose: everything on screen comes from the public exports of `editor-core`, `editor-ui` and `editor-react`, and the demo adds only layout, state and a little CSS. `npm run build:demo` bundles it to `demo-dist/`.

- **Pages (left rail).** "Research report" and "Every block & chart" are the two fixtures above. "New from template" opens one page per report template (`listTemplates`, `createTemplate`), and "Empty page" shows the empty state. Each page is its own `Editor`, so switching is a re-render with its own undo history and nothing reloads. The `Outline` follows the active heading; on a phone the rail is a drawer.
- **Center.** `DocumentHeader` (editable title), `ReportEditor` (interactive by default, with `theme` and `density`), `FindReplace` (Mod+F / Mod+H), toasts for every refused edit, `EmptyDocumentState`, and an Export menu: JSON, Markdown, HTML and plain text through `serializeDocument` / `toMarkdown` / `toHTML` / `toPlainText`, plus Print. The Shortcuts button opens the editor's help (Mod+/). The theme switch sets `data-se-theme` on `<html>`, so the page chrome follows the editor.
- **Right panel.** *History*: `RevisionHistory` over `editor.getRevisions()`; picking a revision outlines in the document what changed since (`useRevisionDiff`, `diffMarks`), and Restore applies it as one new guarded revision. *Agent*: buttons that call `runAgentAction` as `research-agent` (insert a chart, append markdown, replace a phrase, add a citation, a stale update that is refused with its hint, a stale update that `rebase-safe` lets through, and a dry-run switch); the log shows every call, its result, revision and hint. *Sources*: the citations with `CitationHoverCard`. *Parts*: switches for each part of the interaction layer and for read-only.
- **Bottom.** `StatusBar` with a `SaveIndicator` fed by a simulated save, 800 ms after the last revision.

| File | What it holds |
| --- | --- |
| `demo.tsx`, `demo.css` | Entry point; the chrome, written only with `--se-*` tokens |
| `demo/App.tsx` | What outlives a page: the page list, theme, density, drawers, panel tab |
| `demo/DocView.tsx` | One page: header, editor, find, status bar, the panel, and how they talk to each other |
| `demo/Rail.tsx` | Page switcher, templates, `Outline` |
| `demo/HistoryTab.tsx`, `AgentTab.tsx`, `SourcesTab.tsx`, `PartsTab.tsx` | The panel tabs |
| `demo/agent.ts` | The agent scenarios, as plain functions over `runAgentAction` and `transaction` (no React) |
| `demo/restore.ts` | Restore a revision as a guarded transaction (no React) |
| `demo/Slots.tsx` | What the page passes into `ReportEditor`'s slots: the empty-state quick start and the controls bar |
| `demo/documents.ts`, `export.ts`, `useSaveState.ts`, `ui.tsx` | Pages and their snapshots, downloads, the simulated save, small controls |

The logic files are covered by `tests/demo-workspace.test.ts`.

## Using the MCP server from a real client

```sh
# Claude Code
claude mcp add super-editor -- npx -y -p @super-solution/editor-mcp@next super-editor-mcp ./report.json --create --id report --template macro --subject "the euro area"
```

From a checkout of this repository, build first (`npm run build`) and point the client at `node packages/mcp/dist/stdio.js ./report.json`. The agent then works through the tools described in [docs/AGENT-GUIDE.md](../docs/AGENT-GUIDE.md).

## Fixtures

- `fixtures/research-report.v1.json` and `fixtures/agent-update.json`: the notebook and a guarded agent proposal for it.
- `fixtures/all-blocks.v1.json`: every block type and chart kind, all numbers invented. Use it to check a renderer, an exporter or a migration.
