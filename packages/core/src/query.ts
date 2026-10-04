import { contentText, runsOf } from './text.js';
import type { Block, BlockType, ResearchDocument } from './types.js';

/** Read-only document queries. Everything here is pure, synchronous and DOM-free. */
type Source = Pick<ResearchDocument, 'blocks'>;

function childIndex(document: Source): Map<string | null, Block[]> {
  const index = new Map<string | null, Block[]>();
  for (const block of document.blocks) {
    const siblings = index.get(block.parentId);
    if (siblings) siblings.push(block); else index.set(block.parentId, [block]);
  }
  return index;
}

/** All blocks in reading order: a pre-order walk of the tree, siblings in stored order. */
export function orderedBlocks(document: Source): Block[] {
  const index = childIndex(document), seen = new Set<string>(), result: Block[] = [];
  const walk = (parentId: string | null): void => {
    for (const block of index.get(parentId) ?? []) { if (seen.has(block.id)) continue; seen.add(block.id); result.push(block); walk(block.id); }
  };
  walk(null);
  // A valid document has no unreachable blocks; keep any that exist rather than dropping data.
  for (const block of document.blocks) if (!seen.has(block.id)) result.push(block);
  return result;
}

export function getBlock(document: Source, id: string): Block | undefined { return document.blocks.find(block => block.id === id); }
/** Direct children in stored order. `null` lists the top level. */
export function childrenOf(document: Source, parentId: string | null): Block[] { return document.blocks.filter(block => block.parentId === parentId); }
/** The containers that enclose a block, outermost first and the direct parent last. Empty for top-level or unknown blocks. */
export function ancestorsOf(document: Source, id: string): Block[] {
  const byId = new Map(document.blocks.map(block => [block.id, block])), chain: Block[] = [];
  let cursor = byId.get(id);
  while (cursor && cursor.parentId !== null && chain.length <= document.blocks.length) {
    const parent = byId.get(cursor.parentId);
    if (!parent) break;
    chain.unshift(parent); cursor = parent;
  }
  return chain;
}
/** Every block below `id`, in reading order. */
export function descendantsOf(document: Source, id: string): Block[] {
  const index = childIndex(document), result: Block[] = [], seen = new Set<string>([id]);
  const walk = (parentId: string): void => { for (const block of index.get(parentId) ?? []) { if (seen.has(block.id)) continue; seen.add(block.id); result.push(block); walk(block.id); } };
  walk(id);
  return result;
}
/** The searchable text of a block: every text field joined by newlines. Chart data, URLs and timestamps are not included. */
export function blockText(block: Pick<Block, 'content'>): string { return contentText(block.content); }

export type BlockSelector = {
  /** One block type or several. */
  type?: BlockType | readonly BlockType[];
  /** Case-insensitive substring of `blockText`, unless `caseSensitive` is set. */
  text?: string; caseSensitive?: boolean;
  /** Direct children of this block; `null` selects the top level. */
  parentId?: string | null;
  ids?: readonly string[];
  /** Blocks that cite this source, either in `citationIds` or through an inline marker. */
  citationId?: string;
  /** Any descendant of this block (not the block itself). */
  within?: string;
  limit?: number;
};

/** Selectors combine with AND. Results are in reading order. An empty selector returns every block. */
export function findBlocks(document: Source, selector: BlockSelector = {}): Block[] {
  const types = selector.type === undefined ? undefined : new Set<string>(typeof selector.type === 'string' ? [selector.type] : selector.type);
  const ids = selector.ids === undefined ? undefined : new Set(selector.ids);
  const within = selector.within === undefined ? undefined : new Set(descendantsOf(document, selector.within).map(block => block.id));
  const needle = selector.text === undefined ? undefined : selector.caseSensitive ? selector.text : selector.text.toLowerCase();
  const result: Block[] = [];
  for (const block of orderedBlocks(document)) {
    if (selector.limit !== undefined && result.length >= selector.limit) break;
    if (types && !types.has(block.content.type)) continue;
    if (ids && !ids.has(block.id)) continue;
    if (selector.parentId !== undefined && block.parentId !== selector.parentId) continue;
    if (within && !within.has(block.id)) continue;
    if (selector.citationId !== undefined && !block.citationIds.includes(selector.citationId) && !runsOf(block.content)?.some(run => run.citationId === selector.citationId)) continue;
    if (needle !== undefined) { const text = blockText(block); if (!(selector.caseSensitive ? text : text.toLowerCase()).includes(needle)) continue; }
    result.push(block);
  }
  return result;
}

export type OutlineItem = {
  id: string; type: 'section' | 'heading'; title: string;
  /** Heading level (1 to 3) for headings; nesting depth for sections (1 = top level). */
  level: number; children: OutlineItem[];
};
/**
 * The document's skeleton. Sections nest by containment and headings nest by level inside their container;
 * a section closes the headings before it, and toggles are transparent (their headings appear in place).
 */
export function getOutline(document: Source): OutlineItem[] {
  const index = childIndex(document), seen = new Set<string>();
  type Entry = { block: Block; item: OutlineItem };
  const entries = (parentId: string | null, depth: number): Entry[] => {
    const result: Entry[] = [];
    for (const block of index.get(parentId) ?? []) {
      if (seen.has(block.id)) continue; seen.add(block.id);
      const content = block.content;
      if (content.type === 'section') result.push({ block, item: { id: block.id, type: 'section', title: content.title, level: depth, children: nest(entries(block.id, depth + 1)) } });
      else if (content.type === 'heading') result.push({ block, item: { id: block.id, type: 'heading', title: content.text, level: content.level, children: [] } });
      else if (content.type === 'toggle') result.push(...entries(block.id, depth));
    }
    return result;
  };
  const nest = (list: Entry[]): OutlineItem[] => {
    const root: OutlineItem[] = [], stack: OutlineItem[] = [];
    for (const { item } of list) {
      if (item.type === 'section') { stack.length = 0; root.push(item); continue; }
      while (stack.length && stack[stack.length - 1]!.level >= item.level) stack.pop();
      (stack[stack.length - 1]?.children ?? root).push(item); stack.push(item);
    }
    return root;
  };
  return nest(entries(null, 1));
}
