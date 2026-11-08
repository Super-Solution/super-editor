// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
// The TypeScript editor must still produce every outcome in conformance/guarded-apply.v1.json, the
// data the Go and Python ports are tested against. Regenerate with
// `npx tsx --conditions=development scripts/export-conformance.ts` (and `scripts/export-document-conformance.ts`
// for document-ops.v1.json) when behaviour changes on purpose.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createEditor, diffDocuments, summarizeRevision } from '../packages/core/src/index.js';
import { textParts } from '../packages/core/src/text.js';
import { readActor, safeUrl, timestamp } from '../packages/core/src/validation.js';
import { validateDocument, validateTransaction } from '../packages/core/src/index.js';

const data = JSON.parse(readFileSync(new URL('../conformance/guarded-apply.v1.json', import.meta.url), 'utf8'));

test('the reference reproduces every conformance step', () => {
  let steps = 0;
  for (const scenario of data.scenarios) {
    let current = scenario.initial.createdAt;
    const editor = createEditor(scenario.initial, { now: () => current });
    for (const [index, step] of scenario.steps.entries()) {
      current = step.now;
      const result = editor.apply(step.transaction);
      const label = `${scenario.name} step ${index}`;
      assert.equal(result.ok, step.expect.ok, label);
      if (result.ok) {
        assert.equal(result.duplicate ?? undefined, step.expect.duplicate, label);
        assert.deepEqual(JSON.parse(JSON.stringify(result.document)), step.expect.document, label);
      } else {
        assert.deepEqual(result.issues.map(issue => ({ code: issue.code, ...(issue.blockId ? { blockId: issue.blockId } : {}) })), step.expect.issues, label);
        assert.equal(result.currentRevision, step.expect.currentRevision, label);
      }
      steps++;
    }
  }
  assert.ok(steps >= 250);
});

const ops = JSON.parse(readFileSync(new URL('../conformance/document-ops.v1.json', import.meta.url), 'utf8'));

test('the reference reproduces every document-ops case', () => {
  assert.ok(ops.text_parts.length >= 150 && ops.diff.length >= 150 && ops.summarize_revision.length >= 150);
  for (const [index, c] of ops.text_parts.entries()) assert.deepEqual(textParts(c.content), c.expect, `text_parts ${index}`);
  for (const [index, c] of ops.diff.entries()) assert.deepEqual(JSON.parse(JSON.stringify(diffDocuments(c.a, c.b))), c.expect, `diff ${index}`);
  for (const [index, c] of ops.summarize_revision.entries()) assert.equal(summarizeRevision(c.revision), c.expect, `summary ${index}`);
});

const validation = JSON.parse(readFileSync(new URL('../conformance/validation.v1.json', import.meta.url), 'utf8'));

test('the reference reproduces every validation case', () => {
  assert.ok(validation.cases.length >= 1000);
  const attempt = (read: () => unknown): unknown => {
    try { return { ok: true, value: read() }; } catch (error) { return { ok: false, issues: [(error as { issue: unknown }).issue] }; }
  };
  for (const [index, c] of validation.cases.entries()) {
    const label = `validation case ${index} (${c.kind})`;
    let got: unknown;
    if (c.kind === 'document') got = validateDocument(c.input);
    else if (c.kind === 'transaction') got = validateTransaction(c.input);
    else if (c.kind === 'actor') got = attempt(() => readActor(c.input));
    else if (c.kind === 'timestamp') got = attempt(() => timestamp(c.input));
    else { const href = safeUrl(c.input); got = href === null ? { ok: false, issues: [] } : { ok: true, value: href }; }
    assert.deepEqual(JSON.parse(JSON.stringify(got)), c.expect, label);
  }
});

const editorData = JSON.parse(readFileSync(new URL('../conformance/editor.v1.json', import.meta.url), 'utf8'));

test('the reference reproduces every editor scenario', () => {
  let steps = 0;
  for (const { scenario, steps: list } of editorData.scenarios) {
    let current = scenario.initial.createdAt;
    const editor = createEditor(scenario.initial, { now: () => current, ...(scenario.historyLimit === undefined ? {} : { historyLimit: scenario.historyLimit }) });
    for (const [index, step] of list.entries()) {
      current = step.now;
      const result = step.action === 'apply' ? editor.apply(step.input) : step.action === 'undo' ? editor.undo(step.input.actor, step.input.expectedRevision) : editor.redo(step.input.actor, step.input.expectedRevision);
      const got = result.ok
        ? { ok: true, ...(result.duplicate ? { duplicate: true } : {}), document: result.document, revision: result.revision }
        : { ok: false, issues: result.issues, currentRevision: result.currentRevision };
      assert.deepEqual(JSON.parse(JSON.stringify(got)), step.expect, `${scenario.name} step ${index}`);
      steps++;
    }
    assert.deepEqual(JSON.parse(JSON.stringify(editor.getRevisions())), scenario.revisions, `${scenario.name} revisions`);
    assert.deepEqual(JSON.parse(JSON.stringify(editor.getSnapshot())), scenario.final, `${scenario.name} final`);
  }
  assert.ok(steps >= 1000);
});
