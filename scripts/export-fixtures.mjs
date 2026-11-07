import { mkdir, writeFile } from 'node:fs/promises';
import { createAllBlocksExample } from '../dist/examples/all-blocks.js';
import { createResearchExample } from '../dist/examples/report.js';
const fixture = createResearchExample().getSnapshot();
const directory = new URL('../examples/fixtures/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('research-report.v1.json', directory), `${JSON.stringify(fixture, null, 2)}\n`);
await writeFile(new URL('agent-update.json', directory), `${JSON.stringify({
  id: 'fixture-agent-update', actor: { id: 'research-agent', kind: 'agent' }, baseRevision: fixture.revision,
  operations: [{ type: 'updateBlock', blockId: 'portfolio-summary', expectedVersion: 1,
    content: { type: 'paragraph', runs: [{ text: 'Illustrative agent proposal: review liquidity and concentration before distribution.' }] } }]
}, null, 2)}\n`);
await writeFile(new URL('all-blocks.v1.json', directory), `${JSON.stringify(createAllBlocksExample().getSnapshot(), null, 2)}\n`);
