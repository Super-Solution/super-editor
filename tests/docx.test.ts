import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { b, chart, createDocument, createEditor, createFormatRegistry, type ExportResult, type FormatWarning, type ResearchDocument } from '../packages/core/src/index.js';
import { DOCX_FIDELITY, DOCX_MIME, docxExporter, exportDocx, type DocxOptions } from '../packages/formats/docx/src/index.js';
import { readZip } from '../packages/formats/opc/src/index.js';
import { createAllBlocksExample } from '../examples/all-blocks.js';

const at = '2026-10-05T12:30:45.678Z';
const now = () => at;
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);
const rich = (): ResearchDocument => ({ ...createAllBlocksExample().getSnapshot(), format: { page: 'A4', font: 'sans', fontSize: 16, lineHeight: 1.6 } });
function documentWith(blocks: ReturnType<typeof b.paragraph>[], configure?: (document: ResearchDocument) => ResearchDocument, citations: ResearchDocument['citations'] = []): ResearchDocument {
  const editor = createEditor(createDocument({ id: 'doc', title: 'Doc' }, { now }), { now });
  const operations = [...citations.map(citation => ({ type: 'addCitation' as const, citation })), ...Array.from({ length: Math.ceil(blocks.length / 500) }, (_, chunk) => ({ type: 'insertBlocks' as const, blocks: blocks.slice(chunk * 500, chunk * 500 + 500) }))];
  if (operations.length) { const result = editor.apply({ id: 'seed', actor: { id: 'test', kind: 'system' }, baseRevision: 0, operations }); assert.equal(result.ok, true, JSON.stringify(result)); }
  const snapshot = editor.getSnapshot();
  return configure ? configure(snapshot) : snapshot;
}
async function build(document: ResearchDocument, options?: DocxOptions): Promise<{ files: Map<string, Uint8Array>; data: Uint8Array; warnings: FormatWarning[]; xml: (name: string) => Document; body: Document }> {
  const result = await exportDocx(document, options);
  assert.equal(result.ok, true, JSON.stringify(result));
  const ok = result as Extract<ExportResult, { ok: true }>, files = await readZip(ok.data as Uint8Array);
  const xml = (name: string): Document => { const dom = new JSDOM(decode(files.get(name)), { contentType: 'application/xml' }); assert.equal(dom.window.document.querySelector('parsererror'), null, `${name} is well-formed XML`); return dom.window.document; };
  return { files, data: ok.data as Uint8Array, warnings: ok.warnings, xml, body: xml('word/document.xml') };
}
const elements = (document: Document | Element, name: string): Element[] => [...document.getElementsByTagName(name)];
const attr = (element: Element, name: string): string | null => element.getAttribute(name);
const paragraphText = (paragraph: Element): string => elements(paragraph, 'w:t').map(node => node.textContent).join('');
const paragraphs = (body: Document): { style: string | null; text: string; element: Element }[] => elements(body, 'w:p').map(element => ({ style: elements(element, 'w:pStyle')[0]?.getAttribute('w:val') ?? null, text: paragraphText(element), element }));
const failure = async (document: ResearchDocument, options: unknown): Promise<Extract<ExportResult, { ok: false }>> => { const result = await exportDocx(document, options as DocxOptions); assert.equal(result.ok, false); return result as Extract<ExportResult, { ok: false }>; };

// The order Word's schema requires for the children of these elements. Word refuses or repairs files that break it.
const ORDER: Record<string, string[]> = {
  'w:pPr': ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'widowControl', 'numPr', 'pBdr', 'shd', 'tabs', 'spacing', 'ind', 'contextualSpacing', 'jc', 'outlineLvl', 'rPr', 'sectPr'],
  'w:rPr': ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'strike', 'color', 'spacing', 'sz', 'szCs', 'highlight', 'u', 'shd', 'vertAlign', 'lang'],
  'w:tblPr': ['tblStyle', 'tblW', 'jc', 'tblInd', 'tblBorders', 'shd', 'tblLayout', 'tblCellMar', 'tblLook'],
  'w:trPr': ['cantSplit', 'tblHeader'],
  'w:tcPr': ['tcW', 'gridSpan', 'vMerge', 'tcBorders', 'shd'],
  'w:sectPr': ['headerReference', 'footerReference', 'pgSz', 'pgMar'],
  'w:style': ['name', 'basedOn', 'next', 'uiPriority', 'semiHidden', 'unhideWhenUsed', 'qFormat', 'pPr', 'rPr', 'tblPr'],
  'w:lvl': ['start', 'numFmt', 'lvlText', 'lvlJc', 'pPr', 'rPr'],
  'w:settings': ['zoom', 'defaultTabStop', 'characterSpacingControl', 'compat'],
};
function assertSchemaOrder(document: Document, part: string): void {
  for (const [name, order] of Object.entries(ORDER)) for (const element of elements(document, name)) {
    const names = [...element.children].map(child => child.tagName.replace(/^w:/, '')), indexes = names.map(child => order.indexOf(child));
    assert.ok(!indexes.includes(-1), `${part}: <${name}> has a child outside the expected set: ${names.join(', ')}`);
    assert.deepEqual(indexes, [...indexes].sort((x, y) => x - y), `${part}: <${name}> children are out of schema order: ${names.join(', ')}`);
  }
}

test('the package is consistent: well-formed parts, a content type and a relationship target for everything, no dangling ids', async () => {
  const { files, xml, body } = await build(rich(), { header: 'Top', footer: '{page}/{pages}', author: 'A. Author' });
  assert.deepEqual([...files.keys()].slice(0, 2), ['[Content_Types].xml', '_rels/.rels']);
  const types = xml('[Content_Types].xml'), overrides = new Map(elements(types, 'Override').map(node => [attr(node, 'PartName')!.slice(1), attr(node, 'ContentType')!]));
  for (const name of files.keys()) if (!name.endsWith('.rels') && name !== '[Content_Types].xml') assert.ok(overrides.has(name), `${name} has a content type`);
  for (const name of overrides.keys()) assert.ok(files.has(name), `${name} exists`);
  assert.equal(overrides.get('word/document.xml'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml');
  const relsOf = (name: string): Map<string, Element> => new Map(elements(xml(name), 'Relationship').map(node => [attr(node, 'Id')!, node]));
  for (const [source, dir] of [['_rels/.rels', ''], ['word/_rels/document.xml.rels', 'word/']] as const) for (const rel of relsOf(source).values()) if (attr(rel, 'TargetMode') !== 'External') assert.ok(files.has(`${dir}${attr(rel, 'Target')}`), `${source}: ${attr(rel, 'Target')} exists`);
  const documentRels = relsOf('word/_rels/document.xml.rels');
  for (const link of elements(body, 'w:hyperlink')) {
    const id = attr(link, 'r:id');
    if (id) { assert.ok(documentRels.has(id), `link ${id} has a relationship`); assert.equal(attr(documentRels.get(id)!, 'TargetMode'), 'External'); assert.match(attr(documentRels.get(id)!, 'Target')!, /^https?:\/\//); }
  }
  const bookmarks = elements(body, 'w:bookmarkStart'), names = bookmarks.map(node => attr(node, 'w:name')!), ids = bookmarks.map(node => attr(node, 'w:id')!);
  assert.equal(new Set(names).size, names.length, 'bookmark names are unique'); assert.equal(new Set(ids).size, ids.length, 'bookmark ids are unique');
  assert.deepEqual(elements(body, 'w:bookmarkEnd').map(node => attr(node, 'w:id')).sort(), [...ids].sort());
  for (const name of names) assert.match(name, /^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'a legal Word bookmark name');
  for (const link of elements(body, 'w:hyperlink')) { const anchor = attr(link, 'w:anchor'); if (anchor) assert.ok(names.includes(anchor), `anchor ${anchor} resolves`); }
  const styleIds = new Set(elements(xml('word/styles.xml'), 'w:style').map(node => attr(node, 'w:styleId')));
  for (const part of ['word/document.xml', 'word/header1.xml', 'word/footer1.xml']) for (const node of [...elements(xml(part), 'w:pStyle'), ...elements(xml(part), 'w:rStyle'), ...elements(xml(part), 'w:tblStyle')]) assert.ok(styleIds.has(attr(node, 'w:val')), `${part}: style ${attr(node, 'w:val')} exists`);
  const numbering = xml('word/numbering.xml'), numIds = new Set(elements(numbering, 'w:num').map(node => attr(node, 'w:numId')));
  for (const node of elements(body, 'w:numId')) assert.ok(numIds.has(attr(node, 'w:val')), `numId ${attr(node, 'w:val')} is defined`);
  for (const part of files.keys()) if (part.endsWith('.xml') || part.endsWith('.rels')) xml(part);
  for (const part of ['word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/settings.xml', 'word/header1.xml', 'word/footer1.xml']) assertSchemaOrder(xml(part), part);
});

test('headings, sections, text, lists, tables and sources land in the Word structure they map to', async () => {
  const document = documentWith([
    b.section('s1', 'Section one'), b.heading('h1', 1, 'Heading under section', { parentId: 's1' }), b.section('s2', 'Nested section', { parentId: 's1' }), b.heading('h2', 2, 'Deep heading', { parentId: 's2' }),
    b.paragraph('p1', [{ text: 'Plain ' }, { text: 'bold', bold: true }, { text: ' ' }, { text: 'italic', italic: true }, { text: ' ' }, { text: 'struck', strike: true }, { text: ' ' }, { text: 'under', underline: true }, { text: ' ' }, { text: 'code', code: true }, { text: ' ' }, { text: 'linked', href: 'https://example.com/a?x=1&y=2' }, { text: ' ' }, { text: 'marked', highlight: 'yellow' }, { text: '', citationId: 'c1' }], { parentId: 's1' }),
    b.list('l1', ['one', 'two', 'three'], { style: 'number', indent: [0, 1, 0], parentId: 's1' }), b.list('l2', ['again', 'twice'], { ordered: true, parentId: 's1' }), b.list('l3', ['dot', 'dash'], { parentId: 's1' }), b.list('l4', ['done', 'open'], { checked: [true, false], parentId: 's1' }),
    b.table('t1', ['Name', 'Amount'], [['a', '1'], ['b', '2\nsecond line']], { align: ['left', 'right'], caption: 'A table', headerColumn: true, parentId: 's1' }),
    b.quote('q1', 'Quoted', { attribution: 'Someone', parentId: 's1' }), b.code('c1', 'ts', 'line 1\n  indented\n\nline 4', { parentId: 's1' }), b.divider('d1', { parentId: 's1' }), b.pageBreak('pb', { parentId: 's1' }),
  ], undefined, [{ id: 'c1', title: 'First source', url: 'https://example.org/one', accessedAt: at, publishedAt: '2026-09-01T00:00:00.000Z' }]);
  const { body, xml, warnings } = await build(document, { author: 'Writer' }), all = paragraphs(body);
  const heads = all.filter(entry => entry.style?.startsWith('Heading')).map(entry => [entry.style, entry.text]);
  assert.deepEqual(heads, [['Heading1', 'Section one'], ['Heading2', 'Heading under section'], ['Heading2', 'Nested section'], ['Heading4', 'Deep heading'], ['Heading1', 'Sources']]);
  assert.equal(all[0]?.style, 'Title'); assert.equal(all[0]?.text, 'Doc');
  const run = (text: string): Element => elements(body, 'w:r').find(element => paragraphText(element) === text)!;
  const flags = (text: string): string[] => [...elements(run(text), 'w:rPr')[0]?.children ?? []].map(child => child.tagName);
  assert.ok(flags('bold').includes('w:b')); assert.ok(flags('italic').includes('w:i')); assert.ok(flags('struck').includes('w:strike')); assert.ok(flags('under').includes('w:u')); assert.ok(flags('code').includes('w:rFonts'));
  assert.equal(attr(elements(run('marked'), 'w:shd')[0]!, 'w:fill'), 'FFF3A3'); assert.ok(flags('linked').includes('w:rStyle'));
  const link = elements(body, 'w:hyperlink').find(node => paragraphText(node) === 'linked')!;
  assert.equal(attr(elements(xml('word/_rels/document.xml.rels'), 'Relationship').find(node => attr(node, 'Id') === attr(link, 'r:id'))!, 'Target'), 'https://example.com/a?x=1&y=2');
  const marker = elements(body, 'w:hyperlink').find(node => paragraphText(node) === '[1]')!;
  assert.equal(attr(marker, 'w:anchor'), 'se_cite_1'); assert.equal(attr(elements(marker, 'w:vertAlign')[0]!, 'w:val'), 'superscript');
  const source = all.find(entry => entry.style === 'SourceEntry')!;
  assert.equal(source.text, '[1] First source — accessed 2026-10-05, published 2026-09-01');
  assert.ok(elements(source.element, 'w:bookmarkStart').some(node => attr(node, 'w:name') === 'se_cite_1'));
  // Lists: bullets share a definition, each numbered list restarts, nesting is the level, to-do items are characters.
  const numbered = all.filter(entry => entry.element.getElementsByTagName('w:numId').length), numOf = (text: string): [string, string] => { const node = numbered.find(entry => entry.text === text)!.element; return [attr(elements(node, 'w:numId')[0]!, 'w:val')!, attr(elements(node, 'w:ilvl')[0]!, 'w:val')!]; };
  assert.deepEqual([numOf('one'), numOf('two'), numOf('three')], [['2', '0'], ['2', '1'], ['2', '0']]);
  assert.deepEqual([numOf('again')[0], numOf('twice')[0]], ['3', '3']); assert.deepEqual([numOf('dot')[0], numOf('dash')[0]], ['1', '1']);
  const numbering = xml('word/numbering.xml'), nums = elements(numbering, 'w:num');
  assert.deepEqual(nums.map(node => attr(node, 'w:numId')), ['1', '2', '3']);
  assert.equal(elements(nums[1]!, 'w:startOverride').length, 4, 'a numbered list restarts at 1 at every level');
  assert.deepEqual(all.filter(entry => /^[☐☑]/.test(entry.text)).map(entry => entry.text), ['☑done', '☐open']);
  // Table: header row repeats, alignment, header column bold, multi-line cell, caption after.
  const table = elements(body, 'w:tbl')[0]!, rows = elements(table, 'w:tr');
  assert.equal(rows.length, 3); assert.ok(elements(rows[0]!, 'w:tblHeader').length === 1 && elements(rows[1]!, 'w:tblHeader').length === 0);
  assert.deepEqual(rows.map(row => elements(row, 'w:tc').map(cell => paragraphText(cell))), [['Name', 'Amount'], ['a', '1'], ['b', '2second line']]);
  assert.equal(elements(rows[2]!, 'w:br').length, 1, 'a newline in a cell is a line break');
  assert.equal(attr(elements(rows[1]!, 'w:jc')[0]!, 'w:val'), 'right');
  assert.ok(elements(rows[1]!, 'w:tc')[0]!.getElementsByTagName('w:b').length === 1, 'the header column is bold');
  assert.equal(all.find(entry => entry.style === 'Caption')?.text, 'A table');
  assert.equal(elements(body, 'w:br').filter(node => attr(node, 'w:type') === 'page').length, 1);
  // Code: one paragraph per line, blank lines kept, spaces preserved.
  const code = all.filter(entry => entry.style === 'CodeBlock').map(entry => entry.text);
  assert.deepEqual(code, ['line 1', '  indented', '', 'line 4']);
  assert.ok(elements(body, 'w:t').every(node => attr(node, 'xml:space') === 'preserve'));
  assert.deepEqual(warnings.map(warning => warning.feature), ['todo-list']);
});

test('what the fidelity table calls degraded is what the file really contains', async () => {
  const document = rich(), { warnings, files, body } = await build(document);
  assert.deepEqual(warnings.map(warning => `${warning.code}:${warning.feature}`), ['feature-degraded:toggle', 'feature-degraded:todo-list', 'feature-degraded:chart', 'feature-degraded:card', 'feature-degraded:embed', 'feature-degraded:image', 'feature-degraded:metrics', 'feature-degraded:timestamp', 'feature-degraded:toc']);
  assert.deepEqual(warnings.map(warning => warning.feature).sort(), Object.keys(DOCX_FIDELITY).sort(), 'the table and the sample agree');
  assert.equal(elements(body, 'w:drawing').length + elements(body, 'w:pict').length + elements(body, 'w:sdt').length, 0, 'no pictures, no checkboxes, no content controls');
  assert.ok([...files.keys()].every(name => !name.startsWith('word/media/')), 'nothing is embedded');
  const text = paragraphs(body).map(entry => entry.text);
  assert.ok(text.includes('[Image: A sample chart image] https://example.com/images/sample-chart.png'));
  assert.ok(text.some(entry => entry.startsWith('Rebased performance (line chart')));
  assert.ok(text.includes('BTC daily price, drawn live by the Super Chart card when the host provides it.'), 'a card is its alt text');
  assert.ok(elements(body, 'w:hyperlink').some(node => attr(node, 'w:anchor')?.startsWith('se_h') && paragraphText(node) === 'Charts'), 'the table of contents links to headings');
  for (const warning of warnings) assert.ok(warning.hint.length > 15 && warning.count! >= 1 && warning.blockIds!.length >= 1 && warning.path);
  assert.deepEqual((await build(documentWith([b.paragraph('p', 'plain')]))).warnings, [], 'nothing lost, nothing reported');
});

test('page setup: paper from the document, the options win, screen gets A4, landscape and margins', async () => {
  const section = async (document: ResearchDocument, options?: DocxOptions) => { const { body, warnings } = await build(document, options); const size = elements(body, 'w:pgSz')[0]!, margin = elements(body, 'w:pgMar')[0]!; return { size: [attr(size, 'w:w'), attr(size, 'w:h'), attr(size, 'w:orient')], margins: ['w:top', 'w:right', 'w:bottom', 'w:left'].map(name => attr(margin, name)), warnings }; };
  const withPage = (page: 'screen' | 'A4' | 'letter') => (document: ResearchDocument): ResearchDocument => ({ ...document, format: { ...document.format, page } });
  assert.deepEqual((await section(documentWith([], withPage('A4')))).size, ['11906', '16838', null]);
  assert.deepEqual((await section(documentWith([], withPage('letter')))).size, ['12240', '15840', null]);
  const screen = await section(documentWith([], withPage('screen')));
  assert.deepEqual(screen.size, ['11906', '16838', null]); assert.deepEqual(screen.warnings, [], 'a default of A4 for a screen document is a default, not a loss');
  const chosen = await section(documentWith([], withPage('screen')), { page: { size: 'letter' } });
  assert.deepEqual(chosen.size, ['12240', '15840', null]); assert.deepEqual(chosen.warnings, []);
  assert.deepEqual((await section(documentWith([], withPage('A4')), { page: { size: 'letter' } })).size, ['12240', '15840', null], 'the option wins over the document');
  assert.deepEqual((await section(documentWith([], withPage('A4')), { page: { orientation: 'landscape' } })).size, ['16838', '11906', 'landscape']);
  assert.deepEqual((await section(documentWith([], withPage('A4')), { page: { size: { widthMm: 100, heightMm: 200 } } })).size, ['5669', '11339', null]);
  assert.deepEqual((await section(documentWith([]), { page: { marginsMm: { left: 20, top: 10 } } })).margins, ['567', '1440', '1440', '1134']);
  const tooWide = await failure(documentWith([]), { page: { marginsMm: { left: 100, right: 100 } } });
  assert.equal(tooWide.issues[0]?.path, 'options.page.marginsMm'); assert.ok(tooWide.issues[0]?.hint);
});

test('headers, footers and fields: tokens become Word fields, text is escaped, parts are wired to the section', async () => {
  const { xml, body, files } = await build(documentWith([b.paragraph('p', 'x')], document => ({ ...document, title: 'A & B <title>' })), { header: { text: 'Left {title}', align: 'right' }, footer: 'Page {page} of {pages} & more' });
  const header = xml('word/header1.xml'), footer = xml('word/footer1.xml');
  assert.equal(paragraphText(elements(header, 'w:p')[0]!), 'Left A & B <title>'); assert.equal(attr(elements(header, 'w:jc')[0]!, 'w:val'), 'right');
  assert.deepEqual(elements(footer, 'w:fldSimple').map(node => attr(node, 'w:instr')), [' PAGE ', ' NUMPAGES ']); assert.equal(attr(elements(footer, 'w:jc')[0]!, 'w:val'), 'center', 'footers default to centered');
  const rels = new Map(elements(xml('word/_rels/document.xml.rels'), 'Relationship').map(node => [attr(node, 'Id')!, attr(node, 'Target')!]));
  const references = elements(body, 'w:sectPr')[0]!.children;
  assert.deepEqual([...references].slice(0, 2).map(node => [node.tagName, rels.get(attr(node, 'r:id')!)]), [['w:headerReference', 'header1.xml'], ['w:footerReference', 'footer1.xml']]);
  assert.ok(files.has('word/header1.xml'));
  assert.equal([...(await build(documentWith([]))).files.keys()].some(name => name.includes('header') || name.includes('footer')), false, 'no header or footer part unless asked for');
});

test('text is carried exactly: Chinese, emoji, spaces, tabs, line breaks, and characters XML cannot hold are reported', async () => {
  const document = documentWith([b.paragraph('p', [{ text: '  律識：合約審閱 😀 ' }, { text: 'tab\there\nnew line', bold: true }, { text: ' bell\u0007char and \u0000nul' }]), b.paragraph('q', [{ text: 'trailing ' }])]);
  const { body, warnings } = await build({ ...document, title: '標題 📄' });
  const [title, first, second] = paragraphs(body);
  assert.equal(title?.text, '標題 📄'); assert.equal(first?.text, '  律識：合約審閱 😀 tabhere\u0000'.slice(0, 0) + '  律識：合約審閱 😀 tabherenew line bell\ufffdchar and \ufffdnul'); assert.equal(second?.text, 'trailing ');
  assert.equal(elements(first!.element, 'w:tab').length, 1); assert.equal(elements(first!.element, 'w:br').length, 1);
  const invalid = warnings.find(warning => warning.code === 'invalid-xml-characters')!;
  assert.equal(invalid.count, 2); assert.match(invalid.hint, /control characters/);
});

test('charts keep their data and say when rows were cut; labels, fonts, language and properties follow the options', async () => {
  const labels = Array.from({ length: 12 }, (_, index) => `L${index + 1}`);
  const document = documentWith([b.chart('c', chart.line({ title: 'Long series', labels, values: labels.map((_, index) => index) })), b.metrics('m', [{ label: 'Return', value: '1%', change: 1.5, hint: 'ytd' }]), b.image('i', 'https://example.com/a.png', 'Alt', { caption: 'Cap' })]);
  const options: DocxOptions = { chartRows: 5, language: 'zh-TW', eastAsiaLanguage: 'zh-TW', fonts: { sans: 'Arial', mono: 'Courier New', eastAsia: 'PMingLiU' }, author: 'Someone', labels: { moreRows: '另有 {count} 列', image: '圖', metric: '指標', value: '數值', change: '變化', note: '備註' } };
  const { body, warnings, xml } = await build(document, options), texts = paragraphs(body).map(entry => entry.text);
  assert.ok(texts.includes('另有 7 列')); assert.ok(texts.includes('[圖: Alt] https://example.com/a.png'));
  assert.deepEqual(elements(elements(body, 'w:tbl')[1]!, 'w:tr')[0] ? [...elements(elements(body, 'w:tbl')[1]!, 'w:tr')[0]!.getElementsByTagName('w:tc')].map(paragraphText) : [], ['指標', '數值', '變化', '備註']);
  const cut = warnings.find(warning => warning.code === 'chart-rows-omitted')!;
  assert.deepEqual([cut.count, cut.blockIds], [1, ['c']]); assert.match(cut.message, /7 rows left out/);
  const styles = xml('word/styles.xml'), defaults = elements(styles, 'w:rPrDefault')[0]!;
  assert.deepEqual(['w:ascii', 'w:eastAsia'].map(name => attr(elements(defaults, 'w:rFonts')[0]!, name)), ['Arial', 'PMingLiU']);
  assert.deepEqual(['w:val', 'w:eastAsia'].map(name => attr(elements(defaults, 'w:lang')[0]!, name)), ['zh-TW', 'zh-TW']);
  assert.equal(attr(elements(elements(styles, 'w:style').find(node => attr(node, 'w:styleId') === 'CodeBlock')!, 'w:rFonts')[0]!, 'w:ascii'), 'Courier New');
  assert.equal(attr(elements(defaults, 'w:sz')[0]!, 'w:val'), '24', '16 px is 12 pt, 24 half-points');
  const core = (await build(document, options)).xml('docProps/core.xml');
  assert.equal(elements(core, 'dc:title')[0]?.textContent, 'Doc'); assert.equal(elements(core, 'dc:creator')[0]?.textContent, 'Someone');
  assert.equal(elements(core, 'dcterms:created')[0]?.textContent, '2026-10-05T12:30:45Z'); assert.equal(elements(core, 'dcterms:modified')[0]?.textContent, '2026-10-05T12:30:45Z');
  assert.equal(elements((await build(document)).xml('docProps/core.xml'), 'dc:creator').length, 0, 'no author is invented');
  const serif = await build({ ...document, format: { ...document.format, font: 'serif', fontSize: 20, lineHeight: 2 } });
  assert.equal(attr(elements(serif.xml('word/styles.xml'), 'w:rFonts')[0]!, 'w:ascii'), 'Times New Roman'); assert.equal(attr(elements(serif.xml('word/styles.xml'), 'w:spacing')[0]!, 'w:line'), '480');
});

test('the title can be left out, deflate can be turned off, the bytes are deterministic, and the result is a registry format', async () => {
  const document = documentWith([b.paragraph('p', 'hello '.repeat(200))]);
  assert.equal(paragraphs((await build(document, { title: false })).body)[0]?.text.startsWith('hello'), true);
  const first = await build(document), second = await build(document), stored = await build(document, { compress: false });
  assert.deepEqual([...first.data], [...second.data]); assert.ok(stored.data.length > first.data.length);
  assert.equal(first.data[0], 0x50); assert.equal(first.data[1], 0x4b);
  const registry = createFormatRegistry(); registry.addExporter(docxExporter);
  const result = await registry.export('docx', document);
  assert.equal(result.ok, true); const ok = result as Extract<ExportResult, { ok: true }>;
  assert.deepEqual([ok.mime, ok.ext, docxExporter.capabilities], [DOCX_MIME, 'docx', ['tables', 'numbering', 'page-layout']]); assert.deepEqual([...ok.data as Uint8Array], [...first.data]);
  assert.equal(registry.exporters()[0]?.fidelity, DOCX_FIDELITY);
});

test('bad options and bad documents are refused with every problem at once, each with a path and a hint', async () => {
  const document = documentWith([]);
  const result = await failure(document, { titel: true, title: 'yes', language: 'not a language', chartRows: -1, fonts: { sans: '', bold: 'x' }, labels: { nope: 'x' }, header: { text: 1, align: 'middle' }, page: { size: 'A5', orientation: 'tilted', marginsMm: { top: -1 } } });
  assert.deepEqual(result.issues.map(issue => issue.path).sort(), ['options.chartRows', 'options.fonts.bold', 'options.fonts.sans', 'options.header.align', 'options.header.text', 'options.labels.nope', 'options.language', 'options.page.marginsMm.top', 'options.page.orientation', 'options.page.size', 'options.title', 'options.titel'].sort());
  for (const issue of result.issues) { assert.equal(issue.code, 'validation'); assert.ok(issue.hint && issue.message); }
  assert.match(result.issues.find(issue => issue.path === 'options.titel')!.hint!, /Valid fields: title, author/);
  assert.equal((await failure(document, 'x')).issues[0]?.path, 'options');
  const invalid = await failure({ ...document, schemaVersion: 2 } as never, undefined);
  assert.equal(invalid.issues[0]?.code, 'validation'); assert.ok(invalid.issues[0]?.hint);
  assert.equal((await failure(document, { page: { size: { widthMm: 10, heightMm: 200 } } })).issues[0]?.path, 'options.page.size.widthMm');
});

test('a large document exports in reasonable time and size', async () => {
  const blocks = Array.from({ length: 3_000 }, (_, index) => index % 3 === 0 ? b.heading(`h${index}`, 2, `Heading ${index}`) : index % 3 === 1 ? b.paragraph(`p${index}`, `Paragraph ${index} with **bold** and a [link](https://example.com/${index}).`) : b.table(`t${index}`, ['a', 'b'], [['1', '2'], ['3', '4']]));
  const started = performance.now(), { data } = await build(documentWith(blocks));
  assert.ok(performance.now() - started < 5_000, `3 000 blocks took ${Math.round(performance.now() - started)} ms`);
  assert.ok(data.length < 200_000, `${data.length} bytes`);
});

// ---- independent readers -------------------------------------------------------------------------------------------

const has = (command: string, args: string[]): boolean => spawnSync(command, args, { stdio: 'ignore', timeout: 20_000 }).status === 0;
test('python-docx, an independent reader, opens the file and sees the same structure', { skip: !has('python3', ['-I', '-c', 'import docx']) && 'python-docx is not installed' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'docx-')), file = join(directory, 'sample.docx');
  const { data } = await build(rich(), { author: 'Reader', header: 'H', footer: '{page}' });
  writeFileSync(file, data);
  const script = 'import docx, json, sys\nd = docx.Document(sys.argv[1])\nprint(json.dumps({"title": d.core_properties.title, "author": d.core_properties.author, "paragraphs": [[p.style.name, p.text] for p in d.paragraphs if p.text], "tables": [[[c.text for c in r.cells] for r in t.rows] for t in d.tables], "pages": [[s.page_width, s.page_height] for s in d.sections], "header": d.sections[0].header.paragraphs[0].text}))';
  const result = JSON.parse(execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' })) as { title: string; author: string; paragraphs: [string, string][]; tables: string[][][]; pages: number[][]; header: string };
  assert.equal(result.title, 'Sample report: every block and chart'); assert.equal(result.author, 'Reader'); assert.equal(result.header, 'H');
  assert.deepEqual(result.pages[0], [7560310, 10692130], 'A4 in EMU');
  assert.deepEqual(result.paragraphs[0], ['Title', 'Sample report: every block and chart']);
  assert.ok(result.paragraphs.some(([style, text]) => style === 'Heading 1' && text === 'Text blocks'));
  assert.deepEqual(result.tables.find(table => table[0]?.[0] === 'Asset'), [['Asset', 'Weight', 'Return'], ['Alpha', '40%', '+12.4%'], ['Beta', '35%', '+8.1%'], ['Gamma', '25%', '-1.2%']]);
});

test('LibreOffice, a second independent reader, opens the file and shows the text, including Chinese', { skip: !has('soffice', ['--version']) && 'LibreOffice is not installed', timeout: 120_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'docx-lo-')), file = join(directory, 'check.docx');
  const document = documentWith([b.section('s', '第一節 總則'), b.paragraph('p', '本契約由甲方與乙方訂立，雙方同意如下。'), b.list('l', ['甲方義務', '乙方義務'], { style: 'number' }), b.table('t', ['項目', '金額'], [['服務費', '10,000']]), b.paragraph('e', 'English text with 😀 emoji')], d => ({ ...d, title: '服務契約' }));
  writeFileSync(file, (await build(document, { language: 'zh-TW', footer: '{page}' })).data);
  execFileSync('soffice', ['--headless', `-env:UserInstallation=file://${join(directory, 'profile')}`, '--convert-to', 'txt:Text (encoded):UTF8', '--outdir', directory, file], { stdio: 'ignore', timeout: 100_000 });
  const converted = readFileSync(join(directory, 'check.txt'), 'utf8');
  for (const expected of ['服務契約', '第一節 總則', '本契約由甲方與乙方訂立，雙方同意如下。', '甲方義務', '乙方義務', '服務費', '10,000', 'English text with']) assert.ok(converted.includes(expected), `LibreOffice shows "${expected}"`);
  assert.match(converted, /1\.\s*甲方義務/, 'the numbered list is numbered');
});
