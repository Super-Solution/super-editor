import assert from 'node:assert/strict';
import test from 'node:test';
import { measure } from '../benchmarks/apply.js';

// Budgets have ~5x headroom over a laptop run (10 ms at the 5,000-block limit) so they catch a return to O(document) validation
// (139 ms before incremental validation) without failing on a slow CI machine.
test('a one-block edit stays cheap at the 5,000-block document limit', () => {
  const small = measure(100, 11), large = measure(5_000, 11);
  assert.ok(large.applyMedianMs < 60, `5,000 blocks: median ${large.applyMedianMs.toFixed(1)} ms`);
  assert.ok(small.applyMedianMs < 20, `100 blocks: median ${small.applyMedianMs.toFixed(1)} ms`);
});
