import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_TYPES, CHART_KINDS, LIMITS, OPERATION_TYPES, createDocument, createEditor, documentSchema, parseDocument, serializeDocument, transactionSchema, validateDocument, validateTransaction } from '../packages/core/src/index.js';
import type { Actor, ApplyResult, BlockContent, BlockInput, ChartSpec, Editor, EditorIssue, Operation, ResearchDocument, Transaction } from '../packages/core/src/index.js';

const at = '2026-10-05T12:00:00.000Z';
const human: Actor = { id: 'analyst', kind: 'human' };
const agent: Actor = { id: 'research-agent', kind: 'agent' };
const para = (text = 'Research'): BlockContent => ({ type: 'paragraph', runs: [{ text }] });
const input = (id: string, parentId: string | null = null, content: BlockContent = para(), citationIds: string[] = []): BlockInput => ({ id, parentId, content, citationIds });
const citation = (id = 'src') => ({ id, title: `Source ${id}`, url: 'https://example.org/data', accessedAt: at });
let sequence = 0;
function editor(): Editor { return createEditor(createDocument({ id: 'report', title: 'Report' }, { now: () => at }), { now: () => at }); }
function tx(current: Editor, operations: Operation[], overrides: Partial<Transaction> = {}): Transaction {
  return { id: `v02-${++sequence}`, actor: human, baseRevision: current.getSnapshot().revision, operations, ...overrides };
}
function ok(result: ApplyResult): Extract<ApplyResult, { ok: true }> { assert.equal(result.ok, true, JSON.stringify(result)); return result as Extract<ApplyResult, { ok: true }>; }
function bad(result: ApplyResult, code?: string): Extract<ApplyResult, { ok: false }> {
  assert.equal(result.ok, false, 'expected a rejection'); const failed = result as Extract<ApplyResult, { ok: false }>;
  if (code) assert.equal(failed.issues[0]?.code, code, JSON.stringify(failed.issues)); return failed;
}
function run(current: Editor, ...operations: Operation[]): Extract<ApplyResult, { ok: true }> { return ok(current.apply(tx(current, operations))); }
function insert(current: Editor, ...blocks: BlockInput[]): void { run(current, ...blocks.map((block): Operation => ({ type: 'insertBlock', block }))); }
const ids = (document: ResearchDocument, parentId?: string | null): string[] => document.blocks.filter(block => parentId === undefined || block.parentId === parentId).map(block => block.id);
const version = (current: Editor, id: string): number => current.getSnapshot().blocks.find(block => block.id === id)!.version;
function rejects(content: unknown, fragment: RegExp, path?: RegExp): EditorIssue {
  const current = editor();
  const result = validateTransaction(tx(current, [{ type: 'insertBlock', block: { id: 'x', parentId: null, citationIds: [], content } as BlockInput }]));
  assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(content)}`);
  const issue = (result as { issues: EditorIssue[] }).issues[0]!;
  assert.match(issue.message, fragment); if (path) assert.match(issue.path ?? '', path);
  return issue;
}
const line: ChartSpec = { kind: 'line', title: 'Price', labels: ['Mon', 'Tue', 'Wed'], series: [{ name: 'Close', values: [1, 2, 3], color: '#2f6fed' }] };

const everyBlock: BlockContent[] = [
  { type: 'section', title: 'Section' }, { type: 'heading', level: 1, text: 'Title' },
  { type: 'paragraph', runs: [{ text: 'All marks', bold: true, italic: true, code: true, strike: true, underline: true, highlight: 'yellow', href: 'https://example.org/', citationId: 'src' }] },
  { type: 'list', ordered: false, items: ['a', 'b', 'c'], style: 'todo', checked: [true, false, false], indent: [0, 1, 3] },
  { type: 'table', columns: ['Asset', 'Weight'], rows: [['BTC', '40%']], align: ['left', 'right'], caption: 'Allocation', headerColumn: true },
  { type: 'chart', spec: line }, { type: 'embed', provider: 'superchart', url: 'https://charts.example.org/1', title: 'Chart', height: 480 },
  { type: 'timestamp', at, label: 'As of' }, { type: 'quote', runs: [{ text: 'Quote' }], attribution: 'Someone' },
  { type: 'callout', tone: 'warning', title: 'Careful', runs: [{ text: 'Data is delayed.' }] },
  { type: 'code', language: 'ts', text: 'const a = 1;' }, { type: 'divider' },
  { type: 'image', url: 'https://example.org/a.png', alt: 'Chart image', caption: 'Figure 1', width: 'wide' },
  { type: 'toggle', title: 'Details', open: true },
  { type: 'metrics', items: [{ label: 'Return', value: '12.4%', change: 1.5, tone: 'up', hint: 'YTD' }, { label: 'Vol', value: '30%' }] },
  { type: 'toc' }, { type: 'pageBreak' },
];

test('every v0.2 block type is accepted, round-trips through JSON and is covered by BLOCK_TYPES', () => {
  assert.deepEqual([...new Set(everyBlock.map(content => content.type))].sort(), [...BLOCK_TYPES].sort());
  const current = editor();
  run(current, { type: 'addCitation', citation: citation() }, ...everyBlock.map((content, index): Operation => ({ type: 'insertBlock', block: input(`b${index}`, null, content) })));
  const snapshot = current.getSnapshot();
  assert.equal(snapshot.blocks.length, everyBlock.length);
  const reparsed = parseDocument(serializeDocument(snapshot));
  assert.equal(reparsed.ok, true); if (reparsed.ok) assert.deepEqual(reparsed.value, snapshot);
  assert.deepEqual(snapshot.blocks.map(block => block.content), everyBlock);
});

test('documents and fixtures written before v0.2 stay valid', () => {
  const legacy = { schemaVersion: 1, id: 'old', title: 'Old', revision: 1, createdAt: at, updatedAt: at, format: { page: 'screen', font: 'sans', fontSize: 16, lineHeight: 1.6 },
    blocks: [{ id: 's', parentId: null, citationIds: [], version: 1, createdAt: at, updatedAt: at, content: { type: 'section', title: 'S' } },
      { id: 'l', parentId: 's', citationIds: [], version: 1, createdAt: at, updatedAt: at, content: { type: 'list', ordered: true, items: ['a'] } },
      { id: 'c', parentId: 's', citationIds: [], version: 1, createdAt: at, updatedAt: at, content: { type: 'chart', spec: { kind: 'custom-plot', title: 'T', labels: ['A'], series: [{ name: 'S', values: [1] }] } } }],
    citations: [], retiredBlockIds: [] };
  assert.equal(validateDocument(legacy).ok, true);
});

test('inline marks: strike, underline, highlight palette and citation markers are validated', () => {
  for (const highlight of ['yellow', 'green', 'blue', 'pink', 'gray']) assert.equal(validateTransaction(tx(editor(), [{ type: 'insertBlock', block: input('h', null, { type: 'paragraph', runs: [{ text: 'x', highlight } as never] }) }])).ok, true, highlight);
  rejects({ type: 'paragraph', runs: [{ text: 'x', highlight: 'purple' }] }, /one of: yellow/, /runs\[0\]\.highlight/);
  rejects({ type: 'paragraph', runs: [{ text: 'x', strike: 'yes' }] }, /boolean/);
  rejects({ type: 'paragraph', runs: [{ text: 'x', underline: 1 }] }, /boolean/);
  const current = editor();
  const missing = bad(current.apply(tx(current, [{ type: 'insertBlock', block: input('a', null, { type: 'paragraph', runs: [{ text: '[1]', citationId: 'nope' }] }) }])), 'validation');
  assert.match(missing.issues[0]!.path ?? '', /content\.runs\[0\]\.citationId/); assert.match(missing.issues[0]!.hint ?? '', /addCitation/);
  run(current, { type: 'addCitation', citation: citation('nope') }, { type: 'insertBlock', block: input('a', null, { type: 'paragraph', runs: [{ text: '[1]', citationId: 'nope' }] }) });
  const quote = editor();
  bad(quote.apply(tx(quote, [{ type: 'insertBlock', block: input('q', null, { type: 'quote', runs: [{ text: 'q', citationId: 'nope' }] }) }])), 'validation');
});

test('list styles, todo state and indent are consistent with items', () => {
  rejects({ type: 'list', ordered: false, items: ['a'], style: 'number' }, /number.*ordered: true/);
  rejects({ type: 'list', ordered: true, items: ['a'], style: 'todo' }, /todo.*ordered: false/);
  rejects({ type: 'list', ordered: false, items: ['a'], checked: [true] }, /only valid on a "todo" list/);
  rejects({ type: 'list', ordered: false, items: ['a', 'b'], style: 'todo', checked: [true] }, /one entry per list item/);
  rejects({ type: 'list', ordered: false, items: ['a'], indent: [4] }, /between 0 and 3/, /indent\[0\]/);
  rejects({ type: 'list', ordered: false, items: ['a'], indent: [0, 1] }, /one entry per list item/);
  rejects({ type: 'list', ordered: false, items: ['a'], style: 'star' }, /one of: bullet, number, todo/);
});

test('table alignment, caption and header column are validated', () => {
  rejects({ type: 'table', columns: ['A', 'B'], rows: [], align: ['left'] }, /one entry per column/);
  rejects({ type: 'table', columns: ['A'], rows: [], align: ['justify'] }, /one of: left, center, right/);
  rejects({ type: 'table', columns: ['A'], rows: [], headerColumn: 'yes' }, /boolean/);
  rejects({ type: 'table', columns: ['A'], rows: [], caption: 'x'.repeat(LIMITS.caption + 1) }, /at most/);
});

test('new simple blocks reject unknown properties and bad values with paths and hints', () => {
  assert.match(rejects({ type: 'divider', extra: true }, /Unknown property/, /\.extra$/).hint ?? '', /Allowed properties/);
  rejects({ type: 'toc', depth: 2 }, /Unknown property/); rejects({ type: 'pageBreak', x: 1 }, /Unknown property/);
  rejects({ type: 'callout', tone: 'loud', runs: [] }, /one of: info, success, warning, danger, note/);
  rejects({ type: 'code', language: 'ts<script>', text: '' }, /Language/);
  rejects({ type: 'image', url: 'http://example.org/a.png', alt: 'x' }, /HTTPS/);
  rejects({ type: 'image', url: 'javascript:alert(1)', alt: 'x' }, /HTTPS/);
  rejects({ type: 'image', url: 'https://example.org/a.png', alt: 'x', width: 'huge' }, /one of: narrow/);
  rejects({ type: 'toggle', title: 'x' }, /Required property/, /\.open$/);
  rejects({ type: 'metrics', items: [] }, /at least one item/);
  rejects({ type: 'metrics', items: [{ label: 'a', value: 'b', tone: 'sideways' }] }, /one of: up, down, neutral/);
  rejects({ type: 'metrics', items: [{ label: 'a', value: 'b', change: Infinity }] }, /finite/);
  rejects({ type: 'embed', provider: 'superchart', url: 'https://example.org', title: 't', height: 199 }, /between 200 and 1200/);
  rejects({ type: 'embed', provider: 'superchart', url: 'https://example.org', title: 't', height: 1201 }, /between 200 and 1200/);
  rejects({ type: 'heading', level: 4, text: 'x' }, /between 1 and 3/);
  const unknown = rejects({ type: 'video' }, /Unsupported block content type/); assert.match(unknown.hint ?? '', /callout/);
  rejects({ type: 'quote', runs: [], attribution: 5 }, /string/);
});

test('chart kinds: line, area, donut, histogram, waterfall and bar flags', () => {
  const current = editor();
  const specs: ChartSpec[] = [
    line, { ...line, kind: 'area', stacked: true }, { kind: 'donut', title: 'Mix', labels: ['A', 'B'], series: [{ name: 'W', values: [60, 40] }] },
    { kind: 'bar', title: 'Bars', labels: ['A', 'B'], series: [{ name: 'X', values: [1, 2] }, { name: 'Y', values: [2, 1] }], stacked: true, horizontal: true },
    { kind: 'histogram', title: 'Returns', labels: ['-1..0', '0..1'], series: [{ name: 'Count', values: [3, 5] }] },
    { kind: 'waterfall', title: 'PnL', labels: ['Start', 'Fee', 'End'], series: [{ name: 'Delta', values: [100, -2, 98] }] },
  ];
  run(current, ...specs.map((spec, index): Operation => ({ type: 'insertBlock', block: input(`c${index}`, null, { type: 'chart', spec }) })));
  assert.equal(current.getSnapshot().blocks.length, specs.length);
  const kinds = new Set<string>(CHART_KINDS); assert.equal(kinds.size, 11);
  rejects({ type: 'chart', spec: { ...specs[2]!, series: [{ name: 'W', values: [-1, 2] }] } }, /Donut charts require one nonnegative series/);
  rejects({ type: 'chart', spec: { ...specs[4]!, series: [{ name: 'Count', values: [-1, 5] }] } }, /Histogram/);
  rejects({ type: 'chart', spec: { ...specs[5]!, series: [{ name: 'A', values: [1, 2, 3] }, { name: 'B', values: [1, 2, 3] }] } }, /Waterfall/);
  rejects({ type: 'chart', spec: { ...line, stacked: 'yes' } }, /boolean/);
  rejects({ type: 'chart', spec: { ...line, series: [{ name: 'S', values: [1, 2, 3], color: 'url(javascript:alert(1))' }] } }, /color/);
  assert.equal(validateTransaction(tx(current, [{ type: 'insertBlock', block: input('colored', null, { type: 'chart', spec: { ...line, series: [{ name: 'S', values: [1, 2, 3], color: 'var(--se-series-1)' }, { name: 'T', values: [1, 2, 3], color: 'red' }] } }) }])).ok, true);
});

test('chart axis, caption, source and annotations', () => {
  const current = editor();
  const spec: ChartSpec = { ...line, yAxis: { label: 'USD', format: 'currency', min: 0, max: 10, currency: 'USD' }, xLabel: 'Day', caption: 'Closing prices', source: 'OKX daily candles',
    annotations: [{ label: 'Peak', at: 'Wed', value: 3 }] };
  insert(current, input('c', null, { type: 'chart', spec })); assert.deepEqual((current.getSnapshot().blocks[0]!.content as { spec: ChartSpec }).spec, spec);
  rejects({ type: 'chart', spec: { ...line, yAxis: { min: 5, max: 5 } } }, /less than/);
  rejects({ type: 'chart', spec: { ...line, yAxis: { format: 'binary' } } }, /one of: number, percent, currency, compact/);
  rejects({ type: 'chart', spec: { ...line, yAxis: { currency: 'usd' } } }, /ISO 4217/);
  rejects({ type: 'chart', spec: { ...line, yAxis: { extra: 1 } } }, /Unknown property/);
  const unknownAt = rejects({ type: 'chart', spec: { ...line, annotations: [{ label: 'Peak', at: 'Friday' }] } }, /one of the chart labels/); assert.match(unknownAt.hint ?? '', /Mon, Tue, Wed/);
  rejects({ type: 'chart', spec: { ...line, annotations: Array.from({ length: LIMITS.annotations + 1 }, () => ({ label: 'x', at: 'Mon' })) } }, /at most 100/);
  rejects({ type: 'chart', spec: { ...line, source: 'x'.repeat(LIMITS.title + 1) } }, /at most/);
});

test('scatter, candlestick and heatmap carry typed data next to a fallback table', () => {
  const current = editor();
  const scatter: ChartSpec = { kind: 'scatter', title: 'Risk/return', labels: ['A', 'B'], series: [{ name: 'y', values: [2, 3] }], points: [{ series: 'Funds', x: 1, y: 2 }, { series: 'Funds', x: 2, y: 3 }] };
  const candles: ChartSpec = { kind: 'candlestick', title: 'BTC', labels: ['d1', 'd2'], series: [{ name: 'Close', values: [11, 12] }], ohlc: [{ t: 'd1', o: 10, h: 12, l: 9, c: 11, v: 100 }, { t: 'd2', o: 11, h: 13, l: 10, c: 12 }] };
  const heat: ChartSpec = { kind: 'heatmap', title: 'Correlation', labels: ['A', 'B'], series: [{ name: 'A', values: [1, 0.5] }, { name: 'B', values: [0.5, 1] }], matrix: { rows: ['A', 'B'], columns: ['A', 'B'], values: [[1, 0.5], [0.5, 1]] } };
  insert(current, input('s', null, { type: 'chart', spec: scatter }), input('c', null, { type: 'chart', spec: candles }), input('h', null, { type: 'chart', spec: heat }));
  rejects({ type: 'chart', spec: { kind: 'scatter', title: 'T', labels: ['A'], series: [{ name: 'y', values: [1] }] } }, /Scatter charts require points/);
  rejects({ type: 'chart', spec: { ...scatter, points: [{ series: 'S', x: NaN, y: 1 }] } }, /finite/);
  rejects({ type: 'chart', spec: { ...line, points: [{ series: 'S', x: 1, y: 1 }] } }, /only valid for scatter/);
  rejects({ type: 'chart', spec: { kind: 'candlestick', title: 'T', labels: ['A'], series: [{ name: 'c', values: [1] }] } }, /require ohlc/);
  rejects({ type: 'chart', spec: { ...candles, ohlc: [{ t: 'd1', o: 10, h: 9, l: 8, c: 9 }] } }, /low <= open\/close <= high/);
  rejects({ type: 'chart', spec: { ...candles, ohlc: [{ t: 'd1', o: 10, h: 12, l: 9, c: 11, v: -1 }] } }, /finite/);
  rejects({ type: 'chart', spec: { ...candles, ohlc: Array.from({ length: LIMITS.ohlc + 1 }, () => ({ t: 'x', o: 1, h: 1, l: 1, c: 1 })) } }, /at most 5000/);
  rejects({ type: 'chart', spec: { ...heat, matrix: { rows: ['A', 'B'], columns: ['A'], values: [[1], [2], [3]] } } }, /at most 2 entries|one row per rows/);
  rejects({ type: 'chart', spec: { ...heat, matrix: { rows: ['A', 'B'], columns: ['A', 'B'], values: [[1, 2], [3]] } } }, /one row per rows entry and one cell per column/);
  rejects({ type: 'chart', spec: { kind: 'heatmap', title: 'T', labels: ['A'], series: [{ name: 'A', values: [1] }] } }, /require a matrix/);
  // Unknown kinds may carry any of the data payloads.
  insert(current, input('x', null, { type: 'chart', spec: { ...scatter, kind: 'custom-plot' } }));
});

test('JSON schemas enumerate every block type and operation and stay in sync with the runtime', () => {
  const content = (documentSchema.$defs as Record<string, { anyOf: { properties: { type: { const: string } } }[] }>).content!;
  assert.deepEqual(content.anyOf.map(entry => entry.properties.type.const).sort(), [...BLOCK_TYPES].sort());
  const operation = (transactionSchema.$defs as Record<string, { anyOf: { properties: { type: { const: string } } }[] }>).operation!;
  assert.deepEqual(operation.anyOf.map(entry => entry.properties.type.const).sort(), [...OPERATION_TYPES].sort());
  const defs = transactionSchema.$defs as Record<string, unknown>;
  assert.ok(defs.blockRefs); assert.ok(defs.chart);
  const chartProps = (defs.chart as { properties: Record<string, unknown> }).properties;
  for (const key of ['stacked', 'horizontal', 'yAxis', 'xLabel', 'caption', 'source', 'annotations', 'points', 'ohlc', 'matrix']) assert.ok(chartProps[key], key);
  assert.equal(Object.isFrozen(LIMITS), true); assert.equal(LIMITS.embedHeightMax, 1_200); assert.equal(LIMITS.listIndent, 3);
});

test('sections and toggles are containers; other blocks cannot parent children', () => {
  const current = editor();
  insert(current, input('t', null, { type: 'toggle', title: 'Details', open: false }), input('a', 't'), input('s', null, { type: 'section', title: 'S' }), input('b', 's'));
  assert.deepEqual(ids(current.getSnapshot(), 't'), ['a']);
  const failed = bad(current.apply(tx(current, [{ type: 'insertBlock', block: input('c', 'a') }])), 'validation');
  assert.match(failed.issues[0]!.message, /section or toggle/); assert.match(failed.issues[0]!.hint ?? '', /only section and toggle/);
  bad(current.apply(tx(current, [{ type: 'insertBlock', block: input('d', 'missing') }])), 'validation');
  run(current, { type: 'moveBlock', blockId: 'b', expectedVersion: 1, parentId: 't' });
  assert.deepEqual(ids(current.getSnapshot(), 't'), ['a', 'b']);
  const doc = JSON.parse(serializeDocument(current.getSnapshot())) as ResearchDocument;
  doc.blocks.find(block => block.id === 't')!.content = para(); assert.equal(validateDocument(doc).ok, false);
  run(current, { type: 'deleteBlock', blockId: 't', expectedVersion: 1 });
  assert.deepEqual(ids(current.getSnapshot()), ['s']);
  assert.deepEqual(new Set(current.getSnapshot().retiredBlockIds), new Set(['t', 'a', 'b']));
});

test('flat order stays a pre-order walk when blocks are inserted, appended and moved', () => {
  const current = editor();
  insert(current, input('s', null, { type: 'section', title: 'S' }), input('t', null, { type: 'toggle', title: 'T', open: true }), input('a', 's'), input('b', 't'), input('c', 's'));
  assert.deepEqual(ids(current.getSnapshot()), ['s', 'a', 'c', 't', 'b']);
  run(current, { type: 'insertBlock', block: input('n', null), afterId: 's' });
  assert.deepEqual(ids(current.getSnapshot()), ['s', 'a', 'c', 'n', 't', 'b']);
  run(current, { type: 'moveBlock', blockId: 's', expectedVersion: 1, parentId: null, afterId: 't' });
  assert.deepEqual(ids(current.getSnapshot()), ['n', 't', 'b', 's', 'a', 'c']);
});

test('insertBlocks is ordered, honours afterId and is all-or-nothing', () => {
  const current = editor(); insert(current, input('first'), input('last'));
  run(current, { type: 'insertBlocks', afterId: 'first', blocks: [input('s', null, { type: 'section', title: 'S' }), input('s1', 's'), input('s2', 's'), input('after-s'), input('after-s2')] });
  assert.deepEqual(ids(current.getSnapshot()), ['first', 's', 's1', 's2', 'after-s', 'after-s2', 'last']);
  assert.deepEqual(ids(current.getSnapshot(), 's'), ['s1', 's2']);
  run(current, { type: 'insertBlocks', afterId: null, blocks: [input('p1'), input('p2')] }); assert.deepEqual(ids(current.getSnapshot(), null).slice(0, 2), ['p1', 'p2']);
  run(current, { type: 'insertBlocks', blocks: [input('e1'), input('e2')] }); assert.deepEqual(ids(current.getSnapshot(), null).slice(-2), ['e1', 'e2']);
  const before = current.getSnapshot(); let events = 0; current.subscribe(() => { events++; });
  bad(current.apply(tx(current, [{ type: 'insertBlocks', blocks: [input('ok1'), input('first')] }])), 'duplicate');
  bad(current.apply(tx(current, [{ type: 'insertBlocks', blocks: [input('ok2'), input('orphan', 'missing')] }])), 'validation');
  bad(current.apply(tx(current, [{ type: 'insertBlocks', afterId: 'missing', blocks: [input('ok3')] }])), 'validation');
  assert.equal(current.getSnapshot(), before); assert.equal(events, 0); assert.equal(current.getSnapshot().blocks.some(block => block.id === 'ok1'), false);
  assert.equal(validateTransaction(tx(current, [{ type: 'insertBlocks', blocks: [] }])).ok, false);
  assert.equal(validateTransaction(tx(current, [{ type: 'insertBlocks', blocks: [input('dup'), input('dup')] }])).ok, false);
  assert.equal(validateTransaction(tx(current, [{ type: 'insertBlocks', blocks: Array.from({ length: LIMITS.blocksPerOperation + 1 }, (_, i) => input(`many-${i}`)) }])).ok, false);
  const undo = ok(current.undo(human, current.getSnapshot().revision)); assert.equal(undo.document.blocks.some(block => block.id === 'e1'), false);
});

test('duplicateBlock deep-copies a subtree with caller-assigned IDs', () => {
  const current = editor();
  run(current, { type: 'addCitation', citation: citation() });
  insert(current, input('s', null, { type: 'section', title: 'S' }), input('n', 's', { type: 'toggle', title: 'N', open: true }), input('leaf', 'n', para('leaf'), ['src']), input('s-end', 's'), input('after'));
  const stale = bad(current.apply(tx(current, [{ type: 'duplicateBlock', blockId: 's', expectedVersion: 9, newIds: { s: 'a', n: 'b', leaf: 'c', 's-end': 'd' } }])), 'conflict');
  assert.match(stale.issues[0]!.hint ?? '', /version 1/);
  const partial = bad(current.apply(tx(current, [{ type: 'duplicateBlock', blockId: 's', expectedVersion: 1, newIds: { s: 'a', n: 'b' } }])), 'validation');
  assert.match(partial.issues[0]!.hint ?? '', /Missing: leaf, s-end/);
  const extra = bad(current.apply(tx(current, [{ type: 'duplicateBlock', blockId: 's', expectedVersion: 1, newIds: { s: 'a', n: 'b', leaf: 'c', 's-end': 'd', after: 'e' } }])), 'validation');
  assert.match(extra.issues[0]!.hint ?? '', /Not part of this subtree: after/);
  bad(current.apply(tx(current, [{ type: 'duplicateBlock', blockId: 's', expectedVersion: 1, newIds: { s: 'after', n: 'b', leaf: 'c', 's-end': 'd' } }])), 'duplicate');
  assert.equal(validateTransaction(tx(current, [{ type: 'duplicateBlock', blockId: 's', expectedVersion: 1, newIds: { n: 'x' } }])).ok, false);
  assert.equal(validateTransaction(tx(current, [{ type: 'duplicateBlock', blockId: 's', expectedVersion: 1, newIds: { s: 'x', n: 'x' } }])).ok, false);
  run(current, { type: 'duplicateBlock', blockId: 's', expectedVersion: 1, newIds: { s: 's-copy', n: 'n-copy', leaf: 'leaf-copy', 's-end': 'end-copy' } });
  const doc = current.getSnapshot();
  assert.deepEqual(ids(doc), ['s', 'n', 'leaf', 's-end', 's-copy', 'n-copy', 'leaf-copy', 'end-copy', 'after']);
  assert.deepEqual(ids(doc, 's-copy'), ['n-copy', 'end-copy']); assert.deepEqual(ids(doc, 'n-copy'), ['leaf-copy']);
  const leaf = doc.blocks.find(block => block.id === 'leaf-copy')!; assert.equal(leaf.version, 1); assert.deepEqual(leaf.citationIds, ['src']); assert.deepEqual(leaf.content, para('leaf'));
  assert.equal(doc.blocks.find(block => block.id === 's')!.version, 1);
  // Copies are independent of the original.
  run(current, { type: 'updateBlock', blockId: 'leaf-copy', expectedVersion: 1, content: para('changed') });
  assert.deepEqual(current.getSnapshot().blocks.find(block => block.id === 'leaf')!.content, para('leaf'));
  run(current, { type: 'duplicateBlock', blockId: 'after', expectedVersion: 1, newIds: { after: 'after-2' }, afterId: null });
  assert.deepEqual(ids(current.getSnapshot(), null), ['after-2', 's', 's-copy', 'after']);
  assert.equal(ok(current.undo(human, current.getSnapshot().revision)).document.blocks.some(block => block.id === 'after-2'), false);
});

test('replaceText edits text across runs, lists and tables with explicit failure when nothing matches', () => {
  const current = editor();
  insert(current,
    input('p', null, { type: 'paragraph', runs: [{ text: 'Revenue grew ' }, { text: '12%', bold: true }, { text: ' in Q3; revenue is up.' }] }),
    input('l', null, { type: 'list', ordered: false, items: ['Revenue one', 'two', 'revenue three'] }),
    input('t', null, { type: 'table', columns: ['Metric'], rows: [['Revenue'], ['Cost']], caption: 'Revenue table' }),
    input('d', null, { type: 'divider' }), input('c', null, { type: 'code', language: 'ts', text: 'const revenue = 1; const Revenue = 2;' }));
  run(current, { type: 'replaceText', blockId: 'p', expectedVersion: 1, find: 'revenue', replace: 'sales' });
  assert.deepEqual((current.getSnapshot().blocks[0]!.content as { runs: unknown[] }).runs, [{ text: 'sales grew ' }, { text: '12%', bold: true }, { text: ' in Q3; revenue is up.' }]);
  assert.equal(version(current, 'p'), 2);
  run(current, { type: 'replaceText', blockId: 'p', expectedVersion: 2, find: 'revenue', replace: 'turnover', caseSensitive: true });
  run(current, { type: 'replaceText', blockId: 'p', expectedVersion: 3, find: 'grew 12%', replace: 'rose 9%' });
  assert.deepEqual((current.getSnapshot().blocks[0]!.content as { runs: unknown[] }).runs, [{ text: 'sales rose 9%' }, { text: ' in Q3; turnover is up.' }]);
  run(current, { type: 'replaceText', blockId: 'l', expectedVersion: 1, find: 'revenue', replace: 'sales', all: true });
  assert.deepEqual((current.getSnapshot().blocks[1]!.content as { items: string[] }).items, ['sales one', 'two', 'sales three']);
  run(current, { type: 'replaceText', blockId: 't', expectedVersion: 1, find: 'revenue', replace: 'Sales', all: true });
  const table = current.getSnapshot().blocks[2]!.content as { rows: string[][]; caption: string }; assert.deepEqual(table.rows, [['Sales'], ['Cost']]); assert.equal(table.caption, 'Sales table');
  run(current, { type: 'replaceText', blockId: 'c', expectedVersion: 1, find: 'revenue', replace: 'sales' });
  assert.equal((current.getSnapshot().blocks[4]!.content as { text: string }).text, 'const sales = 1; const Revenue = 2;');
  const missing = bad(current.apply(tx(current, [{ type: 'replaceText', blockId: 'p', expectedVersion: 4, find: 'nothing here', replace: 'x' }])), 'not-found'); assert.match(missing.issues[0]!.hint ?? '', /case-sensitive/);
  bad(current.apply(tx(current, [{ type: 'replaceText', blockId: 'd', expectedVersion: 1, find: 'x', replace: 'y' }])), 'validation');
  bad(current.apply(tx(current, [{ type: 'replaceText', blockId: 'p', expectedVersion: 1, find: 'x', replace: 'y' }])), 'conflict');
  assert.equal(validateTransaction(tx(current, [{ type: 'replaceText', blockId: 'p', expectedVersion: 4, find: '', replace: 'y' }])).ok, false);
  // The replacement is literal text, never a pattern.
  run(current, { type: 'replaceText', blockId: 'p', expectedVersion: 4, find: '9%', replace: '$& $1 .*' }); assert.match(JSON.stringify(current.getSnapshot().blocks[0]!.content), /\$& \$1 \.\*/);
  run(current, { type: 'replaceText', blockId: 'l', expectedVersion: 2, find: 'two', replace: '' });
  assert.deepEqual((current.getSnapshot().blocks[1]!.content as { items: string[] }).items, ['sales one', '', 'sales three']);
});

test('replaceText keeps inline citations, drops emptied runs, and is allowed in rebase-safe transactions', () => {
  const current = editor(); run(current, { type: 'addCitation', citation: citation() });
  insert(current, input('p', null, { type: 'paragraph', runs: [{ text: 'delete ' }, { text: 'me', italic: true }, { text: '[1]', citationId: 'src' }] }), input('other'));
  run(current, { type: 'replaceText', blockId: 'p', expectedVersion: 1, find: 'me', replace: '' });
  assert.deepEqual((current.getSnapshot().blocks[0]!.content as { runs: unknown[] }).runs, [{ text: 'delete ' }, { text: '[1]', citationId: 'src' }]);
  const base = current.getSnapshot().revision;
  const proposal = tx(current, [{ type: 'replaceText', blockId: 'p', expectedVersion: 2, find: 'delete', replace: 'remove' }], { actor: agent, baseRevision: base, conflictPolicy: 'rebase-safe' });
  run(current, { type: 'updateBlock', blockId: 'other', expectedVersion: 1, content: para('human') });
  const accepted = ok(current.apply(proposal)); assert.equal(accepted.revision.rebasedFrom, base);
  const stale = tx(current, [{ type: 'replaceText', blockId: 'p', expectedVersion: 3, find: 'remove', replace: 'x' }], { actor: agent, baseRevision: base, conflictPolicy: 'rebase-safe' });
  run(current, { type: 'replaceText', blockId: 'p', expectedVersion: 3, find: 'remove', replace: 'drop' });
  bad(current.apply(stale), 'conflict');
  const reject = bad(current.apply(tx(current, [{ type: 'replaceText', blockId: 'p', expectedVersion: 4, find: 'drop', replace: 'x' }], { baseRevision: base })), 'conflict'); assert.match(reject.issues[0]!.hint ?? '', /baseRevision/);
});

test('deleteBlocks removes subtrees atomically, tolerates ancestor plus descendant and retires IDs', () => {
  const current = editor();
  insert(current, input('s', null, { type: 'section', title: 'S' }), input('a', 's'), input('b', 's'), input('keep'), input('gone'));
  const before = current.getSnapshot();
  bad(current.apply(tx(current, [{ type: 'deleteBlocks', blocks: [{ blockId: 'a', expectedVersion: 1 }, { blockId: 'gone', expectedVersion: 7 }] }])), 'conflict'); assert.equal(current.getSnapshot(), before);
  bad(current.apply(tx(current, [{ type: 'deleteBlocks', blocks: [{ blockId: 'a', expectedVersion: 1 }, { blockId: 'nope', expectedVersion: 1 }] }])), 'not-found');
  assert.equal(validateTransaction(tx(current, [{ type: 'deleteBlocks', blocks: [{ blockId: 'a', expectedVersion: 1 }, { blockId: 'a', expectedVersion: 1 }] }])).ok, false);
  assert.equal(validateTransaction(tx(current, [{ type: 'deleteBlocks', blocks: [] }])).ok, false);
  run(current, { type: 'deleteBlocks', blocks: [{ blockId: 's', expectedVersion: 1 }, { blockId: 'a', expectedVersion: 1 }, { blockId: 'gone', expectedVersion: 1 }] });
  assert.deepEqual(ids(current.getSnapshot()), ['keep']); assert.deepEqual(new Set(current.getSnapshot().retiredBlockIds), new Set(['s', 'a', 'b', 'gone']));
  bad(current.apply(tx(current, [{ type: 'insertBlock', block: input('a') }])), 'duplicate');
  ok(current.undo(human, current.getSnapshot().revision)); assert.deepEqual(ids(current.getSnapshot()).sort(), ['a', 'b', 'gone', 'keep', 's']);
});

test('moveBlocks keeps the given order, moves subtrees with their blocks and refuses cycles', () => {
  const current = editor();
  insert(current, input('s', null, { type: 'section', title: 'S' }), input('t', null, { type: 'toggle', title: 'T', open: true }), input('a', 's'), input('b', 's'), input('c', 's'), input('x', 't'), input('top'));
  run(current, { type: 'moveBlocks', blocks: [{ blockId: 'c', expectedVersion: 1 }, { blockId: 'a', expectedVersion: 1 }], parentId: 't', afterId: null });
  assert.deepEqual(ids(current.getSnapshot(), 't'), ['c', 'a', 'x']); assert.deepEqual(ids(current.getSnapshot(), 's'), ['b']);
  assert.equal(version(current, 'c'), 2); assert.equal(version(current, 'b'), 1);
  run(current, { type: 'moveBlocks', blocks: [{ blockId: 's', expectedVersion: 1 }], parentId: 't', afterId: 'a' });
  assert.deepEqual(ids(current.getSnapshot(), 't'), ['c', 'a', 's', 'x']); assert.deepEqual(ids(current.getSnapshot()), ['t', 'c', 'a', 's', 'b', 'x', 'top']);
  const before = current.getSnapshot();
  const cycle = bad(current.apply(tx(current, [{ type: 'moveBlocks', blocks: [{ blockId: 't', expectedVersion: 1 }], parentId: 's' }])), 'validation'); assert.match(cycle.issues[0]!.message, /own descendant/);
  bad(current.apply(tx(current, [{ type: 'moveBlocks', blocks: [{ blockId: 'top', expectedVersion: 1 }], parentId: 'top' }])), 'validation');
  bad(current.apply(tx(current, [{ type: 'moveBlocks', blocks: [{ blockId: 'top', expectedVersion: 1 }, { blockId: 'x', expectedVersion: 1 }], parentId: null, afterId: 'x' }])), 'validation');
  bad(current.apply(tx(current, [{ type: 'moveBlocks', blocks: [{ blockId: 'top', expectedVersion: 5 }], parentId: null }])), 'conflict');
  bad(current.apply(tx(current, [{ type: 'moveBlocks', blocks: [{ blockId: 'top', expectedVersion: 1 }], parentId: 'a' }])), 'validation');
  assert.equal(current.getSnapshot(), before);
  const back = ok(current.undo(human, current.getSnapshot().revision)); assert.deepEqual(ids(back.document, 't'), ['c', 'a', 'x']);
  assert.equal(version(current, 'top'), 1);
});

test('updateCitation replaces data and removeCitation strips block and inline references', () => {
  const current = editor();
  run(current, { type: 'addCitation', citation: citation('one') }, { type: 'addCitation', citation: citation('two') });
  insert(current, input('p', null, { type: 'paragraph', runs: [{ text: 'See' }, { text: '[1]', citationId: 'one' }, { text: ' and ' }, { text: '', citationId: 'one' }, { text: '[2]', citationId: 'two' }] }, ['one', 'two']),
    input('q', null, { type: 'quote', runs: [{ text: 'quoted', citationId: 'one', italic: true }] }, ['one']), input('r', null, para('plain'), ['two']), input('untouched'));
  run(current, { type: 'updateCitation', citation: { ...citation('one'), title: 'Renamed', publishedAt: '2026-10-01T00:00:00Z' } });
  assert.equal(current.getSnapshot().citations.find(item => item.id === 'one')!.title, 'Renamed'); assert.equal(version(current, 'p'), 1);
  bad(current.apply(tx(current, [{ type: 'updateCitation', citation: citation('ghost') }])), 'not-found');
  bad(current.apply(tx(current, [{ type: 'removeCitation', citationId: 'ghost' }])), 'not-found');
  run(current, { type: 'removeCitation', citationId: 'one' });
  const doc = current.getSnapshot(); assert.equal(doc.citations.some(item => item.id === 'one'), false);
  const p = doc.blocks.find(block => block.id === 'p')!; assert.deepEqual(p.citationIds, ['two']);
  assert.deepEqual((p.content as { runs: unknown[] }).runs, [{ text: 'See' }, { text: '[1]' }, { text: ' and ' }, { text: '[2]', citationId: 'two' }]);
  assert.deepEqual(doc.blocks.find(block => block.id === 'q')!.content, { type: 'quote', runs: [{ text: 'quoted', italic: true }] });
  assert.equal(version(current, 'p'), 2); assert.equal(version(current, 'q'), 2); assert.equal(version(current, 'r'), 1); assert.equal(version(current, 'untouched'), 1);
  assert.equal(validateDocument(doc).ok, true);
  const undone = ok(current.undo(human, doc.revision)); assert.equal(undone.document.citations.some(item => item.id === 'one'), true);
  assert.deepEqual(undone.document.blocks.find(block => block.id === 'q')!.citationIds, ['one']);
  assert.equal(validateDocument(undone.document).ok, true);
  // Metadata operations always need the exact document revision.
  const stale = tx(current, [{ type: 'removeCitation', citationId: 'two' }], { actor: agent, baseRevision: current.getSnapshot().revision - 1, conflictPolicy: 'rebase-safe' });
  bad(current.apply(stale), 'conflict');
});

test('issues carry actionable hints for the most common agent mistakes', () => {
  const current = editor(); insert(current, input('a'));
  const hint = (result: ApplyResult): string => (result as Extract<ApplyResult, { ok: false }>).issues[0]?.hint ?? '';
  assert.match(hint(current.apply(tx(current, [{ type: 'updateBlock', blockId: 'a', expectedVersion: 5, content: para() }]))), /version 1/);
  assert.match(hint(current.apply(tx(current, [{ type: 'updateBlock', blockId: 'zzz', expectedVersion: 1, content: para() }]))), /Read the document/);
  assert.match(hint(current.apply(tx(current, [{ type: 'insertBlock', block: input('a') }]))), /Choose a fresh ID/);
  assert.match(hint(current.apply(tx(current, [{ type: 'insertBlock', block: input('b', 'a') }]))), /section and toggle/);
  assert.match(hint(current.apply({ ...tx(current, [{ type: 'setTitle', title: 'x' }]), baseRevision: 0 })), /baseRevision 1/);
  assert.match(hint(current.apply({ ...tx(current, [{ type: 'setTitle', title: 'x' }]), extra: 1 })), /Allowed properties/);
  assert.match(hint(current.apply({ ...tx(current, [{ type: 'setTitle', title: 'x' }]), operations: [{ type: 'explode' }] })), /insertBlocks/);
  assert.match(hint(current.apply({ id: 'x', actor: human, baseRevision: 1, operations: [{ type: 'insertBlock', block: { id: '_bad', parentId: null, citationIds: [], content: para() } }] })), /Start with a letter or digit/);
  const noHint = validateTransaction({ id: 'x', actor: human, baseRevision: 1, operations: [{ type: 'insertBlock', block: { id: 'z', parentId: null, citationIds: [], content: { type: 'embed', provider: 'superchart', url: 'http://x.org', title: 't' } } }] });
  assert.equal(noHint.ok, false); assert.match((noHint as { issues: EditorIssue[] }).issues[0]!.hint ?? '', /https:\/\//);
});

test('v0.2 operations round-trip through history with block versions that never regress', () => {
  const current = editor(); const highest = new Map<string, number>();
  const check = () => { for (const block of current.getSnapshot().blocks) { assert.ok(block.version >= (highest.get(block.id) ?? 0)); highest.set(block.id, block.version); } assert.equal(validateDocument(current.getSnapshot()).ok, true); };
  const steps: Operation[][] = [
    [{ type: 'addCitation', citation: citation() }, { type: 'insertBlocks', blocks: [input('s', null, { type: 'section', title: 'S' }), input('p', 's', { type: 'paragraph', runs: [{ text: 'a b', citationId: 'src' }] }, ['src'])] }],
    [{ type: 'duplicateBlock', blockId: 's', expectedVersion: 1, newIds: { s: 's2', p: 'p2' } }],
    [{ type: 'replaceText', blockId: 'p', expectedVersion: 1, find: 'a', replace: 'A' }],
    [{ type: 'moveBlocks', blocks: [{ blockId: 's2', expectedVersion: 1 }], parentId: null, afterId: null }],
    [{ type: 'removeCitation', citationId: 'src' }],
    [{ type: 'deleteBlocks', blocks: [{ blockId: 's', expectedVersion: 1 }] }],
  ];
  const states: unknown[] = [JSON.stringify(current.getSnapshot().blocks.map(block => [block.id, block.parentId, block.content, block.citationIds]))];
  for (const operations of steps) { run(current, ...operations); check(); states.push(JSON.stringify(current.getSnapshot().blocks.map(block => [block.id, block.parentId, block.content, block.citationIds]))); }
  for (let index = states.length - 2; index >= 0; index--) { ok(current.undo(human, current.getSnapshot().revision)); check(); assert.equal(JSON.stringify(current.getSnapshot().blocks.map(block => [block.id, block.parentId, block.content, block.citationIds])), states[index]); }
  for (let index = 1; index < states.length; index++) { ok(current.redo(human, current.getSnapshot().revision)); check(); assert.equal(JSON.stringify(current.getSnapshot().blocks.map(block => [block.id, block.parentId, block.content, block.citationIds])), states[index]); }
});

test('persisted documents reject dangling inline citations and honour toggle nesting depth', () => {
  const current = editor(); run(current, { type: 'addCitation', citation: citation() }, { type: 'insertBlock', block: input('p', null, { type: 'paragraph', runs: [{ text: 'x', citationId: 'src' }] }) });
  const doc = JSON.parse(serializeDocument(current.getSnapshot())) as ResearchDocument;
  doc.citations = []; const result = validateDocument(doc); assert.equal(result.ok, false);
  assert.match((result as { issues: EditorIssue[] }).issues[0]!.path ?? '', /document\.blocks\.p\.content\.runs\[0\]\.citationId/);
  const nested = editor();
  insert(nested, ...Array.from({ length: LIMITS.depth }, (_, index) => input(`d-${index}`, index ? `d-${index - 1}` : null, index % 2 ? { type: 'toggle', title: 'T', open: true } : { type: 'section', title: 'S' })));
  assert.equal(nested.getSnapshot().blocks.length, LIMITS.depth);
  bad(nested.apply(tx(nested, [{ type: 'insertBlock', block: input('too-deep', `d-${LIMITS.depth - 1}`) }])), 'validation');
});

test('heading level 1 is accepted for headings and round-trips through updateBlock and undo', () => {
  const current = editor(); insert(current, input('h', null, { type: 'heading', level: 2, text: 'Hello' }));
  run(current, { type: 'updateBlock', blockId: 'h', expectedVersion: 1, content: { type: 'heading', level: 1, text: 'Hello' } });
  assert.deepEqual(current.getSnapshot().blocks[0]!.content, { type: 'heading', level: 1, text: 'Hello' });
  ok(current.undo(human, current.getSnapshot().revision)); assert.equal((current.getSnapshot().blocks[0]!.content as { level: number }).level, 2);
});
