import { LIMITS, blockText, orderedBlocks } from '@super-solution/editor-core';
import type { BlockType, Operation, ResearchDocument } from '@super-solution/editor-core';

/** Find and replace over the document's human-visible text, with the same text fields `replaceText` edits. */
export type FindOptions = { caseSensitive?: boolean };
export type BlockMatch = { blockId: string; version: number; type: BlockType; count: number; preview: string };
export type FindResult = { query: string; blocks: BlockMatch[]; total: number };

function pattern(query: string, caseSensitive: boolean): RegExp | null {
  if (!query || query.length > LIMITS.searchText) return null;
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
}
export function countMatches(text: string, query: string, caseSensitive = false): number {
  const expression = pattern(query, caseSensitive);
  return expression ? (text.match(expression) ?? []).length : 0;
}
/** Splits text into alternating plain and matching parts. Concatenating the parts returns the original text. */
export function splitMatches(text: string, query: string, caseSensitive = false): { text: string; match: boolean }[] {
  const expression = pattern(query, caseSensitive);
  if (!expression || !text) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  let last = 0;
  for (const found of text.matchAll(expression)) {
    if (found[0] === '') continue;
    if (found.index > last) parts.push({ text: text.slice(last, found.index), match: false });
    parts.push({ text: found[0], match: true });
    last = found.index + found[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts.length ? parts : [{ text, match: false }];
}
function preview(text: string, query: string, caseSensitive: boolean): string {
  const expression = pattern(query, caseSensitive);
  const first = expression ? expression.exec(text) : null;
  const flat = text.replace(/\s+/g, ' ');
  if (!first) return flat.slice(0, 80);
  const at = flat.toLowerCase().indexOf(first[0].toLowerCase());
  const start = Math.max(0, at - 28), end = Math.min(flat.length, at + first[0].length + 40);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
/** Blocks that contain `query`, in reading order, with a match count and a short preview each. */
export function findMatches(report: Pick<ResearchDocument, 'blocks'>, query: string, options: FindOptions = {}): FindResult {
  const caseSensitive = options.caseSensitive === true;
  const blocks: BlockMatch[] = [];
  let total = 0;
  if (pattern(query, caseSensitive)) {
    for (const block of orderedBlocks(report)) {
      const text = blockText(block), count = countMatches(text, query, caseSensitive);
      if (!count) continue;
      total += count;
      blocks.push({ blockId: block.id, version: block.version, type: block.content.type, count, preview: preview(text, query, caseSensitive) });
    }
  }
  return { query, blocks, total };
}
/**
 * One `replaceText` operation per matching block, each guarded by the block version the match was found at.
 * `all: false` replaces the first occurrence in each block listed.
 */
export function replaceOperations(matches: readonly BlockMatch[], find: string, replace: string, options: FindOptions & { all?: boolean } = {}): Operation[] {
  return matches.map((match): Operation => ({
    type: 'replaceText', blockId: match.blockId, expectedVersion: match.version, find, replace,
    ...(options.all === false ? {} : { all: true }), ...(options.caseSensitive ? { caseSensitive: true } : {}),
  }));
}
