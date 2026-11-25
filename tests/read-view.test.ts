import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_ACTIONS, b, createDocument, createEditor, createReportService, fromMarkdown, runAgentAction, toMarkdown, type ResearchDocument } from '../packages/core/src/index.js';
import { createMcpDispatcher } from '../backends/typescript/mcp/src/index.js';
import { createResearchExample } from '../examples/report.js';

const MARK = /<!-- id=(\S+) v=(\d+) -->/g;
const marks = (text: string): [string, number][] => [...text.matchAll(MARK)].map(match => [match[1]!, Number(match[2])]);

test('withIds precedes every block, in document order, with its id and version, and changes nothing else', () => {
  const document = createResearchExample().getSnapshot();
  const plain = toMarkdown(document), withIds = toMarkdown(document, { withIds: true });
  // every block of the document, exactly once
  const ids = marks(withIds).map(([id]) => id);
  assert.deepEqual([...ids].sort(), document.blocks.map(block => block.id).sort());
  assert.equal(new Set(ids).size, ids.length);
  for (const [id, version] of marks(withIds)) assert.equal(document.blocks.find(block => block.id === id)!.version, version);
  assert.equal(withIds.replace(MARK, '').replace(/\n\n\n+/g, '\n\n').replace(/\n\n$/, '\n').replace(/^\n+/gm, '\n').replace(/\n+/g, '\n'), plain.replace(/\n+/g, '\n'), 'removing the comments leaves the plain export');
  assert.equal(toMarkdown(document, { withIds: false }), plain);
  assert.equal(toMarkdown(document), plain, 'off by default');
});

test('blocks that print nothing still get a marker, and an id may contain dashes and dots', () => {
  const editor = createEditor(createDocument({ id: 'd', title: 'T' }, { now: () => '2026-10-05T00:00:00.000Z' }), { now: () => '2026-10-05T00:00:00.000Z' });
  const result = editor.apply({ id: 'seed', actor: { id: 'a', kind: 'agent' }, baseRevision: 0, operations: [{ type: 'insertBlocks', blocks: [b.paragraph('empty--one', ''), b.paragraph('with.dots:and-more', 'Text'), b.toc('toc-without-headings')] }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const text = toMarkdown(editor.getSnapshot(), { withIds: true });
  assert.deepEqual(marks(text), [['empty--one', 1], ['with.dots:and-more', 1], ['toc-without-headings', 1]]);
  assert.ok(text.includes('<!-- id=with.dots:and-more v=1 -->\nText'));
});

test('the view is for reading: it can still be parsed, the comments stay as text, and a section can be read alone', () => {
  const document = createResearchExample().getSnapshot();
  assert.doesNotThrow(() => fromMarkdown(toMarkdown(document, { withIds: true }), { idPrefix: 'x' }));
  const service = createReportService(createResearchExample());
  const section = runAgentAction(service, 'export_markdown', { withIds: true, blockId: 'macro' }) as { ok: true; text: string; characters: number };
  assert.equal(section.ok, true);
  assert.ok(section.text.startsWith('<!-- id=macro v=1 -->\n## Macro outlook'));
  assert.ok(!section.text.includes('id=portfolio '), 'only that section');
  assert.equal(section.characters, section.text.length);
});

test('export_markdown withIds is part of the schema, refuses a non-boolean, and the read-edit loop works from one read', async () => {
  const action = AGENT_ACTIONS.find(entry => entry.name === 'export_markdown')!;
  assert.ok((action.inputSchema.properties as Record<string, unknown>).withIds);
  assert.match(action.description, /withIds/);
  const service = createReportService(createResearchExample());
  const bad = runAgentAction(service, 'export_markdown', { withIds: 'yes' }) as { ok: false; issues: { path: string; hint: string }[] };
  assert.equal(bad.ok, false); assert.equal(bad.issues[0]!.path, 'input.withIds'); assert.ok(bad.issues[0]!.hint);
  // an agent reads once, takes an id and a version from the view, and edits with them
  const view = (runAgentAction(service, 'export_markdown', { withIds: true }) as unknown as { text: string }).text;
  const [id, version] = marks(view).find(([blockId]) => blockId === 'macro-summary')!;
  const edited = runAgentAction(service, 'update_block_text', { blockId: id, expectedVersion: version, text: 'Revised from the read view.' });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(service.read().blocks.find(block => block.id === 'macro-summary')!.version, version + 1);
  // the same through MCP, and the tool list points at the view
  const mcp = createMcpDispatcher(createReportService(createResearchExample()));
  const called = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'export_markdown', arguments: { withIds: true } } }) as { result: { structuredContent: { text: string } } };
  assert.ok(called.result.structuredContent.text.includes('<!-- id=macro-summary v=1 -->'));
  const listed = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) as { result: { tools: { name: string; description: string }[] } };
  assert.match(listed.result.tools.find(tool => tool.name === 'read_document')!.description, /export_markdown with withIds/);
});
