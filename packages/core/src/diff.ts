import type { Block, Operation, ResearchDocument, Revision } from './types.js';

export type DocumentDiff = {
  /** Block IDs present only in `b`. */
  added: string[];
  /** Block IDs present only in `a`. */
  removed: string[];
  /** Blocks in both whose content or block-level citations differ. */
  changed: string[];
  /** Blocks in both that changed parent or position among their siblings. */
  moved: string[];
  titleChanged: boolean;
  formatChanged: boolean;
  citations: { added: string[]; removed: string[]; changed: string[] };
};
type Source = Pick<ResearchDocument, 'blocks' | 'citations' | 'title' | 'format'>;

const fingerprint = (block: Block): string => JSON.stringify([block.content, block.citationIds]);
/** Longest increasing subsequence of `values` (as positions), so only the blocks outside it count as moved. */
function stable(values: number[]): Set<number> {
  const tails: number[] = [], previous: number[] = new Array<number>(values.length).fill(-1);
  values.forEach((value, index) => {
    let low = 0, high = tails.length;
    while (low < high) { const middle = (low + high) >> 1; if (values[tails[middle]!]! < value) low = middle + 1; else high = middle; }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  });
  const keep = new Set<number>();
  for (let cursor = tails.length ? tails[tails.length - 1]! : -1; cursor >= 0; cursor = previous[cursor]!) keep.add(cursor);
  return keep;
}

/** Structural comparison by block ID. Versions and timestamps are ignored: only content, parent and sibling order count. */
export function diffDocuments(a: Source, b: Source): DocumentDiff {
  const before = new Map(a.blocks.map(block => [block.id, block])), after = new Map(b.blocks.map(block => [block.id, block]));
  const added = b.blocks.filter(block => !before.has(block.id)).map(block => block.id), removed = a.blocks.filter(block => !after.has(block.id)).map(block => block.id);
  const changed: string[] = [], moved = new Set<string>();
  for (const block of b.blocks) {
    const old = before.get(block.id);
    if (!old) continue;
    if (fingerprint(old) !== fingerprint(block)) changed.push(block.id);
    if (old.parentId !== block.parentId) moved.add(block.id);
  }
  // Within each parent, blocks that kept their parent but fell out of the common order were reordered.
  const parents = new Set(b.blocks.map(block => block.parentId));
  for (const parentId of parents) {
    const order = new Map(a.blocks.filter(block => block.parentId === parentId).map((block, index) => [block.id, index]));
    const common = b.blocks.filter(block => block.parentId === parentId && order.has(block.id));
    const keep = stable(common.map(block => order.get(block.id)!));
    common.forEach((block, index) => { if (!keep.has(index)) moved.add(block.id); });
  }
  const oldCitations = new Map(a.citations.map(citation => [citation.id, citation])), newCitations = new Map(b.citations.map(citation => [citation.id, citation]));
  return { added, removed, changed, moved: b.blocks.filter(block => moved.has(block.id)).map(block => block.id), titleChanged: a.title !== b.title, formatChanged: JSON.stringify(a.format) !== JSON.stringify(b.format),
    citations: { added: b.citations.filter(citation => !oldCitations.has(citation.id)).map(citation => citation.id), removed: a.citations.filter(citation => !newCitations.has(citation.id)).map(citation => citation.id),
      changed: b.citations.filter(citation => oldCitations.has(citation.id) && JSON.stringify(oldCitations.get(citation.id)) !== JSON.stringify(citation)).map(citation => citation.id) } };
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const sentence = (parts: string[]): string => parts.length < 2 ? parts[0] ?? '' : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
function blocksTouched(operations: readonly Operation[], pick: (operation: Operation) => string[]): number { return new Set(operations.flatMap(pick)).size; }

/** One human sentence for a revision, for history lists and toasts. For example: "Agent research-agent inserted 3 blocks and replaced text in 1 block." */
export function summarizeRevision(revision: Revision): string {
  const who = `${revision.actor.kind.charAt(0).toUpperCase()}${revision.actor.kind.slice(1)} ${revision.actor.id}`;
  if (revision.kind === 'undo') return `${who} undid the previous change.`;
  if (revision.kind === 'redo') return `${who} redid a change.`;
  const ops = revision.operations, parts: string[] = [];
  const inserted = ops.reduce((sum, operation) => sum + (operation.type === 'insertBlock' ? 1 : operation.type === 'insertBlocks' ? operation.blocks.length : 0), 0);
  const duplicated = ops.filter(operation => operation.type === 'duplicateBlock').length;
  const edited = blocksTouched(ops, operation => operation.type === 'updateBlock' ? [operation.blockId] : []);
  const replaced = blocksTouched(ops, operation => operation.type === 'replaceText' ? [operation.blockId] : []);
  const moved = blocksTouched(ops, operation => operation.type === 'moveBlock' ? [operation.blockId] : operation.type === 'moveBlocks' ? operation.blocks.map(block => block.blockId) : []);
  const deleted = blocksTouched(ops, operation => operation.type === 'deleteBlock' ? [operation.blockId] : operation.type === 'deleteBlocks' ? operation.blocks.map(block => block.blockId) : []);
  if (inserted) parts.push(`inserted ${plural(inserted, 'block')}`);
  if (duplicated) parts.push(`duplicated ${plural(duplicated, 'block')}`);
  if (edited) parts.push(`edited ${plural(edited, 'block')}`);
  if (replaced) parts.push(`replaced text in ${plural(replaced, 'block')}`);
  if (moved) parts.push(`moved ${plural(moved, 'block')}`);
  if (deleted) parts.push(`deleted ${plural(deleted, 'block')}`);
  const title = [...ops].reverse().find((operation): operation is Extract<Operation, { type: 'setTitle' }> => operation.type === 'setTitle');
  if (title) parts.push(`renamed the document to “${title.title.length > 60 ? `${title.title.slice(0, 57)}...` : title.title}”`);
  if (ops.some(operation => operation.type === 'setFormat')) parts.push('changed the page format');
  const added = ops.filter(operation => operation.type === 'addCitation').length, updated = ops.filter(operation => operation.type === 'updateCitation').length, removed = ops.filter(operation => operation.type === 'removeCitation').length;
  if (added) parts.push(`added ${plural(added, 'citation')}`);
  if (updated) parts.push(`updated ${plural(updated, 'citation')}`);
  if (removed) parts.push(`removed ${plural(removed, 'citation')}`);
  return `${who} ${parts.length ? sentence(parts) : 'made no changes'}.`;
}
