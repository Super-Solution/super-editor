import { pathToFileURL } from 'node:url';
import { createDocument, createEditor, createReportService } from '@super-solution/editor-core';
import { createHttpClient, createHttpHandler } from '@super-solution/editor-api';

/**
 * An agent drives the HTTP API through the typed client. The handler runs in memory here; in production the same client points
 * at your server (`baseUrl`) and your server authenticates the caller before it forwards requests to `createHttpHandler`.
 *   npx tsx --conditions=development examples/http-agent.ts
 */
export async function runHttpAgentExample(log: (line: string) => void = () => undefined) {
  const service = createReportService(createEditor(createDocument({ id: 'http-example', title: 'HTTP example' })));
  const handler = createHttpHandler(service, { basePath: '/api', actor: { id: 'gateway-session-42', kind: 'agent' } });
  const client = createHttpClient({ baseUrl: 'https://reports.example.invalid/api', fetch: async (url, init) => handler(new Request(url as string, init)) });

  // Start from a template, then look at the layout cheaply.
  const inserted = await client.actions.insert_template({ kind: 'equity', subject: 'ACME', setTitle: true });
  if (!inserted.ok) throw new Error(inserted.issues[0]!.message);
  log(`template inserted at revision ${inserted.revision}: ${inserted.summary}`);
  const outline = await client.actions.get_outline();
  if (!outline.ok) throw new Error('outline failed');
  log(`outline: ${outline.outline.map(entry => entry.title).join(' | ')}`);

  // Find the block to fill, read its version, then edit with that version.
  const found = await client.actions.find_blocks({ text: 'thesis', type: 'paragraph' });
  if (!found.ok) throw new Error('find failed');
  const brief = found.blocks[0] as { id: string; version: number };
  const edited = await client.actions.update_block_text({ blockId: brief.id, expectedVersion: brief.version, text: 'ACME grew revenue **12%** while margins held.' });
  log(`edit ${edited.ok ? 'accepted' : 'rejected'}`);

  // Repeating the edit with the old version is a conflict, not an overwrite. The failure explains how to recover.
  const stale = await client.actions.update_block_text({ blockId: brief.id, expectedVersion: brief.version, text: 'A stale proposal.' });
  const conflict = stale.ok ? undefined : stale.issues[0];
  log(`stale edit: ${conflict?.code} (${conflict?.hint})`);

  const chart = await client.actions.add_chart({ spec: { kind: 'bar', title: 'Revenue by quarter', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Revenue', values: [10, 11, 12.5] }], unit: 'M', source: 'Example filings' }, parentId: 'equity-performance', afterId: null });
  log(`chart added: ${chart.ok ? chart.blockId : 'failed'}`);
  const markdown = await client.actions.export_markdown();
  return { inserted, edited, conflict, chart, markdown: markdown.ok ? markdown.text : '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runHttpAgentExample(console.log);
  console.log(result.markdown);
}
