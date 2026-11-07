import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { BLOCK_TYPES, CALLOUT_TONES, CHART_KINDS, HIGHLIGHTS, LIST_STYLES, TABLE_ALIGNMENTS, parseDocument, stats, toHTML, toMarkdown, validateDocument } from '../packages/core/src/index.js';
import { createAllBlocksExample, createAllBlocksService } from '../examples/all-blocks.js';
import { buildChartReport } from '../examples/headless-charts.js';
import { runCliWalkthrough } from '../examples/cli-walkthrough.js';
import { runHttpAgentExample } from '../examples/http-agent.js';
import { runMcpExample } from '../examples/mcp-client.js';

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'super-editor-example-'));
  return { directory, cleanup: async () => { const absolute = resolve(directory); assert.equal(dirname(absolute), resolve(tmpdir())); assert.ok(basename(absolute).startsWith('super-editor-example-')); await rm(absolute, { recursive: true, force: true }); } };
}

test('the all-blocks fixture is valid, complete and identical to what the generator produces', async () => {
  const generated = createAllBlocksExample().getSnapshot();
  assert.equal(validateDocument(generated).ok, true);
  const stored = parseDocument(await readFile(new URL('../examples/fixtures/all-blocks.v1.json', import.meta.url), 'utf8'));
  assert.ok(stored.ok);
  assert.deepEqual(stored.value, generated, 'run `node scripts/export-fixtures.mjs` after `npm run build` to refresh the fixture');
  assert.deepEqual(createAllBlocksService().read(), generated);

  const types = new Set(generated.blocks.map(block => block.content.type));
  assert.deepEqual(BLOCK_TYPES.filter(type => !types.has(type)), [], 'every block type appears');
  const kinds = new Set(generated.blocks.flatMap(block => block.content.type === 'chart' ? [block.content.spec.kind] : []));
  assert.deepEqual(CHART_KINDS.filter(kind => !kinds.has(kind)), [], 'every chart kind appears');
  const charts = generated.blocks.flatMap(block => block.content.type === 'chart' ? [block.content.spec] : []);
  assert.ok(charts.some(spec => spec.stacked) && charts.some(spec => spec.horizontal) && charts.some(spec => spec.annotations?.length) && charts.some(spec => spec.yAxis?.format === 'currency'));
  assert.deepEqual(CALLOUT_TONES.filter(tone => !generated.blocks.some(block => block.content.type === 'callout' && block.content.tone === tone)), []);
  const runs = generated.blocks.flatMap(block => 'runs' in block.content ? block.content.runs : []);
  for (const mark of ['bold', 'italic', 'code', 'strike', 'underline', 'href', 'citationId'] as const) assert.ok(runs.some(run => run[mark] !== undefined), mark);
  assert.deepEqual(HIGHLIGHTS.filter(color => !runs.some(run => run.highlight === color)), []);
  const lists = generated.blocks.flatMap(block => block.content.type === 'list' ? [block.content] : []);
  assert.deepEqual(LIST_STYLES.filter(style => !lists.some(list => (list.style ?? 'bullet') === style)), []);
  assert.ok(lists.some(list => list.indent?.some(level => level > 0)) && lists.some(list => list.checked?.includes(true)));
  const table = generated.blocks.find(block => block.content.type === 'table')!.content as { align?: string[]; caption?: string; headerColumn?: boolean };
  assert.ok(table.align && TABLE_ALIGNMENTS.every(alignment => alignment === 'center' || table.align!.includes(alignment)) && table.caption && table.headerColumn);
  assert.ok(generated.blocks.some(block => block.parentId !== null && generated.blocks.find(entry => entry.id === block.parentId)?.content.type === 'toggle'), 'a toggle holds children');
});

test('the all-blocks document exports to Markdown and HTML without losing a chart or leaking markup', () => {
  const document = createAllBlocksExample().getSnapshot();
  const markdown = toMarkdown(document);
  const html = toHTML(document, { standalone: true });
  for (const block of document.blocks) if (block.content.type === 'chart') {
    assert.ok(markdown.includes(block.content.spec.title), `markdown: ${block.content.spec.title}`);
    assert.ok(html.includes(block.content.spec.title), `html: ${block.content.spec.title}`);
  }
  assert.doesNotMatch(html, /<script|\son\w+=|javascript:/i);
  const summary = stats(document);
  assert.equal(summary.charts, CHART_KINDS.length + 2, 'one chart per kind plus the stacked and horizontal bar variants');
  assert.equal(summary.citations, 2);
  assert.ok(summary.words > 150);
});

test('the headless chart example builds a valid report with the chart builders', () => {
  const document = buildChartReport().getSnapshot();
  assert.equal(validateDocument(document).ok, true);
  assert.deepEqual(document.blocks.filter(block => block.content.type === 'chart').map(block => block.id), ['rebased', 'candles', 'corr']);
  assert.match(toMarkdown(document), /Source: Example price feed/);
});

test('the HTTP example shows a typed edit, a refused stale edit with a hint, and a chart', async () => {
  const lines: string[] = [];
  const result = await runHttpAgentExample(line => { lines.push(line); });
  assert.equal(result.inserted.ok, true);
  assert.equal(result.edited.ok, true);
  assert.equal(result.conflict?.code, 'conflict');
  assert.match(result.conflict?.hint ?? '', /now at version 2/);
  assert.ok(result.chart.ok);
  assert.match(result.markdown, /ACME grew revenue \*\*12%\*\*/);
  assert.match(result.markdown, /Revenue by quarter/);
  assert.equal(lines.length, 5);
});

test('the CLI walkthrough runs every documented step with the documented exit codes', async () => {
  const { directory, cleanup } = await scratch();
  try {
    const steps = await runCliWalkthrough(directory);
    assert.deepEqual(steps.map(step => step.code), [0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]);
    assert.match(steps[4]!.output, /\[conflict\]/);
    assert.match(steps[4]!.output, /hint:/);
    assert.match(await readFile(join(directory, 'report.md'), 'utf8'), /margins improved/);
  } finally { await cleanup(); }
});

test('the MCP client example drives the real stdio server through a whole editing session', async () => {
  const { directory, cleanup } = await scratch();
  try {
    const lines: string[] = [];
    const result = await runMcpExample(join(directory, 'report.json'), line => { lines.push(line); });
    assert.match(lines[0]!, /connected to super-editor \d+\.\d+\.\d+/);
    assert.match(lines[1]!, /\d+ tools, \d+ read-only/);
    assert.equal(result.stale.ok, false);
    assert.equal(result.stale.issues[0].code, 'conflict');
    assert.equal(result.chart.ok, true);
    assert.match(result.markdown, /Growth is \*\*moderating\*\*/);
    assert.match(result.markdown, /\[\^src-1\]/);
    const saved = parseDocument(await readFile(join(directory, 'report.json'), 'utf8'));
    assert.ok(saved.ok);
    assert.equal(saved.value.citations.length, 1);
    assert.ok(saved.value.revision >= 4);
  } finally { await cleanup(); }
});
