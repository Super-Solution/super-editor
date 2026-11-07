import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_ACTIONS, TRANSPORT_LIMITS, createDocument, createEditor, createReportService, getAgentAction, runAgentAction } from '../packages/core/src/index.js';
import type { AgentActionResult, ReportService } from '../packages/core/src/index.js';
import { createResearchExample } from '../examples/report.js';

const actor = { id: 'action-agent', kind: 'agent' as const };
const context = { actor, now: () => '2026-10-05T08:00:00.000Z' };
const clock = () => '2026-10-05T07:00:00.000Z';

function fresh(): ReportService { return createReportService(createEditor(createDocument({ id: 'actions', title: 'Actions' }, { now: clock }), { now: clock })); }
function seeded(): ReportService { return createReportService(createResearchExample()); }
function run(service: ReportService, name: string, input: unknown = {}): AgentActionResult { return runAgentAction(service, name, input, context); }
function ok(result: AgentActionResult): Record<string, any> {
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  return result as Record<string, any>;
}
function fails(result: AgentActionResult, code?: string): { code: string; message: string; path?: string; hint?: string; blockId?: string } {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.ok(result.issues.length > 0 && typeof result.currentRevision === 'number');
  if (code) assert.equal(result.issues[0]!.code, code, JSON.stringify(result.issues));
  return result.issues[0]!;
}
const paragraph = (id: string, text: string, parentId: string | null = null) => ({ id, parentId, citationIds: [], content: { type: 'paragraph', runs: [{ text }] } });
const versionOf = (service: ReportService, id: string) => service.read().blocks.find(block => block.id === id)!.version;

test('the action table has unique snake_case names, schemas and honest access flags', () => {
  const names = AGENT_ACTIONS.map(action => action.name);
  assert.equal(new Set(names).size, names.length);
  for (const action of AGENT_ACTIONS) {
    assert.match(action.name, /^[a-z]+(?:_[a-z]+)*$/);
    assert.ok(action.description.length > 40, action.name);
    assert.equal(action.inputSchema.type, 'object');
    assert.equal(action.inputSchema.additionalProperties, false);
    if (action.access === 'read') assert.equal(action.destructive, false, action.name);
    assert.equal(getAgentAction(action.name), action);
    // Writes accept the shared idempotency, guard and preview controls.
    if (action.access === 'write') for (const key of ['transactionId', 'expectedRevision', 'dryRun']) assert.ok(Object.hasOwn(action.inputSchema.properties as object, key), `${action.name} ${key}`);
  }
  for (const name of ['get_outline', 'find_blocks', 'get_block', 'insert_blocks', 'update_block_text', 'replace_text', 'move_blocks', 'delete_blocks', 'add_chart', 'add_citation', 'export_markdown', 'export_html', 'import_markdown', 'document_stats']) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(getAgentAction('nope'), undefined);
});

test('outline, find and get give compact reads with the versions that guarded edits need', () => {
  const service = seeded();
  const outline = ok(run(service, 'get_outline'));
  assert.equal(outline.title, 'Weekly research notebook');
  assert.equal(outline.revision, 1);
  assert.ok(outline.outline.some((node: { id: string }) => node.id === 'macro'));
  const shallow = ok(run(service, 'get_outline', { maxDepth: 1 }));
  assert.ok(shallow.outline.every((node: { children: unknown[] }) => node.children.length === 0));

  const charts = ok(run(service, 'find_blocks', { type: 'chart' }));
  assert.equal(charts.total, 3);
  assert.deepEqual(charts.blocks.map((block: { id: string }) => block.id), ['macro-trend', 'allocation', 'factor']);
  assert.deepEqual(Object.keys(charts.blocks[0]).sort(), ['citationIds', 'id', 'parentId', 'text', 'type', 'version']);
  assert.equal(charts.blocks[0].text, 'Illustrative inflation path');
  const several = ok(run(service, 'find_blocks', { type: ['chart', 'table'] }));
  assert.equal(several.total, 4);
  assert.equal(ok(run(service, 'find_blocks', { text: 'CONCENTRATION' })).total >= 2, true);
  assert.equal(ok(run(service, 'find_blocks', { within: 'portfolio', type: 'heading' })).total, 1);
  assert.equal(ok(run(service, 'find_blocks', { parentId: null })).total, 3);
  assert.equal(ok(run(service, 'find_blocks', { citationId: 'source-method' })).total, 2);
  assert.equal(ok(run(service, 'find_blocks', { ids: ['macro', 'portfolio', 'ghost'] })).total, 2);
  const page = ok(run(service, 'find_blocks', { limit: 2, offset: 1 }));
  assert.equal(page.count, 2);
  assert.equal(page.truncated, true);
  const full = ok(run(service, 'find_blocks', { type: 'timestamp', include: 'content' }));
  assert.equal(full.blocks[0].content.type, 'timestamp');
  assert.equal(full.blocks[0].createdAt, '2026-10-03T00:00:00.000Z');

  const block = ok(run(service, 'get_block', { blockId: 'macro-trend' }));
  assert.equal(block.block.version, 1);
  assert.deepEqual(block.ancestors.map((entry: { id: string }) => entry.id), ['macro']);
  assert.deepEqual(ok(run(service, 'get_block', { blockId: 'macro' })).children, ['macro-heading', 'macro-summary', 'macro-trend']);
  const missing = fails(run(service, 'get_block', { blockId: 'ghost' }), 'not-found');
  assert.match(missing.hint!, /find_blocks/);
  assert.equal(missing.blockId, 'ghost');
  fails(run(service, 'find_blocks', { within: 'ghost' }), 'not-found');
});

test('insert_blocks takes blocks or markdown, places them, reports versions and is all-or-nothing', () => {
  const service = fresh();
  const added = ok(run(service, 'insert_blocks', { blocks: [
    { id: 'part', content: { type: 'section', title: 'Part' } },
    paragraph('p1', 'First', 'part'), paragraph('p2', 'Second', 'part'),
  ] }));
  assert.equal(added.revision, 1);
  assert.deepEqual(added.added, ['part', 'p1', 'p2']);
  assert.deepEqual(added.blocks.map((entry: { id: string; version: number }) => [entry.id, entry.version]), [['part', 1], ['p1', 1], ['p2', 1]]);
  assert.match(added.summary, /inserted 3 block/);
  ok(run(service, 'insert_blocks', { blocks: [paragraph('mid', 'Between', 'part')], afterId: 'p1', parentId: undefined }));
  assert.deepEqual(service.read().blocks.map(block => block.id), ['part', 'p1', 'mid', 'p2']);
  ok(run(service, 'insert_blocks', { blocks: [paragraph('top', 'First of all')], afterId: null }));
  assert.equal(service.read().blocks[0]!.id, 'top');

  const markdown = ok(run(service, 'insert_blocks', { markdown: 'Hello **world**\n\nSecond paragraph', parentId: 'part' }));
  assert.equal(markdown.added.length, 2);
  assert.ok(service.read().blocks.filter(block => markdown.added.includes(block.id)).every(block => block.parentId === 'part'));
  const again = ok(run(service, 'insert_blocks', { markdown: 'Hello **world**\n\nSecond paragraph', parentId: 'part' }));
  assert.equal(new Set([...markdown.added, ...again.added]).size, 4, 'repeated imports never reuse IDs');

  const before = service.read();
  fails(run(service, 'insert_blocks', {}), 'validation');
  fails(run(service, 'insert_blocks', { markdown: 'x', blocks: [paragraph('q', 'q')] }), 'validation');
  const duplicate = fails(run(service, 'insert_blocks', { blocks: [paragraph('p1', 'again')] }), 'duplicate');
  assert.match(duplicate.hint!, /fresh ID/);
  assert.equal(duplicate.path, undefined);
  const badLink = fails(run(service, 'insert_blocks', { blocks: [paragraph('ok-1', 'fine'), { id: 'bad', content: { type: 'paragraph', runs: [{ text: 'x', href: 'javascript:alert(1)' }] } }] }), 'validation');
  assert.equal(badLink.path, 'input.blocks[1].content.runs[0].href');
  fails(run(service, 'insert_blocks', { blocks: [{ id: 'x', content: { type: 'banner' } }] }), 'validation');
  fails(run(service, 'insert_blocks', { blocks: [paragraph('y', 'y', 'p1')] }), 'validation');
  fails(run(service, 'insert_blocks', { markdown: 'text', idPrefix: 'p1' , afterId: 'ghost' }));
  assert.deepEqual(service.read(), before, 'rejected calls change nothing');
});

test('large inserts are split into Core-sized batches and keep their order', () => {
  const service = fresh();
  const count = TRANSPORT_LIMITS.blocksPerCall * 2 + 10;
  const blocks = Array.from({ length: count }, (_value, index) => paragraph(`bulk-${index}`, `Paragraph ${index}`));
  const result = ok(run(service, 'insert_blocks', { blocks }));
  assert.equal(result.added.length, count);
  assert.equal(result.blocks.length, TRANSPORT_LIMITS.resultBlocks);
  assert.equal(result.truncated, true);
  assert.deepEqual(service.read().blocks.map(block => block.id), blocks.map(block => block.id));
});

test('update_block_text rewrites one block, keeps list state and explains unsupported targets', () => {
  const service = seeded();
  const summary = versionOf(service, 'macro-summary');
  const updated = ok(run(service, 'update_block_text', { blockId: 'macro-summary', expectedVersion: summary, text: 'Rewritten view.', format: 'plain' }));
  assert.deepEqual(updated.changed, ['macro-summary']);
  assert.equal(updated.blocks[0].version, summary + 1);
  const block = service.read().blocks.find(entry => entry.id === 'macro-summary')!;
  assert.deepEqual(block.content, { type: 'paragraph', runs: [{ text: 'Rewritten view.' }] });
  assert.deepEqual(block.citationIds, ['source-method'], 'block-level citations survive');
  ok(run(service, 'update_block_text', { blockId: 'macro-heading', expectedVersion: 1, text: 'New\nheading' }));
  assert.deepEqual(service.read().blocks.find(entry => entry.id === 'macro-heading')!.content, { type: 'heading', level: 2, text: 'New heading' });
  ok(run(service, 'update_block_text', { blockId: 'macro', expectedVersion: 1, text: 'Macro view' }));
  assert.deepEqual(service.read().blocks.find(entry => entry.id === 'macro')!.content, { type: 'section', title: 'Macro view' });

  const items = ok(run(service, 'update_block_text', { blockId: 'next-steps', expectedVersion: 1, text: '- One\n* Two\n3. Three\n\n  Four  ' }));
  assert.equal(items.changed[0], 'next-steps');
  assert.deepEqual((service.read().blocks.find(entry => entry.id === 'next-steps')!.content as { items: string[] }).items, ['One', 'Two', 'Three', 'Four']);
  ok(run(service, 'update_block', { blockId: 'next-steps', expectedVersion: 2, content: { type: 'list', ordered: false, style: 'todo', items: ['A', 'B'], checked: [true, false] } }));
  ok(run(service, 'update_block_text', { blockId: 'next-steps', expectedVersion: 3, text: 'A\nB\nC' }));
  assert.deepEqual(service.read().blocks.find(entry => entry.id === 'next-steps')!.content, { type: 'list', ordered: false, style: 'todo', items: ['A', 'B', 'C'], checked: [true, false, false] });

  const chart = fails(run(service, 'update_block_text', { blockId: 'allocation', expectedVersion: 1, text: 'x' }), 'validation');
  assert.match(chart.hint!, /replace_text|update_block/);
  assert.equal(chart.path, 'input.blockId');
  const stale = fails(run(service, 'update_block_text', { blockId: 'macro-summary', expectedVersion: summary, text: 'Stale' }), 'conflict');
  assert.match(stale.hint!, new RegExp(`version ${summary + 1}`));
  const missingVersion = fails(run(service, 'update_block_text', { blockId: 'macro-summary', text: 'x' }), 'validation');
  assert.equal(missingVersion.path, 'input.expectedVersion');
  assert.match(missingVersion.hint!, /Add "expectedVersion"/);
  fails(run(service, 'update_block_text', { blockId: 'next-steps', expectedVersion: 4, text: '  \n ' }), 'validation');
});

test('update_block_text can rebase over an unrelated edit only when asked to', () => {
  const service = seeded();
  const baseRevision = service.read().revision;
  ok(run(service, 'update_block_text', { blockId: 'macro-heading', expectedVersion: 1, text: 'Human heading' }));
  const strict = fails(run(service, 'update_block_text', { blockId: 'macro-summary', expectedVersion: 1, text: 'Agent text', expectedRevision: baseRevision }), 'conflict');
  assert.match(strict.hint!, /Re-read/);
  const rebased = ok(run(service, 'update_block_text', { blockId: 'macro-summary', expectedVersion: 1, text: 'Agent text', expectedRevision: baseRevision, conflictPolicy: 'rebase-safe' }));
  assert.deepEqual(rebased.changed, ['macro-summary']);
});

test('replace_text edits one guarded block or every matching block, and explains misses', () => {
  const service = seeded();
  const single = ok(run(service, 'replace_text', { blockId: 'macro-summary', expectedVersion: 1, find: 'FICTIONAL', replace: 'sample' }));
  assert.deepEqual(single.changed, ['macro-summary']);
  assert.match(JSON.stringify(service.read().blocks.find(block => block.id === 'macro-summary')!.content), /sample observations/);
  fails(run(service, 'replace_text', { blockId: 'macro-summary', expectedVersion: 1, find: 'x', replace: 'y' }), 'conflict');
  fails(run(service, 'replace_text', { blockId: 'macro-summary', find: 'x', replace: 'y' }), 'validation');
  const miss = fails(run(service, 'replace_text', { blockId: 'macro-summary', expectedVersion: 2, find: 'zzz', replace: 'y' }), 'not-found');
  assert.match(miss.hint!, /case-sensitive/);
  fails(run(service, 'replace_text', { blockId: 'macro-trend', expectedVersion: 1, find: 'zzz', replace: 'y' }), 'not-found');

  const wide = ok(run(service, 'replace_text', { find: 'illustrative', replace: 'Sample' }));
  assert.ok(wide.matchedBlocks >= 3);
  assert.equal(wide.changed.length, wide.matchedBlocks);
  const titles = service.read().blocks.filter(block => block.content.type === 'chart').map(block => (block.content as { spec: { title: string } }).spec.title);
  assert.ok(titles.includes('Sample inflation path'));
  assert.ok(!JSON.stringify(service.read().blocks).includes('Illustrative inflation'));
  const scoped = ok(run(service, 'replace_text', { find: 'Sample', replace: 'Example', within: 'portfolio', caseSensitive: true }));
  assert.ok(scoped.changed.every((id: string) => ['allocation', 'factor', 'portfolio-summary'].includes(id)), JSON.stringify(scoped.changed));
  assert.ok(service.read().blocks.find(block => block.id === 'macro-trend') !== undefined && JSON.stringify(service.read().blocks.find(block => block.id === 'macro-trend')).includes('Sample inflation path'));
  fails(run(service, 'replace_text', { find: 'no such wording anywhere', replace: 'x' }), 'not-found');
  fails(run(service, 'replace_text', { find: 'Sample', replace: 'x', expectedVersion: 2 }), 'validation');
  fails(run(service, 'replace_text', { find: 'Sample', replace: 'x', within: 'ghost' }), 'not-found');
});

test('move_blocks and delete_blocks need versions, keep subtrees together and retire deleted IDs', () => {
  const service = seeded();
  const moved = ok(run(service, 'move_blocks', { blocks: [{ blockId: 'macro-trend', expectedVersion: 1 }, { blockId: 'macro-heading', expectedVersion: 1 }], parentId: 'portfolio', afterId: 'portfolio-heading' }));
  assert.deepEqual([...moved.moved].sort(), ['macro-heading', 'macro-trend']);
  assert.deepEqual(service.read().blocks.filter(block => block.parentId === 'portfolio').slice(0, 3).map(block => block.id), ['portfolio-heading', 'macro-trend', 'macro-heading']);
  fails(run(service, 'move_blocks', { blocks: [{ blockId: 'portfolio', expectedVersion: 1 }], parentId: 'portfolio-heading' }), 'validation');
  fails(run(service, 'move_blocks', { blocks: [{ blockId: 'macro-trend', expectedVersion: 1 }], parentId: null }), 'conflict');
  fails(run(service, 'move_blocks', { blocks: [{ blockId: 'macro-trend', expectedVersion: 2 }] }), 'validation');

  const before = service.read().blocks.length;
  const removed = ok(run(service, 'delete_blocks', { blocks: [{ blockId: 'portfolio', expectedVersion: versionOf(service, 'portfolio') }] }));
  assert.ok(removed.removed.includes('portfolio') && removed.removed.includes('allocation') && removed.removed.includes('macro-trend'));
  assert.equal(service.read().blocks.length, before - removed.removed.length);
  assert.ok(service.read().retiredBlockIds.includes('allocation'));
  fails(run(service, 'delete_blocks', { blocks: [{ blockId: 'portfolio', expectedVersion: 2 }] }), 'not-found');
  const reuse = fails(run(service, 'insert_blocks', { blocks: [paragraph('allocation', 'reused')] }), 'duplicate');
  assert.match(reuse.hint!, /reserved/);
  assert.equal(service.undo(actor, service.read().revision).ok, true, 'a delete is undoable in the same session');
});

test('add_chart validates specs with usable paths, picks fresh IDs and honours placement', () => {
  const service = fresh();
  ok(run(service, 'insert_blocks', { blocks: [{ id: 'sec', content: { type: 'section', title: 'S' } }] }));
  const spec = { kind: 'line', title: 'Rebased', labels: ['a', 'b', 'c'], series: [{ name: 'X', values: [100, 101, 103] }], yAxis: { format: 'number' }, source: 'Sample' };
  const added = ok(run(service, 'add_chart', { spec, parentId: 'sec' }));
  assert.equal(added.blockId, 'chart-1');
  assert.equal(ok(run(service, 'add_chart', { spec, id: 'my-chart', afterId: null, parentId: 'sec' })).blockId, 'my-chart');
  assert.equal(ok(run(service, 'add_chart', { spec })).blockId, 'chart-2');
  assert.deepEqual(service.read().blocks.map(block => block.id), ['sec', 'my-chart', 'chart-1', 'chart-2']);
  const candles = ok(run(service, 'add_chart', { spec: { kind: 'candlestick', title: 'OHLC', labels: ['d1', 'd2'], series: [{ name: 'Close', values: [10, 12] }], ohlc: [{ t: 'd1', o: 9, h: 11, l: 8, c: 10 }, { t: 'd2', o: 10, h: 13, l: 10, c: 12 }] } }));
  assert.equal(candles.blockId, 'chart-3');

  const mismatch = fails(run(service, 'add_chart', { spec: { ...spec, series: [{ name: 'X', values: [1, 2] }] } }), 'validation');
  assert.equal(mismatch.path, 'input.spec.series[0].values');
  assert.match(mismatch.hint!, /exactly 3 values/);
  const noPoints = fails(run(service, 'add_chart', { spec: { kind: 'scatter', title: 'S', labels: ['a'], series: [{ name: 's', values: [1] }] } }), 'validation');
  assert.equal(noPoints.path, 'input.spec.points');
  const wrongField = fails(run(service, 'add_chart', { spec: { ...spec, colour: 'red' } }), 'validation');
  assert.equal(wrongField.path, 'input.spec.colour');
  assert.match(wrongField.hint!, /Allowed properties/);
  fails(run(service, 'add_chart', {}), 'validation');
  fails(run(service, 'add_chart', { spec, citationIds: ['missing'] }), 'validation');
});

test('add_citation creates sources, can cite a block and append a marker, and rejects misuse', () => {
  const service = fresh();
  ok(run(service, 'insert_blocks', { blocks: [paragraph('claim', 'Inflation fell.'), { id: 'rule', content: { type: 'divider' } }] }));
  const first = ok(run(service, 'add_citation', { title: 'Statistics office', url: 'https://example.com/cpi' }));
  assert.equal(first.citationId, 'src-1');
  assert.equal(service.read().citations[0]!.accessedAt, '2026-10-05T08:00:00.000Z');
  const cited = ok(run(service, 'add_citation', { title: 'Central bank', url: 'https://example.com/rates', id: 'bank', publishedAt: '2026-09-30T00:00:00Z', blockId: 'claim', expectedVersion: 1, marker: true }));
  assert.equal(cited.citationId, 'bank');
  const claim = service.read().blocks.find(block => block.id === 'claim')!;
  assert.deepEqual(claim.citationIds, ['bank']);
  assert.deepEqual((claim.content as { runs: unknown[] }).runs.at(-1), { text: '', citationId: 'bank' });
  assert.equal(ok(run(service, 'add_citation', { title: 'Third', url: 'https://example.com/3' })).citationId, 'src-2');
  ok(run(service, 'add_citation', { title: 'Plain', url: 'https://example.com/p', blockId: 'claim', expectedVersion: 2 }));
  assert.deepEqual(service.read().blocks.find(block => block.id === 'claim')!.citationIds, ['bank', 'src-3']);
  fails(run(service, 'add_citation', { title: 'x', url: 'https://example.com/x', id: 'bank' }), 'duplicate');
  fails(run(service, 'add_citation', { title: 'x', url: 'javascript:alert(1)' }), 'validation');
  fails(run(service, 'add_citation', { title: 'x', url: 'https://example.com/x', blockId: 'claim' }), 'validation');
  const marker = fails(run(service, 'add_citation', { title: 'x', url: 'https://example.com/x', blockId: 'rule', expectedVersion: 1, marker: true }), 'validation');
  assert.equal(marker.path, 'input.marker');
  fails(run(service, 'add_citation', { title: 'x', url: 'https://example.com/x', blockId: 'ghost', expectedVersion: 1 }), 'not-found');
  assert.equal(service.read().citations.length, 4, 'failed calls add no citation');
});

test('templates, titles and markdown import work through the same guarded path', () => {
  const service = fresh();
  const listed = ok(run(service, 'list_templates'));
  assert.equal(listed.templates.length, 7);
  const inserted = ok(run(service, 'insert_template', { kind: 'equity', subject: 'ACME', setTitle: true }));
  assert.equal(inserted.idPrefix, 'equity');
  assert.equal(service.read().title, 'ACME: equity analysis');
  assert.ok(inserted.rootIds.includes('equity-summary'));
  const second = ok(run(service, 'insert_template', { kind: 'equity' }));
  assert.equal(second.idPrefix, 'equity2');
  ok(run(service, 'insert_template', { kind: 'blank', idPrefix: 'notes', afterId: null }));
  assert.equal(service.read().blocks[0]!.id, 'notes-intro');
  fails(run(service, 'insert_template', { kind: 'equity', idPrefix: 'equity' }), 'duplicate');
  fails(run(service, 'insert_template', { kind: 'crypto' }), 'validation');
  ok(run(service, 'set_title', { title: 'Renamed' }));
  assert.equal(service.read().title, 'Renamed');
  fails(run(service, 'set_title', { title: '' }), 'validation');

  const replaced = ok(run(service, 'import_markdown', { markdown: '# Imported title\n\nFirst paragraph.\n\nSecond paragraph.', mode: 'replace', setTitle: true }));
  assert.equal(replaced.mode, 'replace');
  assert.ok(replaced.removed.length > 20);
  assert.equal(service.read().title, 'Imported title');
  assert.equal(service.read().blocks.every(block => replaced.added.includes(block.id)), true);
  const appended = ok(run(service, 'import_markdown', { markdown: 'Appended.' }));
  assert.equal(appended.mode, 'append');
  assert.equal(service.read().blocks.at(-1)!.id, appended.added[0]);
  fails(run(service, 'import_markdown', { markdown: 'x', mode: 'replace', afterId: null }), 'validation');
  fails(run(service, 'import_markdown', { markdown: '   \n\n  ' }), 'validation');
  fails(run(service, 'import_markdown', { markdown: 'x'.repeat(TRANSPORT_LIMITS.markdownChars + 1) }), 'validation');
});

test('dryRun previews any write without saving, and transactionId makes an identical retry safe', () => {
  const service = fresh();
  ok(run(service, 'insert_blocks', { blocks: [paragraph('keep', 'Keep me')] }));
  const before = service.read();
  const preview = ok(run(service, 'delete_blocks', { blocks: [{ blockId: 'keep', expectedVersion: 1 }], dryRun: true }));
  assert.equal(preview.dryRun, true);
  assert.equal(preview.revision, 1);
  assert.equal(preview.revisionAfter, 2);
  assert.deepEqual(preview.removed, ['keep']);
  assert.deepEqual(service.read(), before);
  const refused = fails(run(service, 'delete_blocks', { blocks: [{ blockId: 'keep', expectedVersion: 5 }], dryRun: true }), 'conflict');
  assert.match(refused.hint!, /version 1/);
  assert.deepEqual(service.read(), before);

  const first = ok(run(service, 'set_title', { title: 'Once', transactionId: 'retry-1', expectedRevision: 1 }));
  assert.equal(first.revision, 2);
  const retry = ok(run(service, 'set_title', { title: 'Once', transactionId: 'retry-1', expectedRevision: 1 }));
  assert.equal(retry.duplicate, true);
  assert.equal(service.read().revision, 2);
  fails(run(service, 'set_title', { title: 'Different', transactionId: 'retry-1', expectedRevision: 1 }), 'duplicate');
  fails(run(service, 'set_title', { title: 'x', expectedRevision: 0 }), 'conflict');
  fails(run(service, 'set_title', { title: 'x', expectedRevision: 99 }), 'conflict');
});

test('exports, stats, revisions and transaction validation are read-only', () => {
  const service = seeded();
  const before = service.read();
  const markdown = ok(run(service, 'export_markdown'));
  assert.equal(markdown.format, 'markdown');
  assert.equal(markdown.characters, markdown.text.length);
  assert.match(markdown.text, /Macro outlook/);
  const part = ok(run(service, 'export_markdown', { blockId: 'portfolio' }));
  assert.match(part.text, /Exposure and concentration/);
  assert.doesNotMatch(part.text, /A measured view of growth/);
  const html = ok(run(service, 'export_html'));
  assert.equal(html.format, 'html');
  assert.doesNotMatch(html.text, /<script/i);
  assert.equal(ok(run(service, 'export_text')).format, 'text');
  fails(run(service, 'export_markdown', { blockId: 'ghost' }), 'not-found');
  const stats = ok(run(service, 'document_stats'));
  assert.equal(stats.charts, 3);
  assert.equal(stats.citations, 1);
  assert.ok(stats.words > 20);
  assert.equal(stats.blocks, before.blocks.length);

  ok(run(service, 'set_title', { title: 'Second revision' }));
  const revisions = ok(run(service, 'list_revisions'));
  assert.equal(revisions.total, 1);
  assert.equal(revisions.revisions[0].number, 2);
  assert.equal(revisions.revisions[0].actor.id, 'action-agent');
  assert.equal(typeof revisions.revisions[0].summary, 'string');
  const bare: ReportService = { read: service.read, apply: service.apply, undo: service.undo, redo: service.redo };
  assert.equal(ok(run(bare, 'list_revisions')).total, 0, 'a host without history lists none');

  const tx = { id: 'check-1', actor, baseRevision: service.read().revision, operations: [{ type: 'setTitle', title: 'Validated' }] };
  const valid = ok(run(service, 'validate_transaction', { transaction: tx }));
  assert.equal(valid.valid, true);
  assert.equal(service.read().title, 'Second revision');
  fails(run(service, 'validate_transaction', { transaction: { ...tx, baseRevision: 0 } }), 'conflict');
  fails(run(service, 'validate_transaction', { transaction: { ...tx, operations: [] } }), 'validation');
});

test('every action rejects hostile, oversized or unknown input without running code or changing state', () => {
  const service = seeded();
  const before = service.read();
  let calls = 0;
  const trap = { get blockId() { calls++; return 'macro'; } };
  fails(run(service, 'get_block', trap), 'validation');
  fails(run(service, 'get_block', Proxy.revocable({}, {}).proxy), 'validation');
  fails(run(service, 'get_block', 'macro'), 'validation');
  fails(run(service, 'get_block', [1]), 'validation');
  fails(run(service, 'get_block', { blockId: 'macro', extra: true }), 'validation');
  fails(run(service, 'get_block', { blockId: 'has space' }), 'validation');
  fails(run(service, 'get_block', { blockId: 7 }), 'validation');
  fails(run(service, 'find_blocks', { type: 'banner' }), 'validation');
  fails(run(service, 'find_blocks', { limit: 0 }), 'validation');
  fails(run(service, 'find_blocks', { limit: TRANSPORT_LIMITS.findMax + 1 }), 'validation');
  fails(run(service, 'find_blocks', { text: 'x'.repeat(2000) }), 'validation');
  fails(run(service, 'move_blocks', { blocks: [], parentId: null }), 'validation');
  fails(run(service, 'delete_blocks', { blocks: Array.from({ length: 501 }, (_v, index) => ({ blockId: `b${index}`, expectedVersion: 1 })) }), 'validation');
  fails(run(service, 'insert_blocks', { blocks: [paragraph('a', 'a')], dryRun: 'yes' }), 'validation');
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  fails(run(service, 'update_block', { blockId: 'macro-summary', expectedVersion: 1, content: cyclic }), 'validation');
  const unknown = fails(run(service, 'drop_database', {}), 'not-found');
  assert.match(unknown.hint!, /get_outline/);
  assert.equal(calls, 0, 'getters never run');
  assert.deepEqual(service.read(), before);
  assert.equal(run(service, 'get_outline', undefined).ok, true, 'omitted input means no arguments');
});
