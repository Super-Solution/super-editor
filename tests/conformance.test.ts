// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
// The TypeScript editor must still produce every outcome in conformance/guarded-apply.v1.json, the
// data the Go and Python ports are tested against. Regenerate with
// `npx tsx --conditions=development scripts/export-conformance.ts` when behaviour changes on purpose.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createEditor } from '../packages/core/src/index.js';

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
