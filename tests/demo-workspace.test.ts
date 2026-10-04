import assert from 'node:assert/strict';
import test from 'node:test';
import { TEMPLATE_KINDS, diffDocuments, parseDocument, transaction, validateDocument } from '@super-solution/editor-core';
import { AGENT, REVIEWER, SCENARIOS, createAgent } from '../examples/demo/agent.js';
import { TEMPLATES, emptyPage, startPages, templatePage } from '../examples/demo/documents.js';
import { EXPORTS } from '../examples/demo/export.js';
import { restoreRevision, sameContent } from '../examples/demo/restore.js';

test('the demo opens both fixtures, every template kind and an empty page', () => {
  const [research, everything] = startPages();
  assert.equal(research!.name, 'Research report');
  assert.equal(everything!.name, 'Every block & chart');
  assert.deepEqual(TEMPLATES.map((template) => template.kind), [...TEMPLATE_KINDS]);
  for (const kind of TEMPLATE_KINDS) {
    const page = templatePage(kind);
    assert.ok(page.editor.getSnapshot().blocks.length > 0, kind);
    assert.equal(validateDocument(page.editor.getSnapshot()).ok, true, kind);
    assert.equal(page.baseline.revision, 1, 'the seed is the baseline; undo cannot erase it');
  }
  assert.equal(emptyPage().editor.getSnapshot().blocks.length, 0);
  assert.equal(templatePage('macro').name, 'Macro outlook 2', 'repeated templates are numbered');
});

test('every page keeps a snapshot of each revision for History', () => {
  const page = startPages()[0]!;
  const result = transaction(page.editor, REVIEWER).setTitle('Renamed').commit();
  assert.equal(result.ok, true);
  assert.deepEqual([...page.snapshots.keys()], [1, 2]);
  assert.equal(page.snapshots.get(1)!.title, 'Weekly research notebook');
  assert.equal(page.snapshots.get(2)!.title, 'Renamed');
});

test('exports render every fixture in every format; JSON parses back to the same document', () => {
  for (const page of startPages()) {
    const report = page.editor.getSnapshot();
    for (const format of EXPORTS) assert.ok(format.render(report).length > 100, `${page.name} as ${format.extension}`);
    const parsed = parseDocument(EXPORTS[0]!.render(report));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.value, report);
  }
});

test('restore returns a page to an earlier revision as one new, guarded revision', () => {
  const page = startPages()[0]!, { editor } = page;
  const baseline = editor.getSnapshot();
  const tx = transaction(editor, REVIEWER);
  tx.setTitle('Renamed')
    .update('macro-summary', { type: 'paragraph', runs: [{ text: 'Edited by a person.' }] })
    .remove('next-steps', 'research-table')            // deleted blocks come back under fresh ids
    .move('allocation', 'macro')                       // moved to another section
    .insert({ id: 'extra', parentId: 'portfolio', citationIds: [], content: { type: 'paragraph', runs: [{ text: 'Added later.' }] } })
    .addCitation({ id: 'late', title: 'A late source', url: 'https://example.com/late', accessedAt: '2026-10-05T00:00:00.000Z' });
  assert.equal(tx.commit().ok, true);
  assert.equal(sameContent(editor.getSnapshot(), baseline), false);

  const before = editor.getSnapshot().revision;
  const restored = restoreRevision(editor, baseline, REVIEWER);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(editor.getSnapshot().revision, before + 1, 'one revision');
  assert.equal(sameContent(editor.getSnapshot(), baseline), true, 'same content, ids aside');
  assert.equal(editor.getRevisions().at(-1)!.actor.kind, 'human');
  assert.ok(editor.getSnapshot().blocks.some((block) => block.id.startsWith('next-steps-restored-')), 'a deleted id stays retired, so the block returns under a new one');

  const again = restoreRevision(editor, baseline, REVIEWER);
  assert.equal(again.ok, false, 'nothing left to restore');
  assert.equal(editor.getSnapshot().revision, before + 1);
});

test('restore brings back a whole deleted section with its children, nested under the new section id', () => {
  const { editor, baseline } = startPages()[0]!;
  assert.equal(transaction(editor, REVIEWER).remove('portfolio').commit().ok, true);
  assert.equal(editor.getSnapshot().blocks.some((block) => block.id.startsWith('portfolio')), false);
  assert.equal(restoreRevision(editor, baseline, REVIEWER).ok, true);
  assert.equal(sameContent(editor.getSnapshot(), baseline), true);
  const section = editor.getSnapshot().blocks.find((block) => block.id.startsWith('portfolio-restored-'))!;
  assert.ok(editor.getSnapshot().blocks.filter((block) => block.parentId === section.id).length >= 5);
});

test('restore can also move forward again to a later revision', () => {
  const { editor, snapshots } = startPages()[1]!;
  assert.equal(transaction(editor, REVIEWER).remove('details').commit().ok, true);
  const removed = editor.getSnapshot();
  assert.equal(restoreRevision(editor, snapshots.get(1)!, REVIEWER).ok, true);
  assert.equal(restoreRevision(editor, removed, REVIEWER).ok, true);
  assert.equal(sameContent(editor.getSnapshot(), removed), true);
  assert.equal(diffDocuments(removed, editor.getSnapshot()).removed.length, 0);
});

test('agent scenarios: writes land, a stale update is refused with a hint, rebase-safe goes through, dry run changes nothing', () => {
  const ran = (id: string, page = startPages()[0]!, dryRun = false) => {
    const scenario = SCENARIOS.find((entry) => entry.id === id)!;
    const steps = scenario.run(createAgent(page.editor, dryRun), 0);
    return { steps, page };
  };
  for (const id of ['chart', 'markdown', 'replace', 'cite']) {
    const { steps, page } = ran(id);
    assert.ok(steps.every((step) => step.outcome.ok), id);
    assert.ok(page.editor.getRevisions().some((revision) => revision.actor.id === AGENT.id), id);
  }

  const refused = ran('stale');
  assert.deepEqual(refused.steps.map((step) => step.actor), ['agent', 'human', 'agent']);
  const outcome = refused.steps[2]!.outcome;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.issues[0]!.code, 'conflict');
    assert.match(outcome.issues[0]!.hint ?? '', /Re-read/);
    assert.equal(outcome.currentRevision, refused.page.editor.getSnapshot().revision);
  }
  assert.equal(refused.page.editor.getRevisions().filter((revision) => revision.actor.kind === 'agent').length, 0, 'the refused agent edit left no revision');

  const rebased = ran('rebase');
  assert.ok(rebased.steps.every((step) => step.outcome.ok));
  assert.equal(rebased.page.editor.getRevisions().at(-1)!.rebasedFrom, 1, 'applied on top of a newer revision');

  const preview = ran('chart', startPages()[0]!, true);
  assert.equal(preview.page.editor.getSnapshot().revision, 1);
  const only = preview.steps[0]!.outcome;
  assert.ok(only.ok && only.dryRun === true);

  const empty = ran('replace', emptyPage());
  const missed = empty.steps[0]!.outcome;
  assert.ok(!missed.ok && missed.issues[0]!.code === 'not-found' && Boolean(missed.issues[0]!.hint));
});
