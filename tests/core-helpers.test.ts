import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ancestorsOf, b, blockText, chart, childrenOf, createBlockId, createDocument, createEditor, defaultHint, descendantsOf, diffDocuments, findBlocks, formatIssues, fromMarkdown, getBlock, getOutline, op,
  orderedBlocks, plainRuns, reservedIds, runs, stats, summarizeRevision, toHTML, toMarkdown, toPlainText, transaction, validateDocument, validateTransaction, withHints,
} from '../packages/core/src/index.js';
import type { Actor, ApplyResult, BlockInput, Editor, InlineRun, ResearchDocument } from '../packages/core/src/index.js';

const at = '2026-10-05T12:00:00.000Z';
const human: Actor = { id: 'analyst', kind: 'human' };
const agent: Actor = { id: 'research-agent', kind: 'agent' };
const citation = (id: string, title = `Source ${id}`) => ({ id, title, url: `https://example.org/${id}`, accessedAt: at });
function editor(): Editor { return createEditor(createDocument({ id: 'report', title: 'Report' }, { now: () => at }), { now: () => at }); }
function ok(result: ApplyResult): Extract<ApplyResult, { ok: true }> { assert.equal(result.ok, true, JSON.stringify(result)); return result as Extract<ApplyResult, { ok: true }>; }
function bad(result: ApplyResult, code?: string): Extract<ApplyResult, { ok: false }> { assert.equal(result.ok, false); if (code) assert.equal((result as { issues: { code: string }[] }).issues[0]?.code, code); return result as Extract<ApplyResult, { ok: false }>; }
function seed(blocks: BlockInput[], citations = [citation('src')]): Editor {
  const current = editor();
  ok(transaction(current, human).addCitation(citations[0]!).insert(blocks).commit());
  return current;
}
const ids = (blocks: readonly { id: string }[]): string[] => blocks.map(block => block.id);

/** A document that uses every block type, nested in a section and a toggle. */
function everything(): Editor {
  const current = editor();
  const tx = transaction(current, agent).addCitation(citation('src', 'Primary [source]')).setTitle('Weekly *research* report');
  tx.insert([
    b.heading('h1', 1, 'Overview'),
    b.paragraph('intro', 'Growth is **strong**, _but_ ~~not~~ uneven; see `code` and [the site](https://example.org/a)[^src].'),
    b.section('macro', 'Macro'),
    b.heading('rates', 2, 'Rates', { parentId: 'macro' }),
    b.list('bullets', ['One', 'Two', 'Three'], { parentId: 'macro', indent: [0, 1, 0] }),
    b.list('steps', ['First', 'Second'], { parentId: 'macro', style: 'number' }),
    b.list('todo', ['Ship', 'Review'], { parentId: 'macro', checked: [true, false] }),
    b.table('table', ['Asset', 'Weight'], [['BTC', 40], ['ETH | L2', null]], { parentId: 'macro', align: ['left', 'right'], caption: 'Allocation', headerColumn: true }),
    b.chart('line', chart.line({ title: 'Price', labels: ['Mon', 'Tue'], values: [1.5, 2], unit: 'USD', source: 'OKX daily candles', caption: 'Closing price', annotations: [{ label: 'Peak', at: 'Tue' }] }), { parentId: 'macro' }),
    b.chart('candles', chart.candlestick({ title: 'BTC', ohlc: [{ t: 'd1', o: 1, h: 3, l: 0.5, c: 2, v: 10 }, { t: 'd2', o: 2, h: 4, l: 1, c: 3 }] }), { parentId: 'macro' }),
    b.chart('scatter', chart.scatter({ title: 'Risk', points: [{ series: 'Funds', x: 1, y: 2 }] }), { parentId: 'macro' }),
    b.chart('heat', chart.heatmap({ title: 'Correlation', rows: ['A', 'B'], columns: ['A', 'B'], values: [[1, 0.2], [0.2, 1]] }), { parentId: 'macro' }),
    b.toggle('details', 'Details', { open: true, parentId: 'macro' }),
    b.heading('in-toggle', 3, 'Methodology', { parentId: 'details' }),
    b.callout('warn', 'warning', 'Data is **delayed**.', { title: 'Careful', parentId: 'details', citationIds: ['src'] }),
    b.quote('quote', 'Be fearful.', { attribution: 'A. Investor', parentId: 'details' }),
    b.code('code', 'ts', 'const a = `x`;\nconsole.log(a);', { parentId: 'details' }),
    b.metrics('kpis', [{ label: 'Return', value: '12.4%', change: 1.5, tone: 'up', hint: 'YTD' }, { label: 'Vol', value: '30%', change: -0.5 }], { parentId: 'details' }),
    b.embed('embed', 'https://charts.example.org/1', 'Live chart', { parentId: 'details', height: 400 }),
    b.timestamp('asof', at, 'Data as of', { parentId: 'details' }),
    b.image('image', 'https://example.org/a.png', 'A chart', { caption: 'Figure 1', width: 'wide' }),
    b.toc('toc'), b.divider('divider'), b.pageBreak('break'),
  ]);
  ok(tx.commit());
  return current;
}

// ---- query ----------------------------------------------------------------------------------------------------------

test('query: findBlocks combines selectors in reading order and the tree helpers agree', () => {
  const doc = everything().getSnapshot();
  assert.equal(validateDocument(doc).ok, true);
  assert.deepEqual(ids(findBlocks(doc, { type: 'heading' })), ['h1', 'rates', 'in-toggle']);
  assert.deepEqual(ids(findBlocks(doc, { type: ['section', 'toggle'] })), ['macro', 'details']);
  assert.deepEqual(ids(findBlocks(doc, { text: 'DELAYED' })), ['warn']);
  assert.deepEqual(ids(findBlocks(doc, { text: 'DELAYED', caseSensitive: true })), []);
  assert.deepEqual(ids(findBlocks(doc, { parentId: null })).slice(0, 3), ['h1', 'intro', 'macro']);
  assert.deepEqual(ids(findBlocks(doc, { parentId: 'details', type: 'callout' })), ['warn']);
  assert.deepEqual(ids(findBlocks(doc, { within: 'macro', type: 'heading' })), ['rates', 'in-toggle']);
  assert.deepEqual(ids(findBlocks(doc, { ids: ['quote', 'h1'] })), ['h1', 'quote']);
  assert.deepEqual(ids(findBlocks(doc, { citationId: 'src' })), ['intro', 'warn']);
  assert.equal(findBlocks(doc, { limit: 2 }).length, 2); assert.equal(findBlocks(doc).length, doc.blocks.length);
  assert.deepEqual(ids(findBlocks(doc, { type: 'quote', text: 'nothing' })), []);
  assert.equal(getBlock(doc, 'quote')?.id, 'quote'); assert.equal(getBlock(doc, 'nope'), undefined);
  assert.deepEqual(ids(childrenOf(doc, 'details')).slice(0, 3), ['in-toggle', 'warn', 'quote']); assert.equal(childrenOf(doc, 'nope').length, 0);
  assert.deepEqual(ids(ancestorsOf(doc, 'in-toggle')), ['macro', 'details']); assert.deepEqual(ids(ancestorsOf(doc, 'h1')), []); assert.deepEqual(ids(ancestorsOf(doc, 'nope')), []);
  assert.deepEqual(ids(descendantsOf(doc, 'details')), ['in-toggle', 'warn', 'quote', 'code', 'kpis', 'embed', 'asof']);
  assert.deepEqual(ids(orderedBlocks(doc)).slice(0, 4), ['h1', 'intro', 'macro', 'rates']);
  assert.equal(blockText(getBlock(doc, 'table')!), 'Allocation\nAsset\tWeight\nBTC\t40\nETH | L2\t');
  assert.equal(blockText(getBlock(doc, 'divider')!), '');
  assert.match(blockText(getBlock(doc, 'intro')!), /^Growth is strong, but not uneven; see code and the site/);
});

test('query: getOutline nests headings by level, sections by containment and sees through toggles', () => {
  const doc = everything().getSnapshot();
  const outline = getOutline(doc);
  assert.deepEqual(outline.map(item => [item.id, item.type, item.level]), [['h1', 'heading', 1], ['macro', 'section', 1]]);
  const macro = outline[1]!;
  assert.deepEqual(macro.children.map(item => [item.id, item.level]), [['rates', 2]]);
  assert.deepEqual(macro.children[0]!.children.map(item => [item.id, item.title, item.level]), [['in-toggle', 'Methodology', 3]]);
  const nested = seed([b.section('a', 'A'), b.section('b', 'B', { parentId: 'a' }), b.heading('x', 2, 'X', { parentId: 'b' }), b.heading('y', 2, 'Y', { parentId: 'b' }), b.heading('z', 3, 'Z', { parentId: 'b' }), b.heading('top', 2, 'Top')]).getSnapshot();
  assert.deepEqual(getOutline(nested), [
    { id: 'a', type: 'section', title: 'A', level: 1, children: [{ id: 'b', type: 'section', title: 'B', level: 2, children: [
      { id: 'x', type: 'heading', title: 'X', level: 2, children: [] }, { id: 'y', type: 'heading', title: 'Y', level: 2, children: [{ id: 'z', type: 'heading', title: 'Z', level: 3, children: [] }] }] }] },
    { id: 'top', type: 'heading', title: 'Top', level: 2, children: [] }]);
  assert.deepEqual(getOutline(editor().getSnapshot()), []);
});

// ---- builders -------------------------------------------------------------------------------------------------------

test('builders: every b.* type, chart.* kind and numeric cell passes core validation', () => {
  assert.equal(validateDocument(everything().getSnapshot()).ok, true);
  const current = editor();
  const specs = [chart.pie({ title: 'P', labels: ['a', 'b'], values: [1, 2] }), chart.donut({ title: 'D', labels: ['a', 'b'], values: [1, 2] }), chart.bar({ title: 'B', labels: ['a', 'b'], series: [{ name: 'x', values: [1, 2], color: '#fff' }, { name: 'y', values: [2, 1] }], stacked: true, horizontal: true }),
    chart.trend({ title: 'T', labels: ['a'], values: [1] }), chart.area({ title: 'A', labels: ['a', 'b'], values: [1, 2], stacked: true }), chart.histogram({ title: 'H', labels: ['a', 'b'], values: [1, 2] }),
    chart.waterfall({ title: 'W', labels: ['a', 'b'], values: [1, -2], yAxis: { format: 'percent' } })];
  ok(transaction(current, agent).insert(specs.map((spec, index) => b.chart(`c${index}`, spec))).commit());
  assert.deepEqual(specs.map(spec => spec.kind), ['pie', 'donut', 'bar', 'trend', 'area', 'histogram', 'waterfall']);
  assert.equal(chart.pie({ title: 'P', labels: ['a'], values: [1] }).series[0]!.name, 'Share');
  assert.deepEqual(Object.keys(chart.scatter({ title: 'S', points: [{ series: 's', x: 1, y: 2 }] })).sort(), ['kind', 'labels', 'points', 'series', 'title']);
  assert.deepEqual(b.table('t', ['a'], [[1, true, null, undefined, 'x']]).content, { type: 'table', columns: ['a'], rows: [['1', 'true', '', '', 'x']] });
  assert.deepEqual(b.list('l', ['a']).content, { type: 'list', ordered: false, items: ['a'] });
  assert.deepEqual(b.list('l', ['a'], { ordered: true }).content, { type: 'list', ordered: true, items: ['a'] });
  assert.deepEqual(b.list('l', ['a'], { style: 'number', ordered: false }).content, { type: 'list', ordered: true, items: ['a'], style: 'number' });
  assert.deepEqual(b.toggle('t', 'T').content, { type: 'toggle', title: 'T', open: false });
  assert.deepEqual(b.divider('d', { parentId: 's', citationIds: ['c'] }), { id: 'd', parentId: 's', content: { type: 'divider' }, citationIds: ['c'] });
});

test('runs(): inline markdown-lite becomes typed runs, nests marks and leaves unmatched markers alone', () => {
  assert.deepEqual(runs('plain'), [{ text: 'plain' }]); assert.deepEqual(runs(''), []);
  assert.deepEqual(runs('**b** _i_ ~~s~~ `c` [l](https://example.org/x)'), [{ text: 'b', bold: true }, { text: ' ' }, { text: 'i', italic: true }, { text: ' ' }, { text: 's', strike: true }, { text: ' ' }, { text: 'c', code: true }, { text: ' ' }, { text: 'l', href: 'https://example.org/x' }]);
  assert.deepEqual(runs('***both*** and **bold _nested_ text**'), [{ text: 'both', bold: true, italic: true }, { text: ' and ' }, { text: 'bold ', bold: true }, { text: 'nested', bold: true, italic: true }, { text: ' text', bold: true }]);
  assert.deepEqual(runs('[**bold link**](https://example.org)'), [{ text: 'bold link', bold: true, href: 'https://example.org/' }]);
  assert.deepEqual(runs('claim[^src-1] more'), [{ text: 'claim' }, { text: '', citationId: 'src-1' }, { text: ' more' }]);
  assert.deepEqual(runs('snake_case_name and 2 * 3 * 4 and 5*6'), [{ text: 'snake_case_name and 2 * 3 * 4 and 5*6' }]);
  assert.deepEqual(runs('unclosed **bold and `tick'), [{ text: 'unclosed **bold and `tick' }]);
  assert.deepEqual(runs('\\*not italic\\* and \\[x\\]'), [{ text: '*not italic* and [x]' }]);
  assert.deepEqual(runs('[x](javascript:alert(1)) [y](http://example.org)'), [{ text: '[x](javascript:alert(1)) ' }, { text: 'y', href: 'http://example.org/' }]);
  assert.deepEqual(runs('`` a ` b ``'), [{ text: 'a ` b', code: true }]);
  assert.deepEqual(plainRuns('**keep** BTC_USDT'), [{ text: '**keep** BTC_USDT' }]); assert.deepEqual(plainRuns(''), []);
  // Every parse result is a valid paragraph.
  const current = editor(); ok(transaction(current, human).addCitation(citation('src-1')).insert(b.paragraph('p', 'x **y** [z](https://example.org/)[^src-1]')).commit());
});

test('runs(): hostile and pathological input finishes quickly and stays literal', () => {
  const started = Date.now();
  for (const input of ['*a '.repeat(30_000), '[['.repeat(30_000), '`'.repeat(1) + '``a'.repeat(20_000), '_a'.repeat(40_000), `${'**'.repeat(20_000)}x`, '[a](b'.repeat(15_000)]) {
    const parsed = runs(input); assert.ok(parsed.length > 0);
  }
  assert.ok(Date.now() - started < 5_000, `parsing took ${Date.now() - started}ms`);
  assert.equal(runs('<script>alert(1)</script>')[0]!.text, '<script>alert(1)</script>');
});

test('op builders produce the operation shapes of the contract without undefined fields', () => {
  assert.deepEqual(op.insertBlock(b.divider('d')), { type: 'insertBlock', block: b.divider('d') });
  assert.deepEqual(op.insertBlock(b.divider('d'), null), { type: 'insertBlock', block: b.divider('d'), afterId: null });
  assert.deepEqual(op.replaceText('x', 2, 'a', 'b'), { type: 'replaceText', blockId: 'x', expectedVersion: 2, find: 'a', replace: 'b' });
  assert.deepEqual(op.replaceText('x', 2, 'a', 'b', { all: true }), { type: 'replaceText', blockId: 'x', expectedVersion: 2, find: 'a', replace: 'b', all: true });
  assert.deepEqual(op.moveBlocks([{ blockId: 'a', expectedVersion: 1 }], 's', 'z'), { type: 'moveBlocks', blocks: [{ blockId: 'a', expectedVersion: 1 }], parentId: 's', afterId: 'z' });
  assert.deepEqual(op.duplicateBlock('a', 1, { a: 'b' }), { type: 'duplicateBlock', blockId: 'a', expectedVersion: 1, newIds: { a: 'b' } });
  const all = [op.insertBlock(b.divider('x')), op.updateBlock('x', 1, { type: 'divider' }), op.moveBlock('x', 1, null), op.deleteBlock('x', 1), op.setTitle('t'), op.setFormat({ page: 'A4', font: 'sans', fontSize: 12, lineHeight: 1.5 }), op.addCitation(citation('c')),
    op.insertBlocks([b.divider('y')]), op.duplicateBlock('x', 1, { x: 'x2' }), op.replaceText('x', 1, 'a', 'b'), op.deleteBlocks([{ blockId: 'x', expectedVersion: 1 }]), op.moveBlocks([{ blockId: 'x', expectedVersion: 1 }], null), op.updateCitation(citation('c')), op.removeCitation('c')];
  assert.equal(validateTransaction({ id: 'all', actor: human, baseRevision: 0, operations: all }).ok, true);
});

test('createBlockId finds the first free id and reservedIds includes retired blocks', () => {
  assert.equal(createBlockId('p', []), 'p-1'); assert.equal(createBlockId('p', ['p-1', 'p-2', 'p-4']), 'p-3');
  const used = new Set(['p-1']); assert.equal(createBlockId('p', used), 'p-2'); assert.equal(createBlockId('p', used), 'p-3'); assert.ok(used.has('p-3'));
  const current = seed([b.paragraph('p-1', 'a'), b.paragraph('p-2', 'b')]);
  ok(transaction(current, human).remove('p-2').commit());
  assert.deepEqual([...reservedIds(current.getSnapshot())].sort(), ['p-1', 'p-2']);
  assert.equal(createBlockId('p', current.getSnapshot()), 'p-3');
  assert.equal(createBlockId('p', current.getSnapshot()), 'p-3');
  assert.throws(() => createBlockId('_bad'), /prefix/); assert.throws(() => createBlockId(''), TypeError);
});

test('transaction(): fills guards from the snapshot, tracks blocks changed inside the batch and reports conflicts', () => {
  const current = seed([b.section('s', 'S'), b.paragraph('p', 'Revenue grew', { parentId: 's' }), b.paragraph('q', 'Other')]);
  const built = transaction(current, agent, { id: 'my-tx', conflictPolicy: 'rebase-safe' }).replaceText('p', 'Revenue', 'Sales').build();
  assert.deepEqual(built, { id: 'my-tx', actor: agent, baseRevision: 1, conflictPolicy: 'rebase-safe', operations: [{ type: 'replaceText', blockId: 'p', expectedVersion: 1, find: 'Revenue', replace: 'Sales' }] });
  const result = ok(transaction(current, agent)
    .insert(b.paragraph('new', 'Hello'), 'q')
    .update('new', content => content.type === 'paragraph' ? { ...content, runs: runs('**Hello** world') } : content)
    .replaceText('new', 'world', 'there')
    .replaceText('p', 'Revenue', 'Sales')
    .update('p', content => ({ ...content } as typeof content))
    .move('q', 's', null)
    .commit());
  assert.equal(result.revision.operations.length, 6);
  const doc = current.getSnapshot();
  assert.deepEqual(ids(childrenOf(doc, 's')), ['q', 'p']); assert.equal(getBlock(doc, 'new')!.version, 3);
  assert.equal(blockText(getBlock(doc, 'new')!), 'Hello there'); assert.equal(blockText(getBlock(doc, 'p')!), 'Sales grew');
  // Delete, duplicate with minted ids, citation changes and several moves.
  ok(transaction(current, human).duplicate('s', { idPrefix: 'copy' }).remove('new').addCitation(citation('two')).setTitle('Renamed').commit());
  assert.deepEqual(ids(current.getSnapshot().blocks).filter(id => id.startsWith('copy')), ['copy-1', 'copy-2', 'copy-3']);
  ok(transaction(current, human).move(['q', 'p'], null, null).remove('copy-1').commit());
  assert.deepEqual(ids(childrenOf(current.getSnapshot(), null)).slice(0, 2), ['q', 'p']);
  // Guards come from the creation-time snapshot, so someone else's edit makes commit fail instead of overwrite.
  const stale = transaction(current, agent).replaceText('q', 'Other', 'Mine');
  ok(transaction(current, human).replaceText('q', 'Other', 'Theirs').commit());
  bad(stale.commit(), 'conflict');
  assert.equal(blockText(getBlock(current.getSnapshot(), 'q')!), 'Theirs');
  // Problems are returned as results, never thrown by commit().
  const unknown = transaction(current, human).update('ghost', { type: 'divider' }).remove('ghost2');
  const failed = bad(unknown.commit(), 'not-found'); assert.equal(failed.issues.length, 2); assert.match(failed.issues[0]!.hint ?? '', /findBlocks/);
  assert.throws(() => unknown.build(), /does not exist/);
  bad(transaction(current, human).commit(), 'validation');
  const removed = transaction(seed([b.paragraph('p', 'x', { citationIds: ['src'] })]), human);
  removed.removeCitation('src').update('p', { type: 'paragraph', runs: [] }); assert.equal((removed.operations[1] as { expectedVersion: number }).expectedVersion, 2);
});

// ---- markdown -------------------------------------------------------------------------------------------------------

test('toMarkdown renders every block type, escapes specials and appends footnote definitions', () => {
  const markdown = toMarkdown(everything().getSnapshot());
  assert.match(markdown, /^# Weekly \\\*research\\\* report\n\n# Overview\n\n/);
  assert.match(markdown, /Growth is \*\*strong\*\*, \*but\* ~~not~~ uneven; see `code` and \[the site\]\(https:\/\/example\.org\/a\)\[\^src\]\./);
  assert.match(markdown, /\n## Macro\n\n### Rates\n\n- One\n {2}- Two\n- Three\n\n1\. First\n2\. Second\n\n- \[x\] Ship\n- \[ \] Review\n/);
  assert.match(markdown, /\| Asset \| Weight \|\n\| :--- \| ---: \|\n\| BTC \| 40 \|\n\| ETH \\\| L2 \|  \|\n\n\*Allocation\*/);
  assert.match(markdown, /\*\*Price\*\* \(line chart, USD\)\n\n\|  \| Value \|\n\| --- \| --- \|\n\| Mon \| 1\.5 \|\n\| Tue \| 2 \|\n\nNotes: Peak \(Tue\)\n\nClosing price\n\nSource: OKX daily candles/);
  assert.match(markdown, /\| Time \| Open \| High \| Low \| Close \| Volume \|\n\| --- \| --- \| --- \| --- \| --- \| --- \|\n\| d1 \| 1 \| 3 \| 0\.5 \| 2 \| 10 \|\n\| d2 \| 2 \| 4 \| 1 \| 3 \|  \|/);
  assert.match(markdown, /\| Series \| x \| y \|\n\| --- \| --- \| --- \|\n\| Funds \| 1 \| 2 \|/);
  assert.match(markdown, /\|  \| A \| B \|\n\| --- \| --- \| --- \|\n\| A \| 1 \| 0\.2 \|/);
  assert.match(markdown, /\*\*Details\*\*\n\n#### Methodology\n\n> \[!WARNING\]\n> \*\*Careful\*\*\n> Data is \*\*delayed\*\*\.\n\nSources: \[\^src\]/);
  assert.match(markdown, /> Be fearful\.\n>\n> — A\. Investor/);
  assert.match(markdown, /```ts\nconst a = `x`;\nconsole\.log\(a\);\n```/);
  assert.match(markdown, /\| Metric \| Value \| Change \| Note \|\n\| --- \| --- \| --- \| --- \|\n\| Return \| 12\.4% \| \+1\.5% \| YTD \|\n\| Vol \| 30% \| -0\.5% \|  \|/);
  assert.match(markdown, /\[Live chart\]\(https:\/\/charts\.example\.org\/1\)\n\nData as of: 2026-10-05T12:00:00\.000Z/);
  assert.match(markdown, /!\[A chart\]\(https:\/\/example\.org\/a\.png\)\n\n\*Figure 1\*\n\n- Overview\n- Macro\n {2}- Rates\n {4}- Methodology\n\n---\n\n\*\*\*\n/);
  assert.match(markdown, /\[\^src\]: \[Primary \\\[source\\\]\]\(https:\/\/example\.org\/src\), accessed 2026-10-05\n$/);
  assert.equal(toMarkdown(everything().getSnapshot(), { title: false }).startsWith('# Overview'), true);
  assert.match(toMarkdown(seed([b.chart('c', chart.line({ title: 'Long', labels: Array.from({ length: 5 }, (_, i) => `l${i}`), values: [1, 2, 3, 4, 5] }))]).getSnapshot(), { chartRows: 2 }), /\| l1 \| 2 \|\n\n\*… 3 more rows omitted\*/);
});

test('toMarkdown escapes text that would otherwise be read as markup', () => {
  const nasty = ['# not a heading', '- not a list', '1. not numbered', '> not a quote', '---', '=== ', '*star* _under_ `tick` [link](x) <b>x</b> ~~s~~ &amp; end'];
  const current = seed(nasty.map((text, index) => b.paragraph(`p${index}`, [{ text }])));
  const markdown = toMarkdown(current.getSnapshot(), { title: false });
  const back = fromMarkdown(markdown.split('\n\n').slice(0, nasty.length).join('\n\n'), { idPrefix: 'n' });
  assert.deepEqual(back.map(block => block.content.type === 'paragraph' ? block.content.runs.map(run => run.text).join('') : null), nasty.map(text => text.trim()));
});

test('fromMarkdown reads headings, lists, tables, quotes, alerts, code, rules and images into valid blocks', () => {
  const md = `# Title\n\nSome **bold** text\nspanning lines and a hard break  \nnext line[^src].\n\n## Section\n\n- a\n  - nested\n- b [link](https://example.org/x)\n\n3. three\n4. four\n\n- [x] done\n- [ ] open\n\n| Name | Qty |\n| :--- | ---: |\n| A \\| B | 1 |\n| C | |\n\n> quoted line\n>\n> — Someone\n\n> [!WARNING]\n> **Heads up**\n> Be careful.\n\n\`\`\`python\nprint("hi")\n\`\`\`\n\n---\n\n***\n\n[TOC]\n\n![Alt text](https://example.org/i.png)\n\n![bad](http://example.org/i.png)\n\n####### not a heading\n\n[^note]: footnote text`;
  const blocks = fromMarkdown(md, { idPrefix: 'imp', parentId: 'target' });
  assert.deepEqual(ids(blocks), blocks.map((_, index) => `imp-${index + 1}`)); assert.ok(blocks.every(block => block.parentId === 'target'));
  const kinds = blocks.map(block => block.content.type);
  assert.deepEqual(kinds, ['heading', 'paragraph', 'heading', 'list', 'list', 'list', 'table', 'quote', 'callout', 'code', 'divider', 'pageBreak', 'toc', 'image', 'paragraph', 'paragraph', 'paragraph']);
  assert.deepEqual(blocks[0]!.content, { type: 'heading', level: 1, text: 'Title' });
  assert.deepEqual((blocks[1]!.content as { runs: InlineRun[] }).runs, [{ text: 'Some ' }, { text: 'bold', bold: true }, { text: ' text spanning lines and a hard break\nnext line' }, { text: '', citationId: 'src' }, { text: '.' }]);
  assert.deepEqual(blocks[2]!.content, { type: 'heading', level: 2, text: 'Section' });
  assert.deepEqual(blocks[3]!.content, { type: 'list', ordered: false, items: ['a', 'nested', 'b link (https://example.org/x)'], indent: [0, 1, 0] });
  assert.deepEqual(blocks[4]!.content, { type: 'list', ordered: true, items: ['three', 'four'] });
  assert.deepEqual(blocks[5]!.content, { type: 'list', ordered: false, items: ['done', 'open'], style: 'todo', checked: [true, false] });
  assert.deepEqual(blocks[6]!.content, { type: 'table', columns: ['Name', 'Qty'], rows: [['A | B', '1'], ['C', '']], align: ['left', 'right'] });
  assert.deepEqual(blocks[7]!.content, { type: 'quote', runs: [{ text: 'quoted line' }], attribution: 'Someone' });
  assert.deepEqual(blocks[8]!.content, { type: 'callout', tone: 'warning', title: 'Heads up', runs: [{ text: 'Be careful.' }] });
  assert.deepEqual(blocks[9]!.content, { type: 'code', language: 'python', text: 'print("hi")' });
  assert.deepEqual(blocks[13]!.content, { type: 'image', url: 'https://example.org/i.png', alt: 'Alt text' });
  // An image that cannot be an image block (not https) survives as a link to it.
  assert.deepEqual(blocks[14]!.content, { type: 'paragraph', runs: [{ text: 'bad', href: 'http://example.org/i.png' }] });
  assert.equal((blocks[15]!.content as { runs: InlineRun[] }).runs[0]!.text, '####### not a heading');
  assert.deepEqual(blocks[16]!.content, { type: 'paragraph', runs: [{ text: '[^note]: footnote text' }] });
  // The result inserts cleanly once the citations and the container exist.
  const current = editor(); ok(transaction(current, human).addCitation(citation('src')).insert(b.section('target', 'Target')).insert(blocks).commit());
  assert.equal(current.getSnapshot().blocks.length, blocks.length + 1);
  const noMarkers = fromMarkdown('see[^src] here', { idPrefix: 'x', citationMarkers: false });
  assert.deepEqual(noMarkers[0]!.content, { type: 'paragraph', runs: [{ text: 'see[^src] here' }] });
  assert.deepEqual(fromMarkdown('', { idPrefix: 'x' }), []); assert.deepEqual(fromMarkdown('\n\n  \n', { idPrefix: 'x' }), []);
  assert.throws(() => fromMarkdown('x', { idPrefix: '' }), /idPrefix/); assert.throws(() => fromMarkdown('x', { idPrefix: '-bad' }), TypeError);
  assert.deepEqual(fromMarkdown('a\r\n\r\nb', { idPrefix: 'x' }).map(block => block.content.type), ['paragraph', 'paragraph']);
  assert.equal((fromMarkdown('```\nunclosed', { idPrefix: 'x' })[0]!.content as { text: string }).text, 'unclosed');
  assert.deepEqual(fromMarkdown('# A #\n#B', { idPrefix: 'x' }).map(block => block.content.type), ['heading', 'paragraph']);
  assert.deepEqual(fromMarkdown('para\n2. still the paragraph\n- item\n1. new list', { idPrefix: 'x' }).map(block => block.content.type), ['paragraph', 'list', 'list']);
  assert.deepEqual((fromMarkdown('para\n2. still the paragraph', { idPrefix: 'x' })[0]!.content as { runs: InlineRun[] }).runs, [{ text: 'para 2. still the paragraph' }]);
});

test('markdown round trip keeps the structure and text of the supported blocks', () => {
  const source = seed([
    b.heading('h', 2, 'Findings'), b.paragraph('p', 'Plain **bold** *italic* ~~gone~~ `code` [site](https://example.org/s).'),
    b.list('l', ['one', 'two', 'three'], { indent: [0, 1, 1] }), b.list('n', ['x', 'y'], { ordered: true }), b.list('t', ['a', 'b'], { checked: [false, true] }),
    b.table('tbl', ['A', 'B'], [['1', '2']], { align: ['center', 'right'] }), b.quote('q', 'Words', { attribution: 'Me' }), b.callout('c', 'success', 'Nice', { title: 'Good' }),
    b.code('code', 'sql', 'select 1;'), b.divider('d'), b.pageBreak('pb'), b.image('i', 'https://example.org/i.png', 'Alt'),
  ]).getSnapshot();
  const back = fromMarkdown(toMarkdown(source, { title: false }).replace(/\n\[\^src\]:.*\n$/, '\n'), { idPrefix: 'rt' });
  const strip = (blocks: readonly { content: BlockInput['content'] }[]) => blocks.map(block => block.content);
  assert.deepEqual(strip(back), strip(source.blocks));
});

test('toHTML is escaped, static and complete: details, tables, lists, charts, sources and standalone documents', () => {
  const html = toHTML(everything().getSnapshot());
  assert.match(html, /^<article class="se-document" data-document-id="report">\n<h1>Weekly \*research\* report<\/h1>/);
  assert.match(html, /<h1 id="h1">Overview<\/h1>/); assert.match(html, /<section id="macro"><h2>Macro<\/h2>/);
  assert.match(html, /<strong>strong<\/strong>, <em>but<\/em> <s>not<\/s> uneven; see <code>code<\/code> and <a href="https:\/\/example\.org\/a" rel="noopener noreferrer">the site<\/a><sup class="citation"><a href="#cite-src">\[1\]<\/a><\/sup>\./);
  assert.match(html, /<ul id="bullets"><li>One<ul><li>Two<\/li><\/ul><\/li><li>Three<\/li><\/ul>/);
  assert.match(html, /<ol id="steps"><li>First<\/li><li>Second<\/li><\/ol>/);
  assert.match(html, /<ul id="todo" class="todo-list"><li><input type="checkbox" disabled checked> Ship<\/li><li><input type="checkbox" disabled> Review<\/li><\/ul>/);
  assert.match(html, /<table id="table"><caption>Allocation<\/caption><thead><tr><th scope="col">Asset<\/th><th scope="col" style="text-align:right">Weight<\/th><\/tr><\/thead><tbody><tr><th scope="row">BTC<\/th><td style="text-align:right">40<\/td><\/tr>/);
  assert.match(html, /<figure id="line" class="chart" data-kind="line"><figcaption>Price <small>\(line chart, USD\)<\/small><\/figcaption><table>/);
  assert.match(html, /<details id="details" open><summary>Details<\/summary>/);
  assert.match(html, /<aside id="warn" class="callout" data-tone="warning" role="note"><strong>Careful<\/strong><p>Data is <strong>delayed<\/strong>\.<\/p><\/aside><small class="block-sources">Sources: <sup class="citation"><a href="#cite-src">\[1\]<\/a><\/sup><\/small>/);
  assert.match(html, /<blockquote id="quote">Be fearful\.<footer>— A\. Investor<\/footer><\/blockquote>/);
  assert.match(html, /<pre id="code"><code class="language-ts">const a = `x`;\nconsole\.log\(a\);<\/code><\/pre>/);
  assert.match(html, /<p id="embed" class="embed"><a href="https:\/\/charts\.example\.org\/1" rel="noopener noreferrer">Live chart<\/a><\/p>/);
  assert.match(html, /<figure id="image" class="image width-wide"><img src="https:\/\/example\.org\/a\.png" alt="A chart" loading="lazy" referrerpolicy="no-referrer"><figcaption>Figure 1<\/figcaption><\/figure>/);
  assert.match(html, /<nav id="toc" class="toc" aria-label="Table of contents"><ol><li><a href="#h1">Overview<\/a><\/li><li><a href="#macro">Macro<\/a><ol><li><a href="#rates">Rates<\/a><ol>/);
  assert.match(html, /<hr id="break" class="page-break">/); assert.match(html, /<section class="sources" aria-label="Sources"><h2>Sources<\/h2><ol><li id="cite-src"><a href="https:\/\/example\.org\/src" rel="noopener noreferrer">Primary \[source\]<\/a>/);
  assert.doesNotMatch(html, /<iframe|<script|onerror|javascript:/i);
  assert.equal(toHTML(everything().getSnapshot(), { title: false }).includes('<h1>Weekly'), false);
  const standalone = toHTML(everything().getSnapshot(), { standalone: true });
  assert.match(standalone, /^<!doctype html>\n<html lang="en"><head><meta charset="utf-8">.*<title>Weekly \*research\* report<\/title><style>/s); assert.match(standalone, /<\/article>\n<\/body><\/html>\n$/);
});

test('toHTML and toPlainText neutralise hostile text', () => {
  const hostile = '<img src=x onerror=alert(1)> "quoted" & \'single\'';
  const current = seed([b.paragraph('p', [{ text: hostile, bold: true }]), b.section('s', hostile), b.callout('c', 'info', [{ text: hostile }], { title: hostile }), b.code('k', 'ts', hostile), b.table('t', [hostile], [[hostile]], { caption: hostile }), b.metrics('m', [{ label: hostile, value: hostile }])]);
  const html = toHTML(current.getSnapshot());
  assert.doesNotMatch(html, /<img|onerror=alert\(1\)>/); assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &quot;quoted&quot; &amp; &#39;single&#39;/);
  const doc = current.getSnapshot();
  const tampered = JSON.parse(JSON.stringify(doc)) as ResearchDocument;
  tampered.blocks[0]!.content = { type: 'paragraph', runs: [{ text: 'x', href: 'javascript:alert(1)' }] };
  assert.doesNotMatch(toHTML(tampered), /javascript:/);
  assert.match(toPlainText(doc), /<img src=x onerror=alert\(1\)>/);
});

test('toPlainText lists text with markers, tables as tab rows and a numbered source list', () => {
  const text = toPlainText(everything().getSnapshot());
  assert.match(text, /^Weekly \*research\* report\n\nOverview\n\nGrowth is strong, but not uneven; see code and the site\[1\]\.\n\nMacro\n\nRates\n\n- One\n {2}- Two\n- Three\n\n1\. First\n2\. Second\n\n\[x\] Ship\n\[ \] Review\n\nAllocation\nAsset\tWeight\nBTC\t40\nETH \| L2\t\n\n/);
  assert.match(text, /Price \(line chart, USD\)\n\tValue\nMon\t1\.5\nTue\t2\nNotes: Peak \(Tue\)\nClosing price\nSource: OKX daily candles/);
  assert.match(text, /Methodology\n\nWarning: Careful\nData is delayed\. \[1\]\n\n“Be fearful\.” — A\. Investor\n\nconst a = `x`;/);
  assert.match(text, /Return: 12\.4% \(\+1\.5%\) — YTD\nVol: 30% \(-0\.5%\)\n\nLive chart \(https:\/\/charts\.example\.org\/1\)/);
  assert.match(text, /\[Image: A chart\] Figure 1\n\nOverview\nMacro\n {2}Rates\n {4}Methodology\n\n----\n\n----\n\nSources\n\[1\] Primary \[source\] — https:\/\/example\.org\/src \(accessed 2026-10-05\)\n$/);
  assert.equal(toPlainText(everything().getSnapshot(), { title: false }).startsWith('Overview'), true);
});

// ---- stats, diff, summaries, issues ---------------------------------------------------------------------------------

test('stats counts words, characters, block types and reading time, including CJK text', () => {
  const empty = stats(editor().getSnapshot()); assert.deepEqual(empty, { words: 0, characters: 0, charactersNoSpaces: 0, blocks: 0, blocksByType: {}, charts: 0, tables: 0, images: 0, citations: 0, readingMinutes: 0 });
  const doc = seed([b.heading('h', 1, 'Hello world'), b.paragraph('p', "It's 3.5% — don't panic, state-of-the-art."), b.chart('c', chart.bar({ title: 'Two words', labels: ['a'], values: [1] })), b.table('t', ['A'], [['x']]), b.image('i', 'https://example.org/i.png', 'alt'), b.divider('d')]).getSnapshot();
  const counted = stats(doc);
  assert.equal(counted.words, 2 + 5 + 2 + 2 + 1); assert.equal(counted.blocks, 6); assert.equal(counted.charts, 1); assert.equal(counted.tables, 1); assert.equal(counted.images, 1); assert.equal(counted.citations, 1);
  assert.deepEqual(counted.blocksByType, { heading: 1, paragraph: 1, chart: 1, table: 1, image: 1, divider: 1 }); assert.equal(counted.readingMinutes, 1);
  assert.equal(counted.characters, 'Hello world'.length + "It's 3.5% — don't panic, state-of-the-art.".length + 'Two words'.length + 'A'.length + 'x'.length + 'alt'.length);
  const cjk = stats(seed([b.paragraph('p', [{ text: '這是一份關於比特幣的研究報告，共有二十個字。' }]), b.paragraph('q', 'English words too')]).getSnapshot());
  assert.equal(cjk.words, 20 + 3); assert.equal(cjk.readingMinutes, 1);
  const long = stats(seed([b.paragraph('p', [{ text: 'word '.repeat(2_300) }])]).getSnapshot()); assert.equal(long.words, 2_300); assert.equal(long.readingMinutes, 11);
});

test('diffDocuments reports added, removed, changed and moved blocks, plus title, format and citations', () => {
  const current = seed([b.paragraph('a', 'A'), b.paragraph('b', 'B'), b.paragraph('c', 'C'), b.paragraph('d', 'D'), b.section('s', 'S')]);
  const before = current.getSnapshot();
  assert.deepEqual(diffDocuments(before, before), { added: [], removed: [], changed: [], moved: [], titleChanged: false, formatChanged: false, citations: { added: [], removed: [], changed: [] } });
  ok(transaction(current, human).insert(b.paragraph('e', 'E')).remove('d').replaceText('a', 'A', 'AA').move('c', 's').setTitle('New').addCitation(citation('two')).updateCitation({ ...citation('src'), title: 'Changed' }).setFormat({ page: 'A4', font: 'serif', fontSize: 12, lineHeight: 1.5 }).commit());
  const diff = diffDocuments(before, current.getSnapshot());
  assert.deepEqual(diff, { added: ['e'], removed: ['d'], changed: ['a'], moved: ['c'], titleChanged: true, formatChanged: true, citations: { added: ['two'], removed: [], changed: ['src'] } });
  // Reordering inside one parent flags only the blocks that left the common order.
  const reorder = seed([b.paragraph('1', 'one'), b.paragraph('2', 'two'), b.paragraph('3', 'three'), b.paragraph('4', 'four'), b.paragraph('5', 'five')]); const first = reorder.getSnapshot();
  ok(transaction(reorder, human).move('1', null, '4').commit());
  assert.deepEqual(diffDocuments(first, reorder.getSnapshot()).moved, ['1']);
  ok(transaction(reorder, human).move(['3', '4'], null, null).commit());
  // The longest unchanged run (3, 4, 5) stays put, so the displaced blocks are 1 and 2.
  assert.deepEqual(diffDocuments(first, reorder.getSnapshot()).moved.sort(), ['1', '2']);
  // A version bump alone is not a change.
  const same = seed([b.paragraph('a', 'A')]); const snap = same.getSnapshot(); ok(transaction(same, human).update('a', content => content).commit());
  assert.deepEqual(diffDocuments(snap, same.getSnapshot()).changed, []);
});

test('summarizeRevision describes every kind of change in one sentence', () => {
  const current = seed([b.paragraph('a', 'A'), b.paragraph('b', 'B'), b.section('s', 'S')]);
  const summary = (tx: ReturnType<typeof transaction>): string => summarizeRevision(ok(tx.commit()).revision);
  assert.equal(summary(transaction(current, agent).insert([b.paragraph('c', 'C'), b.paragraph('d', 'D')]).insert(b.paragraph('e', 'E')).replaceText('a', 'A', 'AA')), 'Agent research-agent inserted 3 blocks and replaced text in 1 block.');
  assert.equal(summary(transaction(current, human).update('b', { type: 'paragraph', runs: [] }).move(['c', 'd'], 's').remove('e')), 'Human analyst edited 1 block, moved 2 blocks and deleted 1 block.');
  assert.equal(summary(transaction(current, human).duplicate('s', { idPrefix: 'x' }).setTitle('A very long title '.repeat(6)).setFormat({ page: 'A4', font: 'sans', fontSize: 16, lineHeight: 1.6 }).addCitation(citation('n')).updateCitation(citation('n')).removeCitation('n')),
    'Human analyst duplicated 1 block, renamed the document to “A very long title A very long title A very long title A v...”, changed the page format, added 1 citation, updated 1 citation and removed 1 citation.');
  assert.equal(summarizeRevision(ok(current.undo(human, current.getSnapshot().revision)).revision), 'Human analyst undid the previous change.');
  assert.equal(summarizeRevision(ok(current.redo(agent, current.getSnapshot().revision)).revision), 'Agent research-agent redid a change.');
  assert.equal(summarizeRevision({ number: 1, transactionId: 't', actor: { id: 'system', kind: 'system' }, at, kind: 'apply', operations: [] }), 'System system made no changes.');
});

test('every failed apply carries a hint; withHints, defaultHint and formatIssues fill the gaps', () => {
  const current = seed([b.paragraph('a', 'A')]);
  const failures = [
    current.apply({ id: 'f1', actor: human, baseRevision: 1, operations: [{ type: 'updateBlock', blockId: 'a', expectedVersion: 9, content: { type: 'divider' } }] }),
    current.apply({ id: 'f2', actor: human, baseRevision: 1, operations: [{ type: 'deleteBlock', blockId: 'zzz', expectedVersion: 1 }] }),
    current.apply({ id: 'f3', actor: human, baseRevision: 1, operations: [{ type: 'insertBlock', block: b.paragraph('a', 'dup') }] }),
    current.apply({ id: 'f4', actor: human, baseRevision: 'x', operations: [] }),
    current.undo(human, 99), createEditor(createDocument({ id: 'e', title: 'E' })).undo(human, 0),
  ];
  for (const failure of failures) for (const issue of bad(failure).issues) assert.ok(issue.hint && issue.hint.length > 10, JSON.stringify(issue));
  assert.deepEqual(withHints([{ code: 'conflict', message: 'm', hint: 'keep me' }]), [{ code: 'conflict', message: 'm', hint: 'keep me' }]);
  assert.match(withHints([{ code: 'history', message: 'm' }])[0]!.hint!, /session/);
  for (const code of ['validation', 'conflict', 'not-found', 'duplicate', 'history'] as const) assert.ok(defaultHint({ code }).length > 20);
  assert.match(defaultHint({ code: 'validation', path: 'x.y' }), /"x\.y"/);
  const text = formatIssues([{ code: 'not-found', message: 'Block does not exist.', blockId: 'zzz', path: 'transaction.operations[0]' }]);
  assert.match(text, /^- \[not-found\] transaction\.operations\[0\]: Block does not exist\. \(block zzz\)\n {2}hint: /);
  assert.equal(formatIssues([]), '');
});
