// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
// Hot-path timings for large documents: `npm run bench`. Numbers depend on the machine; compare before and after a change on the same one.
import { createDocument, createEditor, validateDocument, toMarkdown, toHTML, stats, findBlocks, getOutline, serializeDocument } from '../packages/core/src/index.js';
const actor = { id: 'a', kind: 'agent' as const };
function build(n: number) {
  const ed = createEditor(createDocument({ id: 'd', title: 'T' }), { historyLimit: 100 });
  const ops: any[] = [];
  for (let i = 0; i < n; i++) ops.push({ type: 'insertBlock', block: { id: 'b' + i, parentId: null, content: i % 10 === 0 ? { type: 'heading', level: 2, text: 'Heading ' + i } : { type: 'paragraph', runs: [{ text: 'Lorem ipsum dolor sit amet '.repeat(10) + i }] }, citationIds: [] } });
  for (let i = 0; i < n; i += 200) { const r = ed.apply({ id: 'ins' + i, actor, baseRevision: ed.getSnapshot().revision, operations: ops.slice(i, i + 200) }); if (!r.ok) throw new Error(JSON.stringify(r.issues[0])); }
  return ed;
}
function time<T>(label: string, f: () => T, reps = 1) { const t = performance.now(); let r; for (let i = 0; i < reps; i++) r = f(); console.log(label.padEnd(36), ((performance.now() - t) / reps).toFixed(2), 'ms'); return r!; }
for (const n of [500, 2000, 5000]) {
  console.log('--- blocks', n);
  const ed = time('build (batched inserts)', () => build(n));
  let rev = ed.getSnapshot().revision, k = 0;
  time('apply 1 updateBlock (avg of 20)', () => { const s = ed.getSnapshot(); const blk = s.blocks[Math.floor(s.blocks.length / 2)]!; const r = ed.apply({ id: 'u' + n + '-' + (k++), actor, baseRevision: s.revision, operations: [{ type: 'updateBlock', blockId: blk.id, expectedVersion: blk.version, content: { type: 'paragraph', runs: [{ text: 'x' + k }] } }] }); if (!r.ok) throw new Error(JSON.stringify(r.issues)); }, 20);
  const snap = ed.getSnapshot();
  time('validateDocument', () => validateDocument(snap), 5);
  time('toMarkdown', () => toMarkdown(snap), 5);
  time('toHTML', () => toHTML(snap), 5);
  time('stats', () => stats(snap), 5);
  time('findBlocks text', () => findBlocks(snap, { text: 'Lorem 49' }), 5);
  time('getOutline', () => getOutline(snap), 5);
  time('undo+redo', () => { const s = ed.getSnapshot(); const u = ed.undo(actor, s.revision); if (!u.ok) throw 1; const r = ed.redo(actor, u.document.revision); if (!r.ok) throw 2; }, 5);
  time('serialize', () => serializeDocument(snap), 5);
}
