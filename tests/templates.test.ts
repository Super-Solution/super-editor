import assert from 'node:assert/strict';
import test from 'node:test';
import { TEMPLATES, TEMPLATE_KINDS, createDocument, createEditor, createTemplate, isTemplateKind, listTemplates, templateTitle } from '../packages/core/src/index.js';
import type { BlockInput, TemplateKind } from '../packages/core/src/index.js';

const now = () => '2026-10-05T00:00:00.000Z';
const actor = { id: 'template-test', kind: 'agent' as const };

function insertInto(blocks: BlockInput[], title = 'Template test') {
  const editor = createEditor(createDocument({ id: 'template-doc', title }, { now }), { now });
  const result = editor.apply({ id: 'insert-template', actor, baseRevision: 0, operations: [{ type: 'insertBlocks', blocks }] });
  return { editor, result };
}

test('every template inserts as one valid, ordered, all-or-nothing batch', () => {
  assert.deepEqual([...TEMPLATE_KINDS], ['equity', 'macro', 'portfolio', 'strategy', 'arbitrage', 'comparison', 'blank']);
  for (const kind of TEMPLATE_KINDS) {
    const blocks = createTemplate(kind);
    assert.ok(blocks.length > 0, kind);
    const ids = blocks.map(block => block.id);
    assert.equal(new Set(ids).size, ids.length, `${kind} ids are unique`);
    assert.ok(ids.every(id => id.startsWith(`${kind}-`)), `${kind} ids use the default prefix`);
    const { editor, result } = insertInto(blocks);
    assert.equal(result.ok, true, `${kind}: ${JSON.stringify(result.ok ? '' : result.issues)}`);
    // The editor keeps parents before children and the batch order, so the stored order matches the template order.
    assert.deepEqual(editor.getSnapshot().blocks.map(block => block.id), ids, `${kind} keeps its order`);
  }
});

test('every non-blank template ends with methodology and an analysis-only note', () => {
  for (const kind of TEMPLATE_KINDS.filter(entry => entry !== 'blank')) {
    const blocks = createTemplate(kind);
    const sections = blocks.filter(block => block.content.type === 'section');
    assert.ok(sections.length >= 4, `${kind} has substantial structure`);
    const last = sections[sections.length - 1]!;
    assert.deepEqual(last.content, { type: 'section', title: 'Data and methodology' });
    const note = blocks.find(block => block.id === `${kind}-disclaimer`);
    assert.ok(note && note.content.type === 'callout' && note.parentId === last.id);
    assert.ok(blocks.some(block => block.content.type === 'metrics' || block.content.type === 'table'), `${kind} has a data placeholder`);
  }
});

test('templates are analysis-only: no trading or execution language and no embedded market data', () => {
  const banned = /\b(buy|sell|orders?|executions?|execute[sd]?|brokerage|leverage|invest now|guaranteed)\b/i;
  for (const kind of TEMPLATE_KINDS) {
    const serialized = JSON.stringify(createTemplate(kind, { subject: 'ACME' }));
    assert.doesNotMatch(serialized, banned, kind);
    // Structure only: no chart blocks with invented numbers.
    assert.ok(!createTemplate(kind).some(block => block.content.type === 'chart'), `${kind} contains no sample chart data`);
  }
});

test('options control the ID prefix, subject text and the parent container', () => {
  const blocks = createTemplate('equity', { idPrefix: 'btc:2026', subject: '  BTC \n spot  ' });
  assert.ok(blocks.every(block => block.id.startsWith('btc:2026-')));
  assert.match(JSON.stringify(blocks), /State the thesis for BTC spot in two or three sentences/);
  assert.equal(templateTitle('equity', 'BTC'), 'BTC: equity analysis');
  assert.equal(templateTitle('equity'), 'Equity analysis');
  assert.equal(templateTitle('blank', 'ignored'), 'Untitled report');

  const editor = createEditor(createDocument({ id: 'host', title: 'Host' }, { now }), { now });
  const host = editor.apply({ id: 'host-section', actor, baseRevision: 0, operations: [{ type: 'insertBlock', block: { id: 'host-section', parentId: null, citationIds: [], content: { type: 'toggle', title: 'Appendix', open: true } } }] });
  assert.equal(host.ok, true);
  const nested = createTemplate('macro', { parentId: 'host-section', idPrefix: 'appendix' });
  assert.ok(nested.filter(block => block.content.type === 'section').every(block => block.parentId === 'host-section'));
  const applied = editor.apply({ id: 'insert-nested', actor, baseRevision: 1, operations: [{ type: 'insertBlocks', blocks: nested }] });
  assert.equal(applied.ok, true);
  assert.ok(editor.getSnapshot().blocks.some(block => block.id === 'appendix-summary' && block.parentId === 'host-section'));
});

test('invalid options and unknown kinds fail loudly with a usable message', () => {
  for (const idPrefix of ['', '-x', 'a b', 'a/b', 'x'.repeat(61)]) assert.throws(() => createTemplate('macro', { idPrefix }), /idPrefix/);
  assert.throws(() => createTemplate('equity', { subject: 'x'.repeat(201) }), /subject/);
  assert.throws(() => createTemplate('nope' as TemplateKind), /Unknown template "nope"\. Use one of: equity, macro/);
  assert.throws(() => createTemplate('equity', { parentId: '' }), /parentId/);
  assert.equal(isTemplateKind('equity'), true);
  assert.equal(isTemplateKind('crypto'), false);
  assert.equal(isTemplateKind(undefined), false);
});

test('templates are deterministic and independent copies', () => {
  for (const kind of TEMPLATE_KINDS) {
    assert.deepEqual(TEMPLATES[kind](), TEMPLATES[kind]());
    const first = createTemplate(kind);
    const second = createTemplate(kind);
    assert.notStrictEqual(first[0], second[0]);
    assert.notStrictEqual(first[0]!.content, second[0]!.content);
  }
  assert.throws(() => { (TEMPLATES as Record<string, unknown>).equity = () => []; });
});

test('listTemplates describes each kind with its section titles', () => {
  const listed = listTemplates();
  assert.deepEqual(listed.map(item => item.kind), [...TEMPLATE_KINDS]);
  for (const item of listed) {
    assert.ok(item.title.length > 0 && item.description.length > 0);
    if (item.kind === 'blank') assert.deepEqual(item.sections, []);
    else assert.ok(item.sections.includes('Data and methodology'));
  }
  assert.ok(listed.find(item => item.kind === 'portfolio')!.sections.includes('Allocation'));
});
