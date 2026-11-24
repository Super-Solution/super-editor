import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOCUMENT_FEATURES, b, createDocument, createEditor, createFormatRegistry, htmlExporter, lossWarnings, markdownExporter, markdownImporter, scanFeatures, textFormatExporter, toMarkdown, toPlainText,
  type DocumentFeature, type ExportResult, type Exporter, type FormatWarning, type ResearchDocument,
} from '../packages/core/src/index.js';
import { createAllBlocksExample } from '../examples/all-blocks.js';

const at = '2026-10-05T00:00:00.000Z';
const now = () => at;
/** The all-blocks sample on A4 serif, so the document-level format is in use as well. */
const rich = (): ResearchDocument => ({ ...createAllBlocksExample().getSnapshot(), format: { page: 'A4', font: 'serif', fontSize: 16, lineHeight: 1.6 } });
function documentWith(...blocks: ReturnType<typeof b.paragraph>[]): ResearchDocument {
  const editor = createEditor(createDocument({ id: 'doc', title: 'Doc' }, { now }), { now });
  if (blocks.length) { const result = editor.apply({ id: 'seed', actor: { id: 'test', kind: 'system' }, baseRevision: 0, operations: [{ type: 'insertBlocks', blocks }] }); assert.equal(result.ok, true, JSON.stringify(result)); }
  return editor.getSnapshot();
}
const ok = (result: ExportResult | Awaited<ExportResult>): Extract<ExportResult, { ok: true }> => { assert.equal(result.ok, true, JSON.stringify(result)); return result as Extract<ExportResult, { ok: true }>; };
const features = (warnings: FormatWarning[]): string[] => warnings.map(warning => `${warning.code === 'feature-dropped' ? '-' : '~'}${warning.feature}`);

test('scanFeatures reports every feature the sample uses, once per feature, with the blocks', () => {
  const document = rich(), uses = scanFeatures(document), byName = new Map(uses.map(use => [use.feature, use]));
  for (const feature of DOCUMENT_FEATURES) assert.ok(byName.has(feature), `the all-blocks sample should use ${feature}`);
  assert.deepEqual(uses.map(use => use.feature), DOCUMENT_FEATURES.filter(feature => byName.has(feature)), 'feature order follows DOCUMENT_FEATURES');
  assert.deepEqual(byName.get('underline')?.blockIds, ['marks-extra']);
  assert.equal(byName.get('highlight')?.count, 5, 'inline features count runs');
  assert.deepEqual(byName.get('page-format')?.blockIds, [], 'document-level features name no block');
  assert.equal(byName.get('page-format')?.path, 'document.format');
  assert.equal(byName.get('nested-list')?.blockIds.join(), 'bullets');
  assert.deepEqual(scanFeatures(documentWith(b.paragraph('p', 'plain text'))), [], 'a plain document uses none');
  const blockSource = documentWith(b.paragraph('p', 'text'));
  assert.deepEqual(scanFeatures({ ...blockSource, blocks: blockSource.blocks.map(block => ({ ...block, citationIds: ['x'] })) }).map(use => use.feature), ['citations'], 'a block-level source is a use of citations');
});

test('each built-in format reports exactly what it cannot carry, and the report matches the output', async () => {
  const document = rich();
  const markdown = ok(markdownExporter.export(document)), html = ok(htmlExporter.export(document)), text = ok(textFormatExporter.export(document));
  assert.deepEqual(features(markdown.warnings), ['-underline', '-highlight', '~toggle', '-table-header-column', '~chart', '~card', '~embed', '~callout', '~metrics', '~timestamp', '~toc', '-page-format']);
  assert.deepEqual(features(html.warnings), ['~chart', '~card', '~embed', '-page-format']);
  assert.deepEqual(features(text.warnings), ['-underline', '-highlight', '-strike', '-inline-code', '-hyperlink', '~toggle', '-table-alignment', '-table-header-column', '~chart', '~card', '~embed', '~image', '~callout', '~metrics', '~toc', '~page-break', '-page-format']);
  // What is carried is really in the output; what is dropped is really not.
  const markdownText = markdown.data as string, htmlText = html.data as string, plain = text.data as string;
  assert.match(markdownText, /~~strike~~/); assert.match(markdownText, /\[\^src-method\]: /); assert.match(markdownText, /- \[x\] Draft/);
  assert.doesNotMatch(markdownText, /<u>|<mark/);
  assert.match(htmlText, /<u>Underline<\/u>/); assert.match(htmlText, /<mark data-highlight="yellow">/); assert.match(htmlText, /<details/); assert.match(htmlText, /<nav[^>]*class="toc"/); assert.match(htmlText, /type="checkbox"/);
  assert.match(plain, /\[1\]/); assert.doesNotMatch(plain, /https:\/\/example\.com\/page/, 'a dropped link target is not in the text');
  assert.equal(htmlText, ok(htmlExporter.export(document)).data, 'deterministic');
  // Every warning says which blocks, how many, where, and what to do.
  for (const warning of [...markdown.warnings, ...html.warnings, ...text.warnings]) {
    assert.ok(warning.hint.length > 10 && warning.message && warning.feature && warning.count! >= 1 && warning.path, JSON.stringify(warning));
    assert.ok(warning.blockIds === undefined || (warning.blockIds.length >= 1 && warning.blockIds.length <= 20));
  }
  assert.deepEqual(markdown.warnings.find(warning => warning.feature === 'underline'), { code: 'feature-dropped', feature: 'underline', count: 1, message: 'underline is not carried (1 use).', hint: 'Markdown has no underline. Use bold or italic where the emphasis matters.', blockIds: ['marks-extra'], path: 'document.blocks[9]' });
  assert.equal(lossWarnings(documentWith(b.paragraph('p', 'text')), {}).length, 0);
});

test('a document that only uses what a format carries exports with no warnings', () => {
  const document = documentWith(b.heading('h', 2, 'Heading'), b.paragraph('p', 'Plain **bold** text'), b.list('l', ['a', 'b']), b.table('t', ['x'], [['1']]), b.code('c', 'ts', 'x'));
  for (const exporter of [markdownExporter, htmlExporter, textFormatExporter]) assert.deepEqual(ok(exporter.export(document)).warnings, [], exporter.id);
});

test('options are checked: unknown names and wrong types are refused with the valid names', () => {
  const document = documentWith();
  for (const [options, path] of [[{ titel: false }, 'options.titel'], [{ title: 'no' }, 'options.title'], [{ chartRows: -1 }, 'options.chartRows'], [{ chartRows: 1.5 }, 'options.chartRows']] as const) {
    const result = markdownExporter.export(document, options as never) as Extract<ExportResult, { ok: false }>;
    assert.equal(result.ok, false); assert.equal(result.issues[0]?.path, path); assert.equal(result.issues[0]?.code, 'validation'); assert.ok(result.issues[0]?.hint);
  }
  assert.match((markdownExporter.export(document, { titel: false } as never) as Extract<ExportResult, { ok: false }>).issues[0]!.hint!, /Valid options: title, chartRows/);
  assert.equal((htmlExporter.export(document, 'x' as never) as Extract<ExportResult, { ok: false }>).issues[0]?.message, 'Options must be an object.');
  assert.equal(ok(htmlExporter.export(document, { standalone: true })).data.toString().startsWith('<!doctype html>'), true);
  const invalid = markdownExporter.export({ ...document, schemaVersion: 2 } as never) as Extract<ExportResult, { ok: false }>;
  assert.equal(invalid.ok, false); assert.equal(invalid.issues[0]?.code, 'validation'); assert.ok(invalid.issues[0]?.hint, 'a bad document is an issue with a hint, not a thrown error');
});

test('the registry lists formats, runs them, and refuses what is wrong', async () => {
  const registry = createFormatRegistry();
  registry.addExporter(markdownExporter); registry.addExporter(htmlExporter); registry.addImporter(markdownImporter);
  assert.deepEqual(registry.exporters().map(info => [info.id, info.ext, info.mime]), [['markdown', 'md', 'text/markdown; charset=utf-8'], ['html', 'html', 'text/html; charset=utf-8']]);
  assert.deepEqual(registry.importers().map(info => [info.id, info.extensions]), [['markdown', ['md', 'markdown']]]);
  assert.ok(Object.keys(registry.importers()[0]!.losses).length >= 5);
  assert.throws(() => registry.addExporter(markdownExporter), /already registered/);
  assert.throws(() => registry.addImporter({ ...markdownImporter, extensions: [] }), /already registered/);
  assert.throws(() => registry.addExporter({ ...markdownExporter, id: 'Bad Id' }), /lowercase letters/);
  assert.throws(() => createFormatRegistry().addImporter({ ...markdownImporter, extensions: [] }), /at least one file extension/);
  const exported = await registry.export('markdown', documentWith(b.paragraph('p', 'hello')), { title: false });
  assert.equal(ok(exported).data, 'hello\n');
  const missing = await registry.export('docx', documentWith()) as Extract<ExportResult, { ok: false }>;
  assert.equal(missing.issues[0]?.code, 'not-found'); assert.match(missing.issues[0]!.hint!, /Registered exporters: markdown, html/);
  assert.equal((await createFormatRegistry().export('x', documentWith()) as Extract<ExportResult, { ok: false }>).issues[0]?.hint?.includes('addExporter'), true);
  const invalid = await registry.export('markdown', { not: 'a document' }) as Extract<ExportResult, { ok: false }>;
  assert.equal(invalid.ok, false); assert.equal(invalid.issues[0]?.code, 'validation');
  assert.equal(registry.importerForFile('Report.MD')?.id, 'markdown'); assert.equal(registry.importerForFile('report.docx'), undefined); assert.equal(registry.importerForFile('README'), undefined);
  const imported = await registry.import('markdown', '# Imported\n\nText', { id: 'imp' });
  assert.equal(imported.ok, true);
  assert.equal((await registry.import('nope', '', { id: 'x' }) as { ok: false; issues: { code: string }[] }).issues[0]?.code, 'not-found');
  // A format that throws is a result, not a crash, and the message says whose fault it is.
  const throwing: Exporter = { id: 'boom', label: 'Boom', mime: 'x/y', ext: 'x', capabilities: [], fidelity: {}, export() { throw new Error('kaput'); } };
  registry.addExporter(throwing);
  const crashed = await registry.export('boom', documentWith()) as Extract<ExportResult, { ok: false }>;
  assert.equal(crashed.ok, false); assert.match(crashed.issues[0]!.message, /kaput/); assert.match(crashed.issues[0]!.hint!, /format package/);
});

test('an async exporter works through the registry the same way', async () => {
  const registry = createFormatRegistry();
  registry.addExporter({ id: 'slow', label: 'Slow', mime: 'application/x-slow', ext: 'slow', capabilities: [], fidelity: {}, async export(document) { await Promise.resolve(); return { ok: true, data: new TextEncoder().encode(document.title), mime: 'application/x-slow', ext: 'slow', warnings: [] }; } });
  const result = ok(await registry.export('slow', documentWith()));
  assert.deepEqual([...result.data as Uint8Array], [...new TextEncoder().encode('Doc')]);
});

// ---- Markdown import -----------------------------------------------------------------------------------------------

const importMarkdown = (source: string | Uint8Array, options: { id?: string; title?: string; idPrefix?: string } = {}) => markdownImporter.import(source, { id: options.id ?? 'imported', now, ...options });
const imported = (source: string, options = {}) => { const result = importMarkdown(source, options); assert.equal(result.ok, true, JSON.stringify(result)); return result as Extract<ReturnType<typeof importMarkdown>, { ok: true }>; };

test('a Markdown import builds a valid document, takes the title from the first # heading, and has no warnings when nothing is lost', () => {
  const result = imported('\n# Weekly note\n\nIntro with **bold** and a [link](https://example.com/a).\n\n## Findings\n\n- one\n- two\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n');
  assert.equal(result.document.title, 'Weekly note'); assert.equal(result.document.id, 'imported');
  assert.deepEqual(result.document.blocks.map(block => block.content.type), ['paragraph', 'heading', 'list', 'table', 'code']);
  assert.deepEqual(result.document.blocks.map(block => block.id), ['md-1', 'md-2', 'md-3', 'md-4', 'md-5']);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.document.createdAt, at); assert.equal(result.document.revision, 1);
  assert.equal(imported('Text only', { title: 'Given' }).document.title, 'Given', 'options.title wins and the first line stays a block');
  assert.equal(imported('# One\n\n# Two').document.blocks[0]?.content.type, 'heading', 'only the first heading is the title');
  assert.equal(imported('', { title: 'Empty' }).document.blocks.length, 0);
  assert.equal(imported('﻿# Bom title').document.title, 'Bom title');
  assert.equal(imported('# Bytes\n\n你好，世界', {}).document.blocks.length, 1);
  assert.equal((importMarkdown(new TextEncoder().encode('# Bytes\n\n你好，世界')) as { ok: true; document: ResearchDocument }).document.blocks[0]?.content.type, 'paragraph');
  assert.equal(imported('Body', { title: 'T', idPrefix: 'n' }).document.blocks[0]?.id, 'n-1');
});

test('a Markdown import refuses bad input visibly: no title, bad bytes, bad options, text that is not valid', () => {
  const fail = (result: ReturnType<typeof importMarkdown>) => { assert.equal(result.ok, false); return (result as Extract<typeof result, { ok: false }>).issues[0]!; };
  assert.deepEqual([fail(importMarkdown('no heading here')).path, fail(importMarkdown('no heading here')).code], ['options.title', 'validation']);
  assert.match(fail(importMarkdown('no heading here')).hint!, /Pass options\.title/);
  assert.equal(fail(importMarkdown('#\n\ntext')).path, 'options.title', 'an empty heading is not a title');
  assert.match(fail(importMarkdown(new Uint8Array([0x23, 0x20, 0xff, 0xfe]), { title: 't' })).message, /not valid UTF-8/);
  assert.equal(fail(markdownImporter.import('x', { id: 'a', title: 't', colour: 'red' } as never)).path, 'options.colour');
  assert.equal(fail(markdownImporter.import('x', { title: 't' } as never)).path, 'options.id');
  assert.equal(fail(importMarkdown('x', { title: 't', idPrefix: '--' })).path, 'options.idPrefix');
  assert.equal(fail(importMarkdown('x', { title: 't', id: 'has space' })).path, 'options');
  assert.match(fail(importMarkdown('lone \ud800 surrogate', { title: 't' })).message, /unpaired surrogate/);
  assert.equal(fail(importMarkdown('x\n\n'.repeat(5_001), { title: 't' })).code, 'validation', 'too many blocks is an issue, not a crash');
});

test('a Markdown import reports every construct the editor cannot hold, with count and first line', () => {
  const source = ['# Title', '', 'Intro <b>inline html is not detected</b>', '', '<div>block html</div>', '', '<!-- comment -->', '', 'Setext', '======', '', 'Dashed', '------', '', '#### Deep', '###### Deeper', '', 'Claim[^1] and[^2].', '', '[^1]: First source', '', '- item **bold**', '- plain', '- a [link](https://example.com)', '', '| a | b |', '|---|---|', '| *x* | y |', '| z | w |', '', '![pic](http://example.com/a.png)', '', '```', '# not a heading <div> [^3] **x**', '```', '', '- ok', ''].join('\n');
  const result = imported(source), byCode = new Map(result.warnings.map(warning => [warning.code, warning]));
  assert.deepEqual([...byCode.keys()], ['markdown-html-kept-as-text', 'markdown-setext-heading-kept-as-text', 'markdown-heading-level-clamped', 'markdown-footnotes-kept-as-text', 'markdown-inline-formatting-flattened', 'markdown-image-kept-as-text']);
  const facts = (code: string) => [byCode.get(code)?.count, byCode.get(code)?.path];
  assert.deepEqual(facts('markdown-html-kept-as-text'), [2, 'line 5'], 'line numbers are the source lines, counting the title line');
  assert.deepEqual(facts('markdown-setext-heading-kept-as-text'), [2, 'line 10']);
  assert.deepEqual(facts('markdown-heading-level-clamped'), [2, 'line 15']);
  assert.deepEqual(facts('markdown-footnotes-kept-as-text'), [3, 'line 18'], 'two markers and one definition');
  assert.deepEqual(facts('markdown-inline-formatting-flattened'), [3, 'line 22'], 'two list items and one table row; code fences and plain items are not counted');
  assert.deepEqual(facts('markdown-image-kept-as-text'), [1, 'line 31']);
  for (const warning of result.warnings) assert.equal(warning.hint, (markdownImporter.losses as Record<string, string>)[warning.code], 'a warning carries the hint the importer publishes up front');
  // What it says it keeps as text is really text, with the markers intact and no citation invented.
  assert.equal(result.document.citations.length, 0);
  const paragraphs = result.document.blocks.filter(block => block.content.type === 'paragraph').map(block => (block.content as { runs: { text: string; citationId?: string }[] }).runs.map(run => run.text).join(''));
  assert.ok(paragraphs.includes('Claim[^1] and[^2].') && paragraphs.includes('[^1]: First source'));
  assert.equal(result.document.blocks.filter(block => block.content.type === 'heading').every(block => (block.content as { level: number }).level <= 3), true);
});

test('Markdown round trip: a document that uses only what Markdown carries comes back identical in a second pass', () => {
  const editor = createEditor(createDocument({ id: 'doc', title: 'Round trip' }, { now }), { now });
  const result = editor.apply({ id: 'seed', actor: { id: 'test', kind: 'system' }, baseRevision: 0, operations: [{ type: 'insertBlocks', blocks: [
    b.heading('h1', 1, 'Intro'), b.paragraph('p1', 'A **bold** claim with `code`, ~~strike~~ and a [link](https://example.com/x).'),
    b.list('l1', ['one', 'two', 'three'], { indent: [0, 1, 0], style: 'number' }), b.list('l2', ['done', 'todo'], { checked: [true, false] }),
    b.table('t1', ['Name', 'Value'], [['a', '1'], ['b', '2']], { align: ['left', 'right'] }), b.quote('q1', 'Quoted text', { attribution: 'Someone' }),
    b.code('c1', 'ts', 'const x = 1;'), b.divider('d1'), b.pageBreak('pb1'), b.image('i1', 'https://example.com/a.png', 'A picture'),
    b.callout('co1', 'warning', 'Careful', { title: 'Heads up' }),
  ] }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const original = editor.getSnapshot(), first = ok(markdownExporter.export(original));
  assert.deepEqual(features(first.warnings), ['~callout'], 'the callout is the only thing a plain Markdown renderer shows differently (it round trips through this importer)');
  const again = imported(first.data as string, { id: 'doc' });
  assert.deepEqual(again.warnings, []);
  assert.equal(again.document.title, 'Round trip');
  assert.deepEqual(again.document.blocks.map(block => block.content.type), original.blocks.map(block => block.content.type));
  assert.equal(toMarkdown(again.document), first.data, 'export, import, export is a fixed point');
  assert.equal(toPlainText(again.document), toPlainText(original));
});

test('Markdown round trip: what the export warned about is what the second pass no longer has', () => {
  const document = rich(), first = ok(markdownExporter.export(document)), again = imported(first.data as string, { id: 'again' });
  const feature = (document: ResearchDocument, name: DocumentFeature) => scanFeatures(document).some(use => use.feature === name);
  for (const dropped of ['underline', 'highlight'] as const) { assert.equal(feature(document, dropped), true); assert.equal(feature(again.document, dropped), false, `${dropped} was reported dropped and is gone`); }
  for (const degraded of ['chart', 'card', 'embed', 'metrics', 'timestamp', 'toc', 'toggle'] as const) assert.equal(feature(again.document, degraded), false, `${degraded} came back as plain blocks, not as the original`);
  const reexport = ok(markdownExporter.export(again.document));
  assert.ok(!features(reexport.warnings).includes('-underline'), 'the second export has nothing left to warn about for the dropped features');
  assert.ok(again.document.blocks.length >= 20, 'the content survives as readable blocks');
  assert.ok(again.warnings.some(warning => warning.code === 'markdown-footnotes-kept-as-text'), 'the citations the export wrote as footnotes are reported as not re-imported');
});
