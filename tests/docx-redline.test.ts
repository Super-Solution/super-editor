import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { b, createDocument, createEditor, op, type ExportResult, type FormatWarning, type ResearchDocument, type Transaction } from '../packages/core/src/index.js';
import { exportDocx, exportDocxRedline, exportProposalDocx } from '../packages/formats/docx/src/index.js';
import { readZip } from '../packages/formats/opc/src/index.js';

const at = '2026-10-05T12:30:45.678Z';
const now = () => at;
const actor = { id: 'research-agent', kind: 'agent' } as const;
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);
const cite = (id: string, title: string) => ({ id, title, url: `https://example.com/${id}`, accessedAt: '2026-10-01T00:00:00Z' });

function seed(blocks: ReturnType<typeof b.paragraph>[], citations: ReturnType<typeof cite>[] = [], title = 'Quarterly review'): ResearchDocument {
  const editor = createEditor(createDocument({ id: 'doc', title }, { now }), { now });
  const result = editor.apply({ id: 'seed', actor: { id: 'test', kind: 'system' }, baseRevision: 0, operations: [...citations.map(citation => op.addCitation(citation)), op.insertBlocks(blocks)] });
  assert.equal(result.ok, true, JSON.stringify(result));
  return editor.getSnapshot();
}
const version = (document: ResearchDocument, id: string): number => document.blocks.find(block => block.id === id)!.version;
const transaction = (document: ResearchDocument, operations: Transaction['operations']): Transaction => ({ id: 'proposal-1', actor, baseRevision: document.revision, operations });
function apply(document: ResearchDocument, operations: Transaction['operations']): ResearchDocument {
  const editor = createEditor(document, { now });
  const result = editor.apply(transaction(document, operations));
  assert.equal(result.ok, true, JSON.stringify(result));
  return editor.getSnapshot();
}

type Parsed = { files: Map<string, Uint8Array>; document: Document; warnings: FormatWarning[]; data: Uint8Array };
async function parse(result: ExportResult): Promise<Parsed> {
  assert.equal(result.ok, true, JSON.stringify(result));
  const ok = result as Extract<ExportResult, { ok: true }>, files = await readZip(ok.data as Uint8Array);
  const dom = new JSDOM(decode(files.get('word/document.xml')), { contentType: 'application/xml' });
  assert.equal(dom.window.document.getElementsByTagName('parsererror').length, 0, 'document.xml is well formed');
  return { files, document: dom.window.document, warnings: ok.warnings, data: ok.data as Uint8Array };
}
const all = (root: Document | Element, name: string): Element[] => [...root.getElementsByTagName(name)];
const mark = (paragraph: Element): string | undefined => {
  const properties = [...paragraph.children].find(child => child.tagName === 'w:pPr'), run = properties && [...properties.children].find(child => child.tagName === 'w:rPr');
  return run && [...run.children].find(child => child.tagName === 'w:ins' || child.tagName === 'w:del')?.tagName.replace('w:', '');
};
const inside = (node: Element, tag: string): boolean => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.tagName === tag) return true; return false; };

/** What a person gets after Word's "Accept all" or "Reject all": the text of every paragraph that is left. */
function resolve(document: Document, mode: 'accept' | 'reject'): string[] {
  const dropped = mode === 'accept' ? 'del' : 'ins', out: string[] = [];
  for (const paragraph of all(document, 'w:p')) {
    if (mark(paragraph) === dropped) { assert.equal(textOf(paragraph, mode), '', 'a paragraph whose mark goes away has no text that stays'); continue; }
    out.push(textOf(paragraph, mode));
  }
  return out;
}
function textOf(paragraph: Element, mode: 'accept' | 'reject'): string {
  let result = '';
  for (const run of all(paragraph, 'w:r')) {
    if (mode === 'accept' ? inside(run, 'w:del') : inside(run, 'w:ins')) continue;
    for (const child of run.children) result += child.tagName === 'w:t' || child.tagName === 'w:delText' ? child.textContent : child.tagName === 'w:tab' ? '\t' : child.tagName === 'w:br' && child.getAttribute('w:type') !== 'page' ? '\n' : '';
  }
  return result;
}
const plain = async (document: ResearchDocument): Promise<string[]> => resolve((await parse(await exportDocx(document))).document, 'accept');

const before = seed([
  b.section('s1', 'Overview'),
  b.paragraph('p1', 'Revenue grew **12%** in the third quarter on strong demand.', { parentId: 's1' }),
  b.paragraph('p2', 'The old outlook assumed flat margins.', { parentId: 's1' }),
  b.paragraph('p3', 'Costs stayed flat.', { parentId: 's1' }),
  b.list('l1', ['Cash', 'Debt'], { parentId: 's1' }),
  b.table('t1', ['Item', 'Amount'], [['Sales', '10'], ['Costs', '4']], { parentId: 's1' }),
  b.heading('h1', 2, 'Risks', { parentId: 's1' }),
]);

test('a proposal becomes tracked changes: accepting them all gives the new document, rejecting them all gives the old one', async () => {
  const operations = [
    op.updateBlock('p1', version(before, 'p1'), { type: 'paragraph', runs: [{ text: 'Revenue grew ' }, { text: '14%', bold: true }, { text: ' in the third quarter, led by strong demand.' }] }),
    op.deleteBlock('p2', version(before, 'p2')),
    op.insertBlock(b.paragraph('p4', 'New guidance: margins will widen.', { parentId: 's1' }), 'p3'),
    op.updateBlock('l1', version(before, 'l1'), { type: 'list', ordered: false, items: ['Cash', 'Debt', 'Leases'] }),
    op.updateBlock('t1', version(before, 't1'), { type: 'table', columns: ['Item', 'Amount'], rows: [['Sales', '12'], ['Costs', '4']] }),
    op.updateBlock('h1', version(before, 'h1'), { type: 'heading', level: 2, text: 'Main risks' }),
    op.setTitle('Quarterly review, revised'),
  ];
  const result = await exportProposalDocx(before, transaction(before, operations), { now });
  const parsed = await parse(result);
  const after = apply(before, operations);

  assert.deepEqual(resolve(parsed.document, 'accept'), await plain(after));
  assert.deepEqual(resolve(parsed.document, 'reject'), await plain(before));

  // What is marked, and nothing else.
  const inserted = all(parsed.document, 'w:ins').filter(node => node.parentElement?.tagName !== 'w:rPr' && node.parentElement?.tagName !== 'w:trPr');
  const deleted = all(parsed.document, 'w:del').filter(node => node.parentElement?.tagName !== 'w:rPr' && node.parentElement?.tagName !== 'w:trPr');
  const textOfMarks = (nodes: Element[], tag: string): string => nodes.map(node => all(node, tag).map(text => text.textContent).join('')).join('|');
  assert.match(textOfMarks(inserted, 'w:t'), /14/); assert.match(textOfMarks(inserted, 'w:t'), /led by/); assert.match(textOfMarks(inserted, 'w:t'), /New guidance: margins will widen\./);
  assert.match(textOfMarks(deleted, 'w:delText'), /12/); assert.match(textOfMarks(deleted, 'w:delText'), /The old outlook assumed flat margins\./);
  assert.ok(!/Revenue grew/.test(textOfMarks(inserted, 'w:t') + textOfMarks(deleted, 'w:delText')), 'unchanged words are not marked');
  assert.ok(!/third quarter/.test(textOfMarks(inserted, 'w:t') + textOfMarks(deleted, 'w:delText')), 'unchanged words are not marked');
  for (const node of deleted) assert.equal(all(node, 'w:t').length, 0, 'deleted text is written as delText');

  // Every change has its own id, the author and a date.
  const marks = [...all(parsed.document, 'w:ins'), ...all(parsed.document, 'w:del')];
  assert.equal(new Set(marks.map(node => node.getAttribute('w:id'))).size, marks.length, 'ids are unique');
  for (const node of marks) { assert.equal(node.getAttribute('w:author'), 'research-agent'); assert.equal(node.getAttribute('w:date'), '2026-10-05T12:30:45Z'); }
  assert.match(decode(parsed.files.get('word/settings.xml')), /<w:trackRevisions\/>/);

  // The table and the list are shown as old deleted and new inserted, and say so.
  assert.deepEqual(parsed.warnings.map(warning => warning.code), ['redline-block-replaced']);
  assert.deepEqual(parsed.warnings[0]!.blockIds, ['l1', 't1']);
  assert.ok(all(parsed.document, 'w:tr').some(row => [...row.getElementsByTagName('w:del')].some(node => node.parentElement?.tagName === 'w:trPr')), 'a deleted row is marked in its row properties');
});

test('changes to the order of the marks follow Word\'s schema, and a paragraph mark is the last thing in its properties', async () => {
  const operations = [op.deleteBlock('p2', version(before, 'p2')), op.insertBlock(b.paragraph('p4', 'Another.', { parentId: 's1' }), 'p3'), op.updateBlock('t1', version(before, 't1'), { type: 'table', columns: ['Item', 'Amount'], rows: [['Sales', '11']] })];
  const { document } = await parse(await exportProposalDocx(before, transaction(before, operations)));
  for (const properties of all(document, 'w:pPr')) {
    const names = [...properties.children].map(child => child.tagName);
    if (names.includes('w:rPr')) assert.equal(names[names.length - 1], 'w:rPr', `rPr is the last child of pPr: ${names.join(', ')}`);
    if (names.includes('w:jc') && names.includes('w:rPr')) assert.ok(names.indexOf('w:jc') < names.indexOf('w:rPr'));
  }
  for (const properties of all(document, 'w:trPr')) { const names = [...properties.children].map(child => child.tagName.replace('w:', '')); const order = ['cantSplit', 'tblHeader', 'ins', 'del']; assert.deepEqual(names.map(name => order.indexOf(name)), names.map(name => order.indexOf(name)).sort((x, y) => x - y)); }
  for (const node of [...all(document, 'w:ins'), ...all(document, 'w:del')]) if (node.parentElement?.tagName !== 'w:rPr' && node.parentElement?.tagName !== 'w:trPr') assert.ok(['w:p', 'w:hyperlink'].includes(node.parentElement!.tagName), `a run-level change sits in a paragraph or a link, not in ${node.parentElement!.tagName}`);
});

test('Chinese text is compared character by character; links, bold and citation markers keep their meaning', async () => {
  const base = seed([b.section('s', '第一節'), b.paragraph('p', '本契約由甲方與乙方訂立，雙方同意如下。 See [the note](https://example.com/note) for **details**.', { parentId: 's' })]);
  const operations = [op.updateBlock('p', version(base, 'p'), { type: 'paragraph', runs: [{ text: '本契約由甲方與丙方訂立，雙方同意如下。 See ' }, { text: 'the note', href: 'https://example.com/note' }, { text: ' for ' }, { text: 'all details', bold: true }, { text: '.' }] })];
  const parsed = await parse(await exportProposalDocx(base, transaction(base, operations)));
  assert.deepEqual(resolve(parsed.document, 'accept'), await plain(apply(base, operations)));
  assert.deepEqual(resolve(parsed.document, 'reject'), await plain(base));
  const deleted = all(parsed.document, 'w:del').map(node => all(node, 'w:delText').map(text => text.textContent).join('')).join('|');
  const inserted = all(parsed.document, 'w:ins').map(node => all(node, 'w:t').map(text => text.textContent).join('')).join('|');
  assert.ok(deleted.includes('乙') && inserted.includes('丙'), `the one character that changed is marked: ${deleted} / ${inserted}`);
  assert.ok(!deleted.includes('甲') && !inserted.includes('甲'), 'the characters around it are not');
  assert.equal(parsed.warnings.length, 0);
});

test('sources: a new title, new and removed citations are tracked; numbers follow the new document', async () => {
  const base = seed([b.section('s', 'Notes'), b.paragraph('p', 'Claim [^a].', { parentId: 's' })], [cite('a', 'Source A'), cite('z', 'Source Z')]);
  const after = apply(base, [op.addCitation(cite('n', 'Source N')), op.removeCitation('z')]);
  const parsed = await parse(await exportDocxRedline({ before: base, after, actor }));
  const texts = resolve(parsed.document, 'accept');
  assert.deepEqual(texts, await plain(after));
  const rejected = resolve(parsed.document, 'reject').map(text => text.replace(/\[\d+\]/g, '[#]'));
  assert.deepEqual(rejected, (await plain(base)).map(text => text.replace(/\[\d+\]/g, '[#]')));
  const sources = all(parsed.document, 'w:p').filter(paragraph => /Source [ANZ]/.test(textOf(paragraph, 'reject') + textOf(paragraph, 'accept')));
  assert.deepEqual(sources.map(paragraph => mark(paragraph) ?? 'same'), ['same', 'ins', 'del']);

  const retitled = apply(base, [op.setTitle('Notes, second edition')]);
  const second = await parse(await exportDocxRedline({ before: base, after: retitled, actor }));
  assert.equal(resolve(second.document, 'accept')[0], 'Notes, second edition'); assert.equal(resolve(second.document, 'reject')[0], 'Quarterly review');
});

test('what cannot be shown is reported: moves, page format, no changes', async () => {
  const moved = apply(before, [op.moveBlock('p3', version(before, 'p3'), 's1', null)]);
  const reformatted = apply(before, [op.setFormat({ page: 'letter', font: 'serif', fontSize: 14, lineHeight: 1.5 })]);
  const codes = async (after: ResearchDocument): Promise<string[]> => (await parse(await exportDocxRedline({ before, after, actor }))).warnings.map(warning => warning.code);
  assert.deepEqual(await codes(moved), ['redline-move-not-tracked']);
  assert.deepEqual(await codes(reformatted), ['redline-format-not-tracked']);
  assert.deepEqual(await codes(before), ['redline-no-changes']);
  const none = await parse(await exportDocxRedline({ before, after: before, actor }));
  assert.equal(all(none.document, 'w:ins').length + all(none.document, 'w:del').length, 0);
});

test('a stale or invalid proposal, other documents and bad options are refused with a reason', async () => {
  const stale = await exportProposalDocx(before, { ...transaction(before, [op.deleteBlock('p2', 99)]) });
  assert.equal(stale.ok, false); if (!stale.ok) assert.ok(stale.issues.some(issue => issue.code === 'conflict' || issue.code === 'validation'), JSON.stringify(stale.issues));
  const old = apply(before, [op.setTitle('Newer')]);
  const late = await exportProposalDocx(old, transaction(before, [op.setTitle('Another')]));
  assert.equal(late.ok, false); if (!late.ok) assert.equal(late.issues[0]!.code, 'conflict');
  const invalid = await exportProposalDocx(before, { nonsense: true });
  assert.equal(invalid.ok, false);
  const other = await exportDocxRedline({ before, after: { ...before, id: 'other' }, actor });
  assert.equal(other.ok, false); if (!other.ok) assert.equal(other.issues[0]!.path, 'after.id');
  const broken = await exportDocxRedline({ before, after: { ...before, blocks: [{ ...before.blocks[0]!, id: '' }] } as ResearchDocument, actor });
  assert.equal(broken.ok, false); if (!broken.ok) assert.ok(broken.issues.every(issue => (issue.path ?? '').startsWith('after.')));
  for (const options of [{ changeAuthor: '' }, { changeDate: 'yesterday' }, { trackChanges: 'yes' }, { unknown: 1 }]) {
    const result = await exportDocxRedline({ before, after: before, actor }, options as never);
    assert.equal(result.ok, false, JSON.stringify(options)); if (!result.ok) assert.ok(result.issues.every(issue => issue.hint), 'every issue has a hint');
  }
});

test('options: author, date and tracking; the same input gives the same bytes', async () => {
  const after = apply(before, [op.deleteBlock('p3', version(before, 'p3'))]);
  const first = await parse(await exportDocxRedline({ before, after, actor }, { changeAuthor: 'Reviewer "Q" <1>', changeDate: '2026-11-01T08:00:00+08:00', trackChanges: false }));
  assert.ok(all(first.document, 'w:del').every(node => node.getAttribute('w:author') === 'Reviewer "Q" <1>' && node.getAttribute('w:date') === '2026-11-01T00:00:00Z'));
  assert.doesNotMatch(decode(first.files.get('word/settings.xml')), /trackRevisions/);
  const again = await exportDocxRedline({ before, after, actor }, { changeAuthor: 'Reviewer "Q" <1>', changeDate: '2026-11-01T08:00:00+08:00', trackChanges: false });
  assert.deepEqual(first.data, (again as Extract<ExportResult, { ok: true }>).data);
});

test('a long text is still compared, and one too long to compare is shown as old deleted and new inserted, with a warning', async () => {
  const words = (count: number, seedText: string): string => Array.from({ length: count }, (_, index) => `${seedText}${index}`).join(' ');
  const base = seed([b.paragraph('p', words(1500, 'w'))]);
  const small = apply(base, [op.updateBlock('p', version(base, 'p'), { type: 'paragraph', runs: [{ text: `${words(1500, 'w').replace('w700', 'changed')} end` }] })]);
  const quick = await parse(await exportDocxRedline({ before: base, after: small, actor }));
  assert.deepEqual(resolve(quick.document, 'accept'), await plain(small)); assert.deepEqual(resolve(quick.document, 'reject'), await plain(base));
  assert.equal(quick.warnings.length, 0);
  const huge = apply(base, [op.updateBlock('p', version(base, 'p'), { type: 'paragraph', runs: [{ text: words(4200, 'x') }] })]);
  const slow = await parse(await exportDocxRedline({ before: seed([b.paragraph('p', words(4200, 'y'))]), after: seed([b.paragraph('p', words(4200, 'x'))]), actor }));
  assert.equal(slow.warnings[0]!.code, 'redline-block-replaced'); assert.match(slow.warnings[0]!.message, /too long to compare/);
  assert.ok(huge.blocks.length > 0);
});

function has(command: string, args: string[]): boolean { return spawnSync(command, args, { stdio: 'ignore' }).status === 0; }

test('LibreOffice reads the file with its tracked changes, and python-docx opens it', { skip: !has('soffice', ['--version']) && 'LibreOffice is not installed', timeout: 120_000 }, async () => {
  const operations = [op.updateBlock('p1', version(before, 'p1'), { type: 'paragraph', runs: [{ text: 'Revenue grew 14% in the third quarter.' }] }), op.deleteBlock('p2', version(before, 'p2')), op.insertBlock(b.paragraph('p4', 'Added line.', { parentId: 's1' }), 'p3')];
  const directory = mkdtempSync(join(tmpdir(), 'redline-lo-')), file = join(directory, 'redline.docx');
  const result = await exportProposalDocx(before, transaction(before, operations));
  writeFileSync(file, (result as Extract<ExportResult, { ok: true }>).data as Uint8Array);
  const out = join(directory, 'out');
  execFileSync('soffice', ['--headless', `-env:UserInstallation=file://${join(directory, 'profile')}`, '--convert-to', 'docx:MS Word 2007 XML', '--outdir', out, file], { stdio: 'ignore', timeout: 100_000 });
  const files = await readZip(new Uint8Array(readFileSync(join(out, 'redline.docx'))));
  const roundTrip = decode(files.get('word/document.xml'));
  assert.ok((roundTrip.match(/<w:ins /g) ?? []).length >= 3, 'LibreOffice kept the insertions as tracked changes');
  assert.ok((roundTrip.match(/<w:del /g) ?? []).length >= 2, 'LibreOffice kept the deletions as tracked changes');
  assert.ok(roundTrip.includes('research-agent'), 'and their author');
  if (has('python3', ['-I', '-c', 'import docx'])) {
    const text = execFileSync('python3', ['-I', '-c', 'import docx, sys\nd = docx.Document(sys.argv[1])\nprint(len(d.paragraphs))', file], { encoding: 'utf8' });
    assert.ok(Number(text.trim()) > 3);
  }
});
