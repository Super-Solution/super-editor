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
| `demo.tsx` | The React demo (`npm run dev`) | `npm run dev` |

## Using the MCP server from a real client

```sh
# Claude Code
claude mcp add super-editor -- npx -y -p @super-solution/editor-mcp@next super-editor-mcp ./report.json --create --id report --template macro --subject "the euro area"
```

From a checkout of this repository, build first (`npm run build`) and point the client at `node packages/mcp/dist/stdio.js ./report.json`. The agent then works through the tools described in [docs/AGENT-GUIDE.md](../docs/AGENT-GUIDE.md).

## Fixtures

- `fixtures/research-report.v1.json` and `fixtures/agent-update.json`: the notebook and a guarded agent proposal for it.
- `fixtures/all-blocks.v1.json`: every block type and chart kind, all numbers invented. Use it to check a renderer, an exporter or a migration.
