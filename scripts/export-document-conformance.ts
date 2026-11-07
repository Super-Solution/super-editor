// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
// Writes conformance/document-ops.v1.json: language-neutral cases generated from the TypeScript
// reference for the pure document functions (block text extraction, structural diff between two
// documents, one-line revision summaries). Go and Python must reproduce every case exactly.
//
// Limits of the data: titles use BMP characters only (the reference slices UTF-16 code units), and
// objects keep a stable key order (the reference compares blocks through JSON.stringify).
import { writeFileSync } from 'node:fs';
import { diffDocuments, summarizeRevision } from '../packages/core/src/index.js';
import { textParts } from '../packages/core/src/text.js';

let seed = 20261108;
const rand = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const pick = <T,>(items: readonly T[]): T => items[rand(items.length)]!;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const chance = (n: number): boolean => rand(n) === 0;
const words = ['alpha', 'beta', '市場', 'rate', 'Q3', 'données', 'x', '日本語', 'tab\there', 'a b  c', ''];
const text = (): string => Array.from({ length: 1 + rand(3) }, () => pick(words)).join(' ');
const run = (): Record<string, unknown> => ({ text: text(), ...(chance(4) ? { bold: true } : {}), ...(chance(6) ? { citationId: 'c1' } : {}) });
const runs = (): Record<string, unknown>[] => Array.from({ length: 1 + rand(3) }, run);
const opt = <T,>(value: () => T, n = 2): { v?: T } => (chance(n) ? {} : { v: value() });

function content(type: string): Record<string, unknown> {
  switch (type) {
    case 'section': case 'toggle': return type === 'toggle' ? { type, title: text(), open: chance(2) } : { type, title: text() };
    case 'heading': return { type, level: 1 + rand(3), text: text() };
    case 'paragraph': return { type, runs: runs() };
    case 'quote': return { type, runs: runs(), ...(opt(text).v === undefined ? {} : { attribution: text() }) };
    case 'callout': return { type, tone: pick(['info', 'warning']), ...(chance(2) ? { title: text() } : {}), runs: runs() };
    case 'code': return { type, language: pick(['ts', 'py', '']), text: text() };
    case 'list': return { type, ordered: chance(2), items: Array.from({ length: rand(4) }, text) };
    case 'table': { const columns = Array.from({ length: 1 + rand(3) }, text); return { type, columns, rows: Array.from({ length: rand(3) }, () => columns.map(text)), ...(chance(2) ? { caption: text() } : {}) }; }
    case 'chart': return { type, spec: { kind: pick(['bar', 'pie', 'custom']), title: text(), labels: ['a', 'b'], series: [{ name: 's', values: [1, 2] }], ...(chance(2) ? { caption: text() } : {}) } };
    case 'embed': return { type, provider: 'superchart', url: 'https://example.com/chart', title: text() };
    case 'image': return { type, url: 'https://example.com/i.png', alt: text(), ...(chance(2) ? { caption: text() } : {}) };
    case 'metrics': return { type, items: Array.from({ length: rand(4) }, () => ({ label: text(), value: String(rand(100)), ...(chance(2) ? { hint: text() } : {}) })) };
    case 'timestamp': return { type, at: '2026-11-07T00:00:00Z', label: text() };
    default: return { type };
  }
}
const TYPES = ['section', 'heading', 'paragraph', 'list', 'table', 'chart', 'embed', 'timestamp', 'quote', 'callout', 'code', 'divider', 'image', 'toggle', 'metrics', 'toc', 'pageBreak'];

const textCases = [];
for (let i = 0; i < 160; i++) {
  const c = content(TYPES[i % TYPES.length]!);
  textCases.push({ content: c, expect: textParts(c as never) });
}

const format = { page: 'A4', font: 'sans', fontSize: 16, lineHeight: 1.5 };
function baseDoc(): Record<string, any> {
  const count = rand(9);
  const blocks: Record<string, any>[] = [];
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `b${i}`;
    const parent = ids.length && chance(3) ? pick(ids) : null;
    blocks.push({ id, parentId: parent, content: content(pick(TYPES)), citationIds: chance(3) ? ['c1'] : [], version: 1, createdAt: 't', updatedAt: 't' });
    ids.push(id);
  }
  const citations = Array.from({ length: rand(3) }, (_, i) => ({ id: `c${i + 1}`, title: text(), url: 'https://example.com', accessedAt: '2026-11-07T00:00:00Z' }));
  return { title: text(), format: clone(format), blocks, citations };
}
function mutate(doc: Record<string, any>): Record<string, any> {
  const next = clone(doc);
  for (let m = 0; m < 1 + rand(4); m++) {
    const blocks = next.blocks as Record<string, any>[];
    switch (rand(11)) {
      case 0: blocks.push({ id: `n${rand(1000)}-${blocks.length}`, parentId: null, content: content(pick(TYPES)), citationIds: [], version: 1, createdAt: 't', updatedAt: 't' }); break;
      case 1: if (blocks.length) blocks.splice(rand(blocks.length), 1); break;
      case 2: if (blocks.length) pick(blocks).content = content(pick(TYPES)); break;
      case 3: if (blocks.length) pick(blocks).citationIds = chance(2) ? [] : ['c1', 'c2']; break;
      case 4: if (blocks.length) { const b = pick(blocks); b.parentId = b.parentId === null ? pick(blocks).id : null; } break;
      case 5: if (blocks.length > 1) { const [b] = blocks.splice(rand(blocks.length), 1); blocks.splice(rand(blocks.length + 1), 0, b!); } break;
      case 6: if (blocks.length > 2) blocks.reverse(); break;
      case 7: next.title = text() + '!'; break;
      case 8: next.format = { ...next.format, fontSize: 14 + rand(8) }; break;
      case 9: next.citations.push({ id: `c${10 + rand(90)}`, title: text(), url: 'https://example.com/x', accessedAt: '2026-11-07T00:00:00Z' }); break;
      default: if (next.citations.length) { if (chance(2)) next.citations.splice(rand(next.citations.length), 1); else pick(next.citations as Record<string, any>[]).title = text() + '?'; }
    }
  }
  // A move that makes a block its own parent is not meaningful; the diff does not care, but keep data sane.
  for (const b of next.blocks as Record<string, any>[]) if (b.parentId === b.id) b.parentId = null;
  return next;
}
const diffCases = [];
for (let i = 0; i < 160; i++) {
  const a = baseDoc();
  const b = i % 10 === 0 ? clone(a) : mutate(a);
  diffCases.push({ a, b, expect: diffDocuments(a as never, b as never) });
}

const actorKinds = ['human', 'agent', 'system'];
const blockInput = (): Record<string, unknown> => ({ id: 'x' + rand(100), parentId: null, content: content('paragraph'), citationIds: [] });
function operation(type: string): Record<string, unknown> {
  const blockId = 'b' + rand(4);
  switch (type) {
    case 'insertBlock': return { type, block: blockInput() };
    case 'updateBlock': return { type, blockId, expectedVersion: 1, content: content('paragraph') };
    case 'moveBlock': return { type, blockId, expectedVersion: 1, parentId: null };
    case 'deleteBlock': return { type, blockId, expectedVersion: 1 };
    case 'setTitle': return { type, title: pick([text(), '短い題名', 'x'.repeat(60), 'y'.repeat(61), '題'.repeat(70), 'z'.repeat(57)]) };
    case 'setFormat': return { type, format: clone(format) };
    case 'addCitation': return { type, citation: { id: 'c' + rand(9), title: 't', url: 'https://e.com', accessedAt: 'x' } };
    case 'insertBlocks': return { type, blocks: Array.from({ length: rand(4) }, blockInput) };
    case 'duplicateBlock': return { type, blockId, expectedVersion: 1, newIds: { [blockId]: 'dup' + rand(9) } };
    case 'replaceText': return { type, blockId, expectedVersion: 1, find: 'a', replace: 'b' };
    case 'deleteBlocks': return { type, blocks: Array.from({ length: rand(4) }, () => ({ blockId: 'b' + rand(4), expectedVersion: 1 })) };
    case 'moveBlocks': return { type, blocks: Array.from({ length: rand(4) }, () => ({ blockId: 'b' + rand(4), expectedVersion: 1 })), parentId: null };
    case 'updateCitation': return { type, citation: { id: 'c' + rand(9), title: 't', url: 'https://e.com', accessedAt: 'x' } };
    default: return { type: 'removeCitation', citationId: 'c' + rand(9) };
  }
}
const OPS = ['insertBlock', 'updateBlock', 'moveBlock', 'deleteBlock', 'setTitle', 'setFormat', 'addCitation', 'insertBlocks', 'duplicateBlock', 'replaceText', 'deleteBlocks', 'moveBlocks', 'updateCitation', 'removeCitation'];
const summaryCases = [];
for (let i = 0; i < 200; i++) {
  const kind = i % 7 === 0 ? pick(['undo', 'redo']) : 'apply';
  const operations = kind === 'apply' ? Array.from({ length: rand(7) }, () => operation(pick(OPS))) : [];
  const revision = { number: i + 1, transactionId: `tx${i}`, actor: { id: pick(['agent-1', 'ann', 'sys']), kind: pick(actorKinds) }, at: '2026-11-07T00:00:00Z', kind, operations };
  summaryCases.push({ revision, expect: summarizeRevision(revision as never) });
}

const out = { version: 1, note: 'Generated by scripts/export-document-conformance.ts from the TypeScript reference. Blocks are compared structurally; summaries are exact strings.', text_parts: textCases, diff: diffCases, summarize_revision: summaryCases };
const lines = (key: 'text_parts' | 'diff' | 'summarize_revision'): string => out[key].map(c => '  ' + JSON.stringify(c)).join(',\n');
writeFileSync(new URL('../conformance/document-ops.v1.json', import.meta.url),
  `{\n "version": 1,\n "note": ${JSON.stringify(out.note)},\n` + (['text_parts', 'diff', 'summarize_revision'] as const).map(k => ` "${k}": [\n${lines(k)}\n ]`).join(',\n') + '\n}\n');
const changed = diffCases.filter(c => c.expect.added.length + c.expect.removed.length + c.expect.changed.length + c.expect.moved.length > 0).length;
const moved = diffCases.filter(c => c.expect.moved.length > 0).length;
console.log(`text ${textCases.length}, diff ${diffCases.length} (${changed} with block changes, ${moved} with moves), summaries ${summaryCases.length}`);
