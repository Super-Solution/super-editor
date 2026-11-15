// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
/**
 * Cost of one small edit as the document grows. Run with `npm run bench`.
 * A single-block update must not scale with document size: `apply` re-validates only what changed.
 */
import { LIMITS, createDocument, createEditor } from '../packages/core/src/index.js';
import type { BlockInput, Editor } from '../packages/core/src/index.js';

export type BenchRow = { blocks: number; jsonMegabytes: number; insertMs: number; applyMedianMs: number; applyMaxMs: number };
const actor = { id: 'bench', kind: 'agent' as const };

export function seeded(count: number): { editor: Editor; insertMs: number } {
  const editor = createEditor(createDocument({ id: 'bench', title: 'Benchmark' }));
  const blocks: BlockInput[] = Array.from({ length: count }, (_, index) => ({ id: `b${index}`, parentId: null, citationIds: [], content: { type: 'paragraph', runs: [{ text: `Paragraph ${index} `.repeat(20) }] } }));
  const operations = Array.from({ length: Math.ceil(count / LIMITS.blocksPerOperation) }, (_, chunk) => ({ type: 'insertBlocks' as const, blocks: blocks.slice(chunk * LIMITS.blocksPerOperation, (chunk + 1) * LIMITS.blocksPerOperation) }));
  const started = performance.now();
  const result = editor.apply({ id: 'seed', actor, baseRevision: 0, operations });
  if (!result.ok) throw new Error(`Seeding ${count} blocks failed: ${result.issues[0]?.message}`);
  return { editor, insertMs: performance.now() - started };
}

export function measure(count: number, samples = 21): BenchRow {
  const { editor, insertMs } = seeded(count);
  const times: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const current = editor.getSnapshot(), block = current.blocks[Math.floor(count / 2)]!;
    const started = performance.now();
    const result = editor.apply({ id: `u${index}`, actor, baseRevision: current.revision, operations: [{ type: 'updateBlock', blockId: block.id, expectedVersion: block.version, content: { type: 'paragraph', runs: [{ text: `edited ${index}` }] } }] });
    times.push(performance.now() - started);
    if (!result.ok) throw new Error(result.issues[0]?.message);
  }
  times.sort((a, b) => a - b);
  return { blocks: count, jsonMegabytes: JSON.stringify(editor.getSnapshot()).length / 1e6, insertMs, applyMedianMs: times[Math.floor(times.length / 2)]!, applyMaxMs: times[times.length - 1]! };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  console.log('blocks  json(MB)  seed(ms)  apply median(ms)  apply max(ms)');
  for (const count of [100, 1_000, LIMITS.blocks]) {
    const row = measure(count);
    console.log(`${String(row.blocks).padStart(6)}  ${row.jsonMegabytes.toFixed(2).padStart(8)}  ${row.insertMs.toFixed(0).padStart(8)}  ${row.applyMedianMs.toFixed(1).padStart(16)}  ${row.applyMaxMs.toFixed(1).padStart(13)}`);
  }
}
