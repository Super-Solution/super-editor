import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createEditor, RETIRED_LIMIT, RETIRED_WARNING, validateDocument } from '../packages/core/src/index.js';
import type { Actor, Block, ResearchDocument } from '../packages/core/src/index.js';

const at = '2026-10-03T12:00:00.000Z';
const actor: Actor = { id: 'analyst', kind: 'human' };
const block = (id: string): Block => ({ id, parentId: null, content: { type: 'paragraph', runs: [{ text: id }] }, citationIds: [], version: 1, createdAt: at, updatedAt: at });
const withRetired = (count: number, blocks: Block[] = []): ResearchDocument => ({ ...createDocument({ id: 'long-lived', title: 'Long lived' }, { now: () => at }), blocks, retiredBlockIds: Array.from({ length: count }, (_, index) => `old-${index}`) });
let sequence = 0;
const tx = (revision: number, operations: unknown[]) => ({ id: `r-${++sequence}`, actor, baseRevision: revision, operations });

test('an edit shares the retired-ID list instead of copying it, and a delete adds exactly the deleted IDs', () => {
  const editor = createEditor(withRetired(1_000, [block('a'), block('b')]), { now: () => at });
  const before = editor.getSnapshot().retiredBlockIds;
  const edited = editor.apply(tx(0, [{ type: 'updateBlock', blockId: 'a', expectedVersion: 1, content: { type: 'paragraph', runs: [{ text: 'new' }] } }]));
  assert.equal(edited.ok, true);
  assert.equal(editor.getSnapshot().retiredBlockIds, before, 'the frozen list is the same object');
  const removed = editor.apply(tx(1, [{ type: 'deleteBlocks', blocks: [{ blockId: 'a', expectedVersion: 2 }] }]));
  assert.equal(removed.ok, true);
  const after = editor.getSnapshot().retiredBlockIds;
  assert.equal(after.length, 1_001); assert.equal(after[1_000], 'a'); assert.equal(before.length, 1_000, 'the earlier snapshot is untouched');
  assert.equal(validateDocument(editor.getSnapshot()).ok, true);
});

test('a retired ID can never be reused, including one retired by an earlier edit of the same session', () => {
  const editor = createEditor(withRetired(10, [block('a')]), { now: () => at });
  const reuse = (id: string, revision: number) => editor.apply(tx(revision, [{ type: 'insertBlock', block: { id, parentId: null, content: { type: 'paragraph', runs: [{ text: 'x' }] }, citationIds: [] } }]));
  const old = reuse('old-3', 0);
  assert.equal(old.ok, false); assert.equal((old as { issues: { code: string }[] }).issues[0]!.code, 'duplicate');
  assert.equal(editor.apply(tx(0, [{ type: 'deleteBlocks', blocks: [{ blockId: 'a', expectedVersion: 1 }] }])).ok, true);
  const again = reuse('a', 1);
  assert.equal(again.ok, false); assert.equal((again as { issues: { code: string }[] }).issues[0]!.code, 'duplicate');
});

test('undo and redo keep the retired list and still reserve the IDs they removed', () => {
  const editor = createEditor(withRetired(5, [block('a'), block('b')]), { now: () => at });
  assert.equal(editor.apply(tx(0, [{ type: 'deleteBlocks', blocks: [{ blockId: 'a', expectedVersion: 1 }] }])).ok, true);
  const undone = editor.undo(actor, 1);
  assert.equal(undone.ok, true);
  assert.deepEqual(editor.getSnapshot().blocks.map(entry => entry.id), ['a', 'b']);
  assert.equal(editor.getSnapshot().retiredBlockIds.includes('a'), true, 'the restored block keeps its retired reservation');
  assert.equal(editor.getSnapshot().retiredBlockIds.length, 6);
  assert.equal(editor.redo(actor, 2).ok, true);
  assert.deepEqual(editor.getSnapshot().blocks.map(entry => entry.id), ['b']);
  assert.equal(editor.getSnapshot().retiredBlockIds.length, 6, 'no ID is listed twice');
  assert.equal(validateDocument(editor.getSnapshot()).ok, true);
});

test('past the limit the rejection says how to get out, and a document at the limit is still accepted', () => {
  const full = withRetired(RETIRED_LIMIT, [block('a'), block('b')]);
  const editor = createEditor(full, { now: () => at });
  const rejected = editor.apply(tx(0, [{ type: 'deleteBlocks', blocks: [{ blockId: 'a', expectedVersion: 1 }] }]));
  assert.equal(rejected.ok, false);
  const issue = (rejected as { issues: { code: string; path?: string; message: string; hint?: string }[] }).issues[0]!;
  assert.equal(issue.code, 'validation'); assert.equal(issue.path, 'document.retiredBlockIds');
  assert.match(issue.message, /at most 100000 entries/); assert.match(issue.hint ?? '', /reserved forever/); assert.match(issue.hint ?? '', /new document/);
  assert.equal(editor.getSnapshot().blocks.length, 2, 'nothing was committed');
  const parsed = validateDocument(withRetired(RETIRED_LIMIT + 1));
  assert.equal(parsed.ok, false); assert.match(parsed.ok ? '' : parsed.issues[0]!.hint ?? '', /reserved forever/);
});

test('an edit carries a warning once 80% of the retired IDs are used, and not before', () => {
  const calm = createEditor(withRetired(RETIRED_WARNING - 2, [block('a'), block('b'), block('c')]), { now: () => at });
  const first = calm.apply(tx(0, [{ type: 'deleteBlocks', blocks: [{ blockId: 'a', expectedVersion: 1 }] }]));
  assert.equal(first.ok && first.warnings, undefined);
  const second = calm.apply(tx(1, [{ type: 'deleteBlocks', blocks: [{ blockId: 'b', expectedVersion: 1 }] }]));
  assert.ok(second.ok && second.warnings?.length === 1);
  const warning = second.ok ? second.warnings![0]! : undefined;
  assert.equal(warning?.code, 'retired-ids-near-limit'); assert.equal(warning?.used, RETIRED_WARNING); assert.equal(warning?.limit, RETIRED_LIMIT);
  assert.match(warning?.hint ?? '', /reserved forever/);
  const plain = calm.apply(tx(2, [{ type: 'updateBlock', blockId: 'c', expectedVersion: 1, content: { type: 'paragraph', runs: [{ text: 'still warned' }] } }]));
  assert.ok(plain.ok && plain.warnings?.[0]?.code === 'retired-ids-near-limit', 'an ordinary edit keeps reminding the host');
});
