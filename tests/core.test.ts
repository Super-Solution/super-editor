import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createEditor, LIMITS, parseDocument, safeUrl, serializeDocument, validateDocument, validateTransaction } from '../packages/core/src/index.js';
import type { Actor, ApplyResult, BlockContent, BlockInput, Editor, Operation, ResearchDocument, Transaction } from '../packages/core/src/index.js';

const at = '2026-10-03T12:00:00.000Z';
const human: Actor = { id: 'analyst', kind: 'human' };
const agent: Actor = { id: 'research-agent', kind: 'agent' };
const paragraph = (text = 'Research'): BlockContent => ({ type: 'paragraph', runs: [{ text }] });
const input = (id: string, parentId: string | null = null, content: BlockContent = paragraph()): BlockInput => ({ id, parentId, content, citationIds: [] });
let sequence = 0;
function editor(options: Parameters<typeof createEditor>[1] = {}): Editor {
  return createEditor(createDocument({ id: 'report', title: 'Research report' }, { now: () => at }), { now: () => at, ...options });
}
function transaction(current: Editor, operations: Operation[], overrides: Partial<Transaction> = {}): Transaction {
  return { id: `tx-${++sequence}`, actor: { ...human }, baseRevision: current.getSnapshot().revision, operations, ...overrides };
}
function success(value: ApplyResult): Extract<ApplyResult, { ok: true }> { assert.equal(value.ok, true, JSON.stringify(value)); return value as Extract<ApplyResult, { ok: true }>; }
function failure(value: ApplyResult, code?: string): Extract<ApplyResult, { ok: false }> {
  assert.equal(value.ok, false); const rejected = value as Extract<ApplyResult, { ok: false }>;
  if (code) assert.equal(rejected.issues[0]?.code, code);
  return rejected;
}
function apply(current: Editor, operations: Operation[], overrides: Partial<Transaction> = {}): Extract<ApplyResult, { ok: true }> { return success(current.apply(transaction(current, operations, overrides))); }
function insert(current: Editor, ...blocks: BlockInput[]): void { apply(current, blocks.map(block => ({ type: 'insertBlock', block }))); }
function mutable(document: ResearchDocument): ResearchDocument { return JSON.parse(serializeDocument(document)) as ResearchDocument; }
function contentState(document: ResearchDocument): unknown {
  return { title: document.title, format: document.format, citations: document.citations,
    blocks: document.blocks.map(({ id, parentId, content, citationIds }) => ({ id, parentId, content, citationIds })) };
}

test('complete typed report round-trips through JSON without a DOM dependency', () => {
  const current = editor();
  const citation = { id: 'source', title: 'Public data', url: 'https://example.org/data', accessedAt: at, publishedAt: '2026-10-02T00:00:00Z' };
  apply(current, [
    { type: 'addCitation', citation },
    { type: 'insertBlock', block: input('macro', null, { type: 'section', title: 'Macro' }) },
    { type: 'insertBlock', block: input('h2', 'macro', { type: 'heading', level: 2, text: 'Rates' }) },
    { type: 'insertBlock', block: input('h3', 'macro', { type: 'heading', level: 3, text: 'Scenario' }) },
    { type: 'insertBlock', block: { ...input('summary', 'macro', { type: 'paragraph', runs: [{ text: 'Rates ', bold: true }, { text: 'evidence', italic: true, code: false, href: citation.url }] }), citationIds: ['source'] } },
    { type: 'insertBlock', block: input('list', 'macro', { type: 'list', ordered: false, items: ['Macro', 'ETF', 'Portfolio'] }) },
    { type: 'insertBlock', block: input('table', 'macro', { type: 'table', columns: ['Asset', 'Weight'], rows: [['Example ETF', '40%']] }) },
    { type: 'insertBlock', block: input('chart', 'macro', { type: 'chart', spec: { kind: 'trend', title: 'Illustrative rates', labels: ['T1', 'T2'], series: [{ name: 'Rate', values: [3.5, 3.4] }], unit: '%', asOf: at } }) },
    { type: 'insertBlock', block: input('embed', 'macro', { type: 'embed', provider: 'superchart', title: 'External chart', url: 'https://charts.example.org/report/1' }) },
    { type: 'insertBlock', block: input('timestamp', 'macro', { type: 'timestamp', at, label: 'Data as of' }) },
    { type: 'setFormat', format: { page: 'A4', font: 'serif', fontSize: 12, lineHeight: 1.5 } },
  ]);
  const snapshot = current.getSnapshot();
  assert.equal(snapshot.revision, 1); assert.equal(snapshot.blocks.length, 9);
  const roundTrip = parseDocument(serializeDocument(snapshot));
  assert.equal(roundTrip.ok, true);
  if (roundTrip.ok) assert.deepEqual(roundTrip.value, snapshot);
  assert.equal(typeof current.getRevisions()[0]?.at, 'string');
  assert.equal(parseDocument('{bad').ok, false);
  assert.equal(parseDocument(JSON.stringify({ ...snapshot, schemaVersion: 2 })).ok, false);
});

test('plain HTML-looking text is preserved and raw HTML content is rejected', () => {
  const current = editor();
  insert(current, input('safe', null, paragraph('<img src=x onerror=alert(1)>')));
  assert.deepEqual(current.getSnapshot().blocks[0]?.content, paragraph('<img src=x onerror=alert(1)>'));
  const hostile = transaction(current, []);
  assert.equal(validateTransaction({ ...hostile, operations: [{ type: 'insertBlock', block: { ...input('raw'), content: { type: 'html', html: '<script>bad()</script>' } } }] }).ok, false);
  assert.equal(validateTransaction({ ...hostile, operations: [{ type: 'insertBlock', block: { ...input('extra'), content: { type: 'paragraph', runs: [], html: '<script>' } } }] }).ok, false);
});

test('links and embeds reject dangerous schemes, credentials and ambiguous characters', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hi', '//example.org/x', '/relative', 'file:///C:/private', 'https://user:pass@example.org', 'https://good.org@bad.org', 'https://example.org/a\nb', 'https://example.org/a b', 'https:\\example.org', 'http://example.org\u0000']) assert.equal(safeUrl(value), null, value);
  assert.equal(safeUrl('HTTPS://EXAMPLE.ORG'), 'https://example.org/');
  assert.equal(safeUrl('http://example.org'), 'http://example.org/');
  assert.equal(safeUrl('http://example.org', { httpsOnly: true }), null);
  const current = editor();
  failure(current.apply(transaction(current, [{ type: 'insertBlock', block: input('embed', null, { type: 'embed', provider: 'superchart', url: 'http://example.org', title: 'Chart' }) }])), 'validation');
  failure(current.apply(transaction(current, [{ type: 'insertBlock', block: input('link', null, { type: 'paragraph', runs: [{ text: 'X', href: 'javascript:alert(1)' }] }) }])), 'validation');
});

test('runtime boundaries reject unknown keys, custom prototypes, accessors and sparse arrays', () => {
  const current = editor(); const valid = transaction(current, [{ type: 'setTitle', title: 'x' }]);
  assert.equal(validateTransaction({ ...valid, dangerous: true }).ok, false);
  assert.equal(validateTransaction({ ...valid, actor: { ...human, token: 'not-a-contract-field' } }).ok, false);
  assert.equal(validateTransaction({ ...valid, operations: [{ type: 'setTitle', title: 'x', html: '<b>x</b>' }] }).ok, false);
  assert.equal(validateTransaction(Object.assign(Object.create({ inherited: true }) as object, valid)).ok, false);
  let getterCalls = 0; const accessor = { ...valid };
  Object.defineProperty(accessor, 'actor', { get() { getterCalls++; return human; }, enumerable: true });
  assert.equal(validateTransaction(accessor).ok, false); assert.equal(getterCalls, 0);
  const sparse: unknown[] = []; sparse.length = 1;
  assert.equal(validateTransaction({ ...valid, operations: sparse }).ok, false);
  const parsed = JSON.parse(JSON.stringify(valid).replace('"id":', '"__proto__":{},"id":')) as unknown;
  assert.equal(validateTransaction(parsed).ok, false);
});

test('UTC timestamps reject rollover dates, timezone ambiguity and backward chronology', () => {
  const doc = mutable(editor().getSnapshot());
  for (const value of ['2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-10-03T25:00:00Z', '2026-10-03', '2026-10-03T00:00:00+08:00', '2026-10-03T00:00:00.1234Z']) assert.equal(validateDocument({ ...doc, createdAt: value }).ok, false, value);
  assert.equal(validateDocument({ ...doc, createdAt: '2024-02-29T00:00:00.1Z' }).ok, true);
  assert.equal(validateDocument({ ...doc, createdAt: '2026-10-04T00:00:00Z' }).ok, false);
  const current = editor(); insert(current, input('a'));
  const blockDoc = mutable(current.getSnapshot()); blockDoc.blocks[0]!.updatedAt = '2026-10-04T00:00:00Z';
  assert.equal(validateDocument(blockDoc).ok, false);
});

test('document hierarchy requires section parents, unique IDs, no cycles and bounded depth', () => {
  const current = editor(); insert(current, input('a', null, { type: 'section', title: 'A' }), input('b', 'a', { type: 'section', title: 'B' }));
  const doc = mutable(current.getSnapshot());
  doc.blocks[0]!.parentId = 'b'; assert.equal(validateDocument(doc).ok, false);
  doc.blocks[0]!.parentId = null; doc.blocks[1]!.parentId = 'missing'; assert.equal(validateDocument(doc).ok, false);
  doc.blocks[1]!.parentId = 'a'; doc.blocks[0]!.content = paragraph(); assert.equal(validateDocument(doc).ok, false);
  const duplicate = mutable(current.getSnapshot()); duplicate.blocks.push({ ...duplicate.blocks[0]! }); assert.equal(validateDocument(duplicate).ok, false);
  const nested = editor();
  insert(nested, ...Array.from({ length: LIMITS.depth }, (_, index) => input(`depth-${index}`, index ? `depth-${index - 1}` : null, { type: 'section', title: `${index}` })));
  assert.equal(nested.getSnapshot().blocks.length, LIMITS.depth);
  failure(nested.apply(transaction(nested, [{ type: 'insertBlock', block: input('too-deep', `depth-${LIMITS.depth - 1}`) }])), 'validation');
});

test('chart and table validation rejects unsafe data shape and arithmetic extremes', () => {
  const current = editor();
  const chart = (values: number[], kind = 'bar', labels = ['A', 'B']): BlockContent => ({ type: 'chart', spec: { kind, title: 'Chart', labels, series: [{ name: 'series', values }] } });
  for (const content of [chart([NaN, 1]), chart([Infinity, 1]), chart([Number.MAX_VALUE, 1]), chart([1]), chart([-1, 2], 'pie'), chart([0, 0], 'pie'), { type: 'table', columns: ['A', 'B'], rows: [['missing-cell']] } as BlockContent]) failure(current.apply(transaction(current, [{ type: 'insertBlock', block: input(`bad-${++sequence}`, null, content) }])), 'validation');
  insert(current, input('extensible', null, chart([-20, 10], 'custom-plot')));
  assert.equal(current.getSnapshot().blocks[0]?.content.type, 'chart');
  failure(current.apply(transaction(current, [{ type: 'setFormat', format: { page: 'screen', font: 'sans', fontSize: 100, lineHeight: 1.5 } }])), 'validation');
});

test('missing citations fail atomically while addCitation and references in one batch succeed', () => {
  const current = editor(); const before = current.getSnapshot();
  const referenced = { ...input('evidence'), citationIds: ['source'] };
  failure(current.apply(transaction(current, [{ type: 'insertBlock', block: referenced }])), 'validation');
  assert.equal(current.getSnapshot(), before);
  apply(current, [{ type: 'insertBlock', block: referenced }, { type: 'addCitation', citation: { id: 'source', title: 'Source', url: 'https://example.org', accessedAt: at } }]);
  failure(current.apply(transaction(current, [{ type: 'addCitation', citation: current.getSnapshot().citations[0]! }])), 'duplicate');
});

test('failing operation batches leave snapshots, revisions, retry IDs and reservations untouched', () => {
  const current = editor(); const before = current.getSnapshot(); let events = 0; current.subscribe(() => { events++; });
  const invalid = transaction(current, [{ type: 'insertBlock', block: input('recoverable') }, { type: 'updateBlock', blockId: 'missing', expectedVersion: 1, content: paragraph() }]);
  failure(current.apply(invalid), 'not-found'); assert.equal(current.getSnapshot(), before); assert.equal(events, 0); assert.equal(current.getRevisions().length, 0);
  success(current.apply({ ...invalid, operations: [{ type: 'insertBlock', block: input('recoverable') }] }));
  assert.equal(events, 1); assert.equal(current.getSnapshot().blocks[0]?.id, 'recoverable');
});

test('snapshots and revisions are deeply frozen, stable and isolated from caller mutation', () => {
  const current = editor(); const tx = transaction(current, [{ type: 'insertBlock', block: input('a') }]);
  const result = success(current.apply(tx)); const snapshot = current.getSnapshot();
  assert.equal(current.getSnapshot(), snapshot); assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(snapshot.blocks[0]?.content), true); assert.equal(Object.isFrozen(current.getRevisions()[0]?.operations), true);
  tx.actor.id = 'changed'; (tx.operations[0] as { block: BlockInput }).block.content = paragraph('changed');
  assert.equal(current.getRevisions()[0]?.actor.id, 'analyst'); assert.deepEqual(snapshot.blocks[0]?.content, paragraph());
  assert.throws(() => { snapshot.blocks.push({ ...snapshot.blocks[0]! }); }, TypeError);
  const fresh = createEditor(snapshot, { now: () => at });
  assert.deepEqual(fresh.getSnapshot(), snapshot); assert.notEqual(fresh.getSnapshot(), snapshot);
});

test('subscriber errors cannot turn a commit into failure and unsubscribe removes notifications', () => {
  const current = editor(); let events = 0;
  current.subscribe(() => { throw new Error('host listener failure'); }); const unsubscribe = current.subscribe(() => { events++; });
  apply(current, [{ type: 'setTitle', title: 'one' }]); assert.equal(events, 1);
  unsubscribe(); apply(current, [{ type: 'setTitle', title: 'two' }]); assert.equal(events, 1); assert.equal(current.getSnapshot().revision, 2);
});

test('active, retired and same-batch abandoned block IDs cannot be reused', () => {
  const current = editor(); insert(current, input('a'));
  failure(current.apply(transaction(current, [{ type: 'insertBlock', block: input('a') }])), 'duplicate');
  apply(current, [{ type: 'deleteBlock', blockId: 'a', expectedVersion: 1 }]);
  failure(current.apply(transaction(current, [{ type: 'insertBlock', block: input('a') }])), 'duplicate');
  failure(current.apply(transaction(current, [{ type: 'insertBlock', block: input('batch') }, { type: 'deleteBlock', blockId: 'batch', expectedVersion: 1 }, { type: 'insertBlock', block: input('batch') }])), 'duplicate');
  insert(current, input('batch')); assert.equal(current.getSnapshot().blocks[0]?.id, 'batch');
});

test('stale agents reject by default; safe rebase edits only unchanged version-guarded blocks', () => {
  const current = editor(); insert(current, input('human-block'), input('agent-block'));
  const baseRevision = current.getSnapshot().revision;
  const proposal = transaction(current, [{ type: 'updateBlock', blockId: 'agent-block', expectedVersion: 1, content: paragraph('agent proposal') }], { actor: agent, baseRevision });
  apply(current, [{ type: 'updateBlock', blockId: 'human-block', expectedVersion: 1, content: paragraph('human edit') }]);
  failure(current.apply(proposal), 'conflict');
  const accepted = success(current.apply({ ...proposal, conflictPolicy: 'rebase-safe' }));
  assert.equal(accepted.revision.rebasedFrom, baseRevision); assert.equal(current.getSnapshot().blocks.find(block => block.id === 'agent-block')?.version, 2);
  failure(current.apply(transaction(current, [{ type: 'updateBlock', blockId: 'human-block', expectedVersion: 1, content: paragraph('overwrite') }], { actor: agent, baseRevision, conflictPolicy: 'rebase-safe' })), 'conflict');
});

test('rebases reject metadata, structure, type changes and future base revisions', () => {
  const current = editor(); insert(current, input('a')); const baseRevision = current.getSnapshot().revision;
  apply(current, [{ type: 'setTitle', title: 'human metadata' }]); const before = current.getSnapshot();
  for (const operations of [
    [{ type: 'setTitle', title: 'agent metadata' }],
    [{ type: 'insertBlock', block: input('b') }],
    [{ type: 'deleteBlock', blockId: 'a', expectedVersion: 1 }],
    [{ type: 'updateBlock', blockId: 'a', expectedVersion: 1, content: { type: 'heading', level: 2, text: 'type change' } }],
    [{ type: 'updateBlock', blockId: 'a', expectedVersion: 1, content: paragraph('valid') }, { type: 'setTitle', title: 'mixed' }],
  ] as Operation[][]) { failure(current.apply(transaction(current, operations, { actor: agent, baseRevision, conflictPolicy: 'rebase-safe' })), 'conflict'); assert.equal(current.getSnapshot(), before); }
  failure(current.apply(transaction(current, [{ type: 'updateBlock', blockId: 'a', expectedVersion: 1, content: paragraph() }], { baseRevision: before.revision + 1, conflictPolicy: 'rebase-safe' })), 'conflict');
});

test('update, move and delete guards are required and checked at every operation', () => {
  const current = editor(); insert(current, input('a'));
  for (const operation of [{ type: 'updateBlock', blockId: 'a', content: paragraph() }, { type: 'moveBlock', blockId: 'a', parentId: null }, { type: 'deleteBlock', blockId: 'a' }]) failure(current.apply({ ...transaction(current, []), operations: [operation] }), 'validation');
  for (const operation of [{ type: 'updateBlock', blockId: 'a', expectedVersion: 3, content: paragraph() }, { type: 'moveBlock', blockId: 'a', expectedVersion: 3, parentId: null }, { type: 'deleteBlock', blockId: 'a', expectedVersion: 3 }] as Operation[]) failure(current.apply(transaction(current, [operation])), 'conflict');
  apply(current, [{ type: 'updateBlock', blockId: 'a', expectedVersion: 1, content: paragraph('one') }, { type: 'updateBlock', blockId: 'a', expectedVersion: 2, content: paragraph('two') }]);
  assert.equal(current.getSnapshot().blocks[0]?.version, 3);
});

test('ordering anchors are siblings; omission appends and null prepends', () => {
  const current = editor(); insert(current, input('s', null, { type: 'section', title: 'S' }), input('t', null, { type: 'section', title: 'T' }), input('a', 's'), input('c', 's'), input('q', 't'));
  apply(current, [{ type: 'insertBlock', block: input('b', 's'), afterId: 'a' }, { type: 'insertBlock', block: input('start', 's'), afterId: null }, { type: 'insertBlock', block: input('end', 's') }]);
  assert.deepEqual(current.getSnapshot().blocks.filter(block => block.parentId === 's').map(block => block.id), ['start', 'a', 'b', 'c', 'end']);
  const before = current.getSnapshot();
  failure(current.apply(transaction(current, [{ type: 'moveBlock', blockId: 'a', expectedVersion: 1, parentId: 't', afterId: 'b' }])), 'validation'); assert.equal(current.getSnapshot(), before);
  failure(current.apply(transaction(current, [{ type: 'moveBlock', blockId: 'a', expectedVersion: 1, parentId: 's', afterId: 'a' }])), 'validation');
  apply(current, [{ type: 'moveBlock', blockId: 'a', expectedVersion: 1, parentId: 't', afterId: 'q' }]);
  assert.deepEqual(current.getSnapshot().blocks.filter(block => block.parentId === 't').map(block => block.id), ['q', 'a']);
});

test('moves cannot create cycles and parent sections cannot lose their type with children', () => {
  const current = editor(); insert(current, input('s', null, { type: 'section', title: 'S' }), input('nested', 's', { type: 'section', title: 'Nested' }), input('child', 'nested'));
  const before = current.getSnapshot();
  failure(current.apply(transaction(current, [{ type: 'moveBlock', blockId: 's', expectedVersion: 1, parentId: 'nested' }])), 'validation'); assert.equal(current.getSnapshot(), before);
  failure(current.apply(transaction(current, [{ type: 'updateBlock', blockId: 's', expectedVersion: 1, content: paragraph() }])), 'validation'); assert.equal(current.getSnapshot(), before);
  // An exact-revision batch can validly reshape the hierarchy when its final state is sound.
  apply(current, [{ type: 'updateBlock', blockId: 's', expectedVersion: 1, content: paragraph('former section') }, { type: 'moveBlock', blockId: 'nested', expectedVersion: 1, parentId: null }]);
  assert.equal(current.getSnapshot().blocks.find(block => block.id === 'nested')?.parentId, null);
});

test('section deletion cascades and stale subtree deletion cannot erase a human child edit', () => {
  const current = editor(); insert(current, input('s', null, { type: 'section', title: 'S' }), input('nested', 's', { type: 'section', title: 'N' }), input('child', 'nested'), input('outside'));
  const staleDelete = transaction(current, [{ type: 'deleteBlock', blockId: 's', expectedVersion: 1 }], { actor: agent, conflictPolicy: 'rebase-safe' });
  apply(current, [{ type: 'updateBlock', blockId: 'child', expectedVersion: 1, content: paragraph('human') }]);
  failure(current.apply(staleDelete), 'conflict');
  apply(current, [{ type: 'deleteBlock', blockId: 's', expectedVersion: 1 }]);
  assert.deepEqual(current.getSnapshot().blocks.map(block => block.id), ['outside']); assert.deepEqual(new Set(current.getSnapshot().retiredBlockIds), new Set(['s', 'nested', 'child']));
});

test('identical immediate retries are idempotent; changed and consumed IDs fail', () => {
  const current = editor(); let events = 0; current.subscribe(() => { events++; });
  const tx = transaction(current, [{ type: 'insertBlock', block: input('a') }]); const result = success(current.apply(tx));
  const retried = success(current.apply(JSON.parse(JSON.stringify(tx)) as unknown));
  assert.equal(retried.duplicate, true); assert.equal(retried.document, result.document); assert.equal(events, 1); assert.equal(current.getRevisions().length, 1);
  failure(current.apply({ ...tx, actor: agent }), 'duplicate'); failure(current.apply({ ...tx, baseRevision: 99 }), 'duplicate');
  apply(current, [{ type: 'setTitle', title: 'later' }]); failure(current.apply(tx), 'duplicate');
  const before = current.getSnapshot(); failure(current.apply({ ...tx, operations: [{ type: 'setTitle', title: 'reused' }] }), 'duplicate'); assert.equal(current.getSnapshot(), before);
  assert.equal(validateTransaction({ ...transaction(current, [{ type: 'setTitle', title: 'reserved' }]), id: 'history:undo:3' }).ok, false);
});

test('undo/redo produce new revisions and maintain content, ordering and block high-water versions', () => {
  const current = editor(); insert(current, input('a'), input('b'));
  const initial = contentState(current.getSnapshot());
  apply(current, [{ type: 'updateBlock', blockId: 'a', expectedVersion: 1, content: paragraph('edited') }, { type: 'moveBlock', blockId: 'a', expectedVersion: 2, parentId: null, afterId: 'b' }, { type: 'setTitle', title: 'edited title' }]);
  const edited = contentState(current.getSnapshot()); assert.equal(current.getSnapshot().blocks.find(block => block.id === 'a')?.version, 3);
  const undo = success(current.undo(human, 2)); assert.equal(undo.document.revision, 3); assert.deepEqual(contentState(undo.document), initial); assert.equal(undo.document.blocks.find(block => block.id === 'a')?.version, 4);
  const redo = success(current.redo(human, 3)); assert.equal(redo.document.revision, 4); assert.deepEqual(contentState(redo.document), edited); assert.equal(redo.document.blocks.find(block => block.id === 'a')?.version, 5);
  assert.deepEqual(current.getRevisions().map(revision => revision.kind), ['apply', 'apply', 'undo', 'redo']);
});

test('undo restores deleted descendants at higher versions to prevent ABA conflicts', () => {
  const current = editor(); insert(current, input('section', null, { type: 'section', title: 'S' }), input('child', 'section'));
  const stale = transaction(current, [{ type: 'updateBlock', blockId: 'child', expectedVersion: 1, content: paragraph('stale') }], { actor: agent, conflictPolicy: 'rebase-safe' });
  apply(current, [{ type: 'deleteBlock', blockId: 'section', expectedVersion: 1 }]);
  success(current.undo(human, current.getSnapshot().revision));
  assert.equal(current.getSnapshot().blocks.find(block => block.id === 'child')?.version, 3);
  assert.equal(current.getSnapshot().retiredBlockIds.includes('child'), true); assert.equal(validateDocument(current.getSnapshot()).ok, true);
  failure(current.apply(stale), 'conflict');
  success(current.redo(human, current.getSnapshot().revision)); success(current.undo(human, current.getSnapshot().revision));
  assert.equal(current.getSnapshot().blocks.find(block => block.id === 'child')?.version, 5);
});

test('undo of insertion reserves IDs even when redo is abandoned and the document reloads', () => {
  const current = editor(); const insertTx = transaction(current, [{ type: 'insertBlock', block: input('abandoned') }]); success(current.apply(insertTx));
  success(current.undo(human, 1)); failure(current.apply(insertTx), 'duplicate');
  assert.equal(current.getSnapshot().retiredBlockIds.includes('abandoned'), true);
  apply(current, [{ type: 'setTitle', title: 'new branch' }]); failure(current.redo(human, current.getSnapshot().revision), 'history');
  failure(current.apply(transaction(current, [{ type: 'insertBlock', block: input('abandoned') }])), 'duplicate');
  const reloaded = createEditor(current.getSnapshot(), { now: () => at });
  failure(reloaded.apply(transaction(reloaded, [{ type: 'insertBlock', block: input('abandoned') }])), 'duplicate');
  assert.equal(reloaded.getRevisions().length, 0); failure(reloaded.undo(human, reloaded.getSnapshot().revision), 'history');
});

test('session history is bounded and zero disables undo without disabling commits', () => {
  const current = editor({ historyLimit: 2 });
  for (const title of ['one', 'two', 'three']) apply(current, [{ type: 'setTitle', title }]);
  assert.equal(current.getRevisions().length, 2); success(current.undo(human, 3)); success(current.undo(human, 4)); failure(current.undo(human, 5), 'history');
  assert.equal(current.getSnapshot().title, 'one');
  const disabled = editor({ historyLimit: 0 }); apply(disabled, [{ type: 'setTitle', title: 'still committed' }]); failure(disabled.undo(human, 1), 'history');
  for (const historyLimit of [-1, 1.5, Infinity, 1_001]) assert.throws(() => editor({ historyLimit }), TypeError);
});

test('history request validation and exact revision guards protect undo and redo', () => {
  const current = editor(); insert(current, input('a')); const before = current.getSnapshot();
  failure(current.undo({ id: 'bad', kind: 'intruder' } as unknown as Actor, 1), 'validation');
  failure(current.undo(human, NaN), 'validation'); failure(current.undo(human, 0), 'conflict'); assert.equal(current.getSnapshot(), before);
  success(current.undo(human, 1)); failure(current.redo(human, 1), 'conflict'); success(current.redo(human, 2));
});

test('clock errors and backward time fail without changing any state', () => {
  let clockValue = at; const current = editor({ now: () => clockValue }); insert(current, input('a')); const before = current.getSnapshot();
  for (const bad of ['not-time', '2026-02-30T00:00:00Z', '2026-10-03T11:59:59Z']) { clockValue = bad; failure(current.apply(transaction(current, [{ type: 'setTitle', title: 'bad' }])), 'validation'); failure(current.undo(human, 1), 'validation'); assert.equal(current.getSnapshot(), before); }
  clockValue = '2026-10-03T12:00:01Z'; apply(current, [{ type: 'setTitle', title: 'later' }]); assert.equal(current.getSnapshot().updatedAt, clockValue);
  assert.throws(() => createDocument({ id: 'bad', title: 'Bad' }, { now: () => 'bad' }));
});

test('safe integer revision and block version overflow fail atomically', () => {
  const current = editor(); insert(current, input('a'));
  const exhausted = mutable(current.getSnapshot()); exhausted.revision = Number.MAX_SAFE_INTEGER;
  const maxRevision = createEditor(exhausted, { now: () => at }); const before = maxRevision.getSnapshot();
  failure(maxRevision.apply(transaction(maxRevision, [{ type: 'setTitle', title: 'overflow' }])), 'conflict'); assert.equal(maxRevision.getSnapshot(), before);
  const exhaustedBlock = mutable(current.getSnapshot()); exhaustedBlock.blocks[0]!.version = Number.MAX_SAFE_INTEGER;
  const maxBlock = createEditor(exhaustedBlock, { now: () => at }); const blockBefore = maxBlock.getSnapshot();
  failure(maxBlock.apply(transaction(maxBlock, [{ type: 'updateBlock', blockId: 'a', expectedVersion: Number.MAX_SAFE_INTEGER, content: paragraph('overflow') }])), 'conflict');
  failure(maxBlock.apply(transaction(maxBlock, [{ type: 'deleteBlock', blockId: 'a', expectedVersion: Number.MAX_SAFE_INTEGER }])), 'conflict'); assert.equal(maxBlock.getSnapshot(), blockBefore);
});

test('size limits reject oversized operation batches and fields before commit', () => {
  const current = editor();
  assert.equal(validateTransaction(transaction(current, Array.from({ length: LIMITS.operations + 1 }, () => ({ type: 'setTitle', title: 'x' })))).ok, false);
  failure(current.apply(transaction(current, [{ type: 'insertBlock', block: input('large', null, paragraph('x'.repeat(LIMITS.text + 1))) }])), 'validation');
  assert.equal(parseDocument(' '.repeat(LIMITS.json + 1)).ok, false);
});

test('mixed report edits can all undo and redo without changing ordered content or regressing versions', () => {
  const current = editor({ historyLimit: 100 }); const states: unknown[] = [contentState(current.getSnapshot())];
  const highest = new Map<string, number>();
  const verifyVersions = () => {
    for (const block of current.getSnapshot().blocks) { assert.ok(block.version >= (highest.get(block.id) ?? 0)); highest.set(block.id, block.version); }
    assert.equal(validateDocument(current.getSnapshot()).ok, true);
  };
  const edits: Operation[][] = [
    [{ type: 'insertBlock', block: input('s', null, { type: 'section', title: 'S' }) }],
    [{ type: 'insertBlock', block: input('a', 's') }, { type: 'insertBlock', block: input('b', 's') }],
    [{ type: 'updateBlock', blockId: 'a', expectedVersion: 1, content: paragraph('edit 1') }],
    [{ type: 'moveBlock', blockId: 'b', expectedVersion: 1, parentId: null, afterId: 's' }],
    [{ type: 'setTitle', title: 'renamed' }, { type: 'setFormat', format: { page: 'letter', font: 'mono', fontSize: 14, lineHeight: 1.5 } }],
    [{ type: 'deleteBlock', blockId: 's', expectedVersion: 1 }],
    [{ type: 'insertBlock', block: input('new') }],
  ];
  for (const operations of edits) { apply(current, operations); states.push(contentState(current.getSnapshot())); verifyVersions(); }
  for (let index = states.length - 2; index >= 0; index--) { success(current.undo(human, current.getSnapshot().revision)); assert.deepEqual(contentState(current.getSnapshot()), states[index]); verifyVersions(); }
  for (let index = 1; index < states.length; index++) { success(current.redo(human, current.getSnapshot().revision)); assert.deepEqual(contentState(current.getSnapshot()), states[index]); verifyVersions(); }
});
