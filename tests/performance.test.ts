import assert from 'node:assert/strict';
import test from 'node:test';
import { measure, measureRetired } from '../benchmarks/apply.js';

// Budgets have ~5x headroom over a laptop run (10 ms at the 5,000-block limit) so they catch a return to O(document) validation
// (139 ms before incremental validation) without failing on a slow CI machine.
test('a one-block edit stays cheap at the 5,000-block document limit', () => {
  const small = measure(100, 11), large = measure(5_000, 11);
  assert.ok(large.applyMedianMs < 60, `5,000 blocks: median ${large.applyMedianMs.toFixed(1)} ms`);
  assert.ok(small.applyMedianMs < 20, `100 blocks: median ${small.applyMedianMs.toFixed(1)} ms`);
});

// Before the retired-ID list was shared between snapshots, an edit re-read all 100,000 IDs: 51 ms median at 99,500 (1.3 ms with none).
test('a one-block edit stays cheap in a document that already reserves 99,500 deleted IDs', () => {
  const row = measureRetired(1_000, 99_500, 11);
  assert.ok(row.applyMedianMs < 15, `99,500 retired: median ${row.applyMedianMs.toFixed(1)} ms`);
});
