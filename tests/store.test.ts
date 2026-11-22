import assert from 'node:assert/strict';
import test from 'node:test';
import { applyToDocument, createMemoryStore, createStoreService, openSnapshot, runAgentActionAsync } from '../packages/core/src/index.js';
import type { Actor, DocumentStore, ResearchDocument, Revision, SaveResult } from '../packages/core/src/index.js';
import { createHttpHandler } from '../backends/typescript/api/src/index.js';
import { createResearchExample } from '../examples/report.js';

const human: Actor = { id: 'analyst', kind: 'human' };
const tx = (document: ResearchDocument, id: string, text: string, baseRevision = document.revision) => ({
  id, actor: human, baseRevision,
  operations: [{ type: 'insertBlock', block: { id: `b-${id}`, parentId: null, content: { type: 'paragraph', runs: [{ text }] }, citationIds: [] } }],
});
const slowStore = (document: ResearchDocument): DocumentStore & { current(): ResearchDocument; saves: number } => {
  const inner = createMemoryStore(document);
  const store = {
    saves: 0,
    load: async () => { await new Promise(resolve => setTimeout(resolve, 1)); return inner.load(); },
    save: async (next: ResearchDocument, expected: number, revision: Revision): Promise<SaveResult> => { await new Promise(resolve => setTimeout(resolve, 1)); store.saves += 1; return inner.save(next, expected, revision); },
    revisions: () => inner.revisions!(),
    current: () => inner.current(),
  };
  return store;
};

test('applyToDocument applies one guarded transaction without a session and leaves the input untouched', () => {
  const document = createResearchExample().getSnapshot();
  const result = applyToDocument(document, tx(document, 'a1', 'Hello'));
  assert.equal(result.ok, true);
  assert.equal(document.revision, 1);
  if (result.ok) { assert.equal(result.document.revision, 2); assert.ok(result.document.blocks.some(block => block.id === 'b-a1')); }
  const stale = applyToDocument(document, tx(document, 'a2', 'Late', 0));
  assert.equal(stale.ok, false);
});

test('a store service saves with compare-and-swap, answers a retry from the log and reports a lost race', async () => {
  const store = slowStore(createResearchExample().getSnapshot());
  const service = createStoreService(store);
  const first = await service.apply(tx(await service.read(), 'a1', 'One'));
  assert.equal(first.ok, true);
  assert.equal(store.current().revision, 2);
  const retry = await service.apply(tx(store.current(), 'a1', 'One', 1));
  assert.equal(retry.ok && retry.duplicate, true);
  assert.equal(store.saves, 1);
  const changed = await service.apply({ ...tx(store.current(), 'a1', 'Different', 1) });
  assert.equal(changed.ok, false);
  assert.equal(changed.ok === false && changed.issues[0]?.code, 'duplicate');

  // Another process saves between this service's load and save: the CAS refuses and nothing is overwritten.
  const racing: DocumentStore = { ...store, save: async (next, expected, revision) => { await store.save(applyToDocumentFor(store.current(), 'other'), expected, revision); return store.save(next, expected, revision); } };
  const loser = await createStoreService(racing).apply(tx(store.current(), 'b1', 'Mine'));
  assert.equal(loser.ok, false);
  assert.equal(loser.ok === false && loser.issues[0]?.code, 'conflict');
  assert.equal(loser.ok === false && loser.currentRevision, store.current().revision);
  assert.ok(!store.current().blocks.some(block => block.id === 'b-b1'));
});
function applyToDocumentFor(document: ResearchDocument, id: string): ResearchDocument {
  const result = applyToDocument(document, tx(document, id, 'Other writer'));
  assert.ok(result.ok);
  return (result as { document: ResearchDocument }).document;
}

test('writes through one store service are serialized: one of several same-base edits wins and the rest conflict', async () => {
  const store = slowStore(createResearchExample().getSnapshot());
  const service = createStoreService(store);
  const base = store.current();
  const results = await Promise.all(['c1', 'c2', 'c3'].map(id => service.apply(tx(base, id, id, base.revision))));
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results.map(result => result.ok)));
  assert.equal(results.filter(result => !result.ok && result.issues[0]?.code === 'conflict').length, 2);
  assert.equal(store.current().revision, base.revision + 1);
  assert.equal(store.saves, 1);
});

test('undo and redo explain that a store keeps no session history', async () => {
  const service = createStoreService(createMemoryStore(createResearchExample().getSnapshot()));
  const result = await service.undo(human, 1);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.issues[0]?.code, 'history');
});

test('runAgentActionAsync runs the shared action table over an async service and persists writes', async () => {
  const store = slowStore(createResearchExample().getSnapshot());
  const service = createStoreService(store);
  const read = await runAgentActionAsync(service, 'get_outline', {}, { actor: human });
  assert.equal(read.ok, true);
  const write = await runAgentActionAsync(service, 'set_title', { title: 'Persisted title' }, { actor: human });
  assert.equal(write.ok, true, JSON.stringify(write));
  assert.equal(store.current().revision, 2);
  assert.equal(store.saves, 1);
  const revisions = await runAgentActionAsync(service, 'list_revisions', {}, { actor: human });
  assert.equal(revisions.ok && revisions.total, 1);
});

test('openSnapshot lets synchronous code run on an async service and flushes only what was written', async () => {
  const store = slowStore(createResearchExample().getSnapshot());
  const service = createStoreService(store);
  const snapshot = await openSnapshot(service);
  const document = snapshot.service.read();
  assert.equal(snapshot.service.apply(tx(document, 's1', 'Local')).ok, true);
  assert.equal(snapshot.pending().length, 1);
  assert.equal(store.current().revision, 1);
  assert.equal(await snapshot.flush(), undefined);
  assert.equal(store.current().revision, 2);
  assert.equal(snapshot.pending().length, 0);
});

const call = (http: (request: Request) => Promise<Response>, path: string, body?: unknown) =>
  http(new Request(`http://local${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

test('the HTTP handler runs over a store: reads, writes, conflicts and unknown routes', async () => {
  const store = slowStore(createResearchExample().getSnapshot());
  const http = createHttpHandler(createStoreService(store));
  assert.deepEqual(await (await call(http, '/health')).json(), { ok: true, revision: 1 });
  const document = await (await call(http, '/document')).json() as ResearchDocument;
  assert.equal(document.revision, 1);

  const applied = await call(http, '/transactions', tx(document, 'h1', 'Over HTTP'));
  assert.equal(applied.status, 200);
  assert.equal(store.current().revision, 2);

  const stale = await call(http, '/transactions', tx(document, 'h2', 'Stale', 1));
  assert.equal(stale.status, 409);
  const staleBody = await stale.json() as { currentRevision: number; issues: { code: string }[] };
  assert.equal(staleBody.currentRevision, 2);
  assert.equal(store.current().revision, 2);

  const missing = await call(http, '/nope');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as { currentRevision: number }).currentRevision, 2);

  const action = await call(http, '/actions/set_title', { title: 'Action over HTTP' });
  assert.equal(action.status, 200);
  assert.equal(store.current().revision, 3);

  const revisions = await (await call(http, '/revisions')).json() as { total: number };
  assert.equal(revisions.total, 2);
});

test('the HTTP handler turns a lost compare-and-swap into a 409 and writes nothing', async () => {
  const store = slowStore(createResearchExample().getSnapshot());
  const losing: DocumentStore = { ...store, save: async (_next, _expected, _revision): Promise<SaveResult> => ({ ok: false, currentRevision: 9 }) };
  const http = createHttpHandler(createStoreService(losing));
  const document = store.current();
  const response = await call(http, '/transactions', tx(document, 'r1', 'Racing'));
  assert.equal(response.status, 409);
  const body = await response.json() as { issues: { code: string }[]; currentRevision: number };
  assert.equal(body.issues[0]?.code, 'conflict');
  assert.equal(body.currentRevision, 9);
  assert.equal(store.current().revision, 1);
});

test('a store that fails to load answers a JSON 500, not a thrown error', async () => {
  const http = createHttpHandler(createStoreService({ load: () => { throw new Error('db down'); }, save: () => ({ ok: true }) }));
  const response = await call(http, '/document');
  assert.equal(response.status, 500);
  assert.equal((await response.json() as { ok: boolean }).ok, false);
});
