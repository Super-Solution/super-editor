import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewProposal } from '../packages/core/src/index.js';
import { createResearchExample } from '../examples/report.js';

const agent = { id: 'research-agent', kind: 'agent' as const };
const base = () => createResearchExample().getSnapshot();
const tx = (document: ReturnType<typeof base>, operations: unknown[], extra: Record<string, unknown> = {}) => ({ id: `p-${Math.random().toString(36).slice(2)}`, actor: agent, baseRevision: document.revision, operations, ...extra });

test('a valid proposal is previewed without touching the document', () => {
  const document = base();
  const summary = document.blocks.find((block) => block.id === 'macro-summary')!;
  const review = reviewProposal(document, tx(document, [
    { type: 'updateBlock', blockId: 'macro-summary', expectedVersion: summary.version, content: { type: 'paragraph', runs: [{ text: 'Revised outlook.' }] } },
    { type: 'insertBlock', block: { id: 'new-note', parentId: null, citationIds: [], content: { type: 'paragraph', runs: [{ text: 'Added by the agent.' }] } } },
    { type: 'setTitle', title: 'Renamed report' },
  ]));
  assert.equal(review.status, 'ready');
  assert.match(review.summary, /Agent research-agent/);
  assert.deepEqual(review.changes.map((change) => [change.kind, change.blockId]), [['added', 'new-note'], ['changed', 'macro-summary']]);
  assert.equal(review.changes[1]?.after, 'Revised outlook.');
  assert.match(review.changes[1]?.before ?? '', /growth moderates/);
  assert.deepEqual(review.title, { before: 'Weekly research notebook', after: 'Renamed report' });
  assert.equal(review.after?.revision, document.revision + 1);
  assert.equal(document.revision, 1);
  assert.ok(!document.blocks.some((block) => block.id === 'new-note'));
});

test('a proposal made against an older revision is stale, and a malformed or rejected one is invalid', () => {
  const document = base();
  const stale = reviewProposal(document, tx(document, [{ type: 'setTitle', title: 'Old base' }], { baseRevision: 0 }));
  assert.equal(stale.status, 'stale');
  assert.equal(stale.issues[0]?.code, 'conflict');
  assert.equal(stale.baseRevision, 0);
  assert.equal(stale.currentRevision, 1);
  assert.equal(stale.after, null);
  assert.match(stale.summary, /research-agent/);

  const malformed = reviewProposal(document, { nonsense: true });
  assert.equal(malformed.status, 'invalid');
  assert.equal(malformed.transaction, null);
  assert.ok(malformed.issues.every((issue) => typeof issue.hint === 'string'));

  const rejected = reviewProposal(document, tx(document, [{ type: 'deleteBlock', blockId: 'does-not-exist', expectedVersion: 1 }]));
  assert.equal(rejected.status, 'invalid');
  assert.equal(rejected.issues[0]?.code, 'not-found');
});

test('removed and moved blocks are listed', () => {
  const document = base();
  const next = document.blocks.find((block) => block.id === 'next-steps')!;
  const removed = reviewProposal(document, tx(document, [{ type: 'deleteBlock', blockId: 'next-steps', expectedVersion: next.version }]));
  assert.deepEqual(removed.changes.map((change) => [change.kind, change.blockId]), [['removed', 'next-steps']]);
  const table = document.blocks.find((block) => block.id === 'research-table')!;
  const moved = reviewProposal(document, tx(document, [{ type: 'moveBlock', blockId: 'research-table', expectedVersion: table.version, parentId: 'macro', afterId: null }]));
  assert.deepEqual(moved.changes.map((change) => [change.kind, change.blockId]), [['moved', 'research-table']]);
});
