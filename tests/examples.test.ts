import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createEditor, parseDocument } from '@super-solution/editor-core';
import { createResearchExample } from '../examples/report.js';

test('serialized Trading integration fixture accepts its guarded agent proposal', async () => {
  const parsed = parseDocument(await readFile(new URL('../examples/fixtures/research-report.v1.json', import.meta.url), 'utf8'));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const editor = createEditor(parsed.value, { now: () => '2026-10-03T01:00:00.000Z' });
  const proposal: unknown = JSON.parse(await readFile(new URL('../examples/fixtures/agent-update.json', import.meta.url), 'utf8'));
  const accepted = editor.apply(proposal);
  assert.equal(accepted.ok, true);
  assert.equal(editor.getSnapshot().revision, 2);
  assert.equal(editor.getSnapshot().blocks.find(block => block.id === 'portfolio-summary')?.version, 2);
  assert.equal(editor.apply(proposal).ok, true);
  assert.equal(editor.getSnapshot().revision, 2);
});

test('example undo affects session edits while retaining the loaded research baseline', () => {
  const editor = createResearchExample();
  const baseline = editor.getSnapshot();
  assert.equal(editor.undo({ id: 'reviewer', kind: 'human' }, baseline.revision).ok, false);
  const accepted = editor.apply({ id: 'example-note', actor: { id: 'reviewer', kind: 'human' }, baseRevision: baseline.revision,
    operations: [{ type: 'setTitle', title: 'Reviewed research notebook' }] });
  assert.equal(accepted.ok, true);
  const undone = editor.undo({ id: 'reviewer', kind: 'human' }, editor.getSnapshot().revision);
  assert.equal(undone.ok, true);
  assert.equal(editor.getSnapshot().title, baseline.title);
  assert.deepEqual(editor.getSnapshot().blocks, baseline.blocks);
  assert.equal(editor.getSnapshot().revision, baseline.revision + 2);
});
