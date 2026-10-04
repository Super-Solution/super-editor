import type { Block, ResearchDocument } from '@super-solution/editor-core';

/** Immutable, per-snapshot index of the flat block list. Order is a true pre-order even if the stored list is not. */
export type BlockTree = {
  byId: ReadonlyMap<string, Block>;
  children: ReadonlyMap<string | null, readonly Block[]>;
  order: readonly Block[];
  indexOf: ReadonlyMap<string, number>;
};
const cache = new WeakMap<ResearchDocument, BlockTree>();

export function treeOf(doc: ResearchDocument): BlockTree {
  const hit = cache.get(doc);
  if (hit) return hit;
  const byId = new Map(doc.blocks.map((block) => [block.id, block] as const));
  const children = new Map<string | null, Block[]>();
  for (const block of doc.blocks) {
    const key = block.parentId !== null && byId.has(block.parentId) ? block.parentId : null;
    const siblings = children.get(key);
    if (siblings) siblings.push(block); else children.set(key, [block]);
  }
  const order: Block[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null): void => {
    for (const block of children.get(parentId) ?? []) { if (seen.has(block.id)) continue; seen.add(block.id); order.push(block); walk(block.id); }
  };
  walk(null);
  const indexOf = new Map(order.map((block, index) => [block.id, index] as const));
  const tree: BlockTree = { byId, children, order, indexOf };
  cache.set(doc, tree);
  return tree;
}

export function blockOf(doc: ResearchDocument, id: string): Block | undefined { return treeOf(doc).byId.get(id); }
export function siblingsOf(doc: ResearchDocument, id: string): readonly Block[] {
  const block = treeOf(doc).byId.get(id);
  return block ? treeOf(doc).children.get(block.parentId) ?? [] : [];
}
export function descendantsOf(doc: ResearchDocument, id: string): Block[] {
  const tree = treeOf(doc), found: Block[] = [];
  const walk = (parentId: string): void => { for (const child of tree.children.get(parentId) ?? []) { found.push(child); walk(child.id); } };
  walk(id);
  return found;
}
export function hasChildren(doc: ResearchDocument, id: string): boolean { return (treeOf(doc).children.get(id)?.length ?? 0) > 0; }
/** True when `id` is `ancestorId` or lies somewhere below it. */
export function isWithin(doc: ResearchDocument, id: string, ancestorId: string): boolean {
  const { byId } = treeOf(doc);
  for (let cursor = byId.get(id), guard = 0; cursor && guard < 1_000; cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId), guard++) if (cursor.id === ancestorId) return true;
  return false;
}
export function depthOf(doc: ResearchDocument, id: string): number {
  const { byId } = treeOf(doc);
  let depth = 0;
  for (let cursor = byId.get(id); cursor && cursor.parentId !== null && depth < 1_000; cursor = byId.get(cursor.parentId)) depth++;
  return depth;
}
/** Selected blocks without any selected ancestor, in document order. These are the blocks operations act on. */
export function rootsOf(doc: ResearchDocument, ids: readonly string[]): string[] {
  const tree = treeOf(doc), wanted = new Set(ids.filter((id) => tree.byId.has(id)));
  return tree.order.filter((block) => {
    if (!wanted.has(block.id)) return false;
    for (let cursor = block.parentId; cursor !== null; cursor = tree.byId.get(cursor)?.parentId ?? null) if (wanted.has(cursor)) return false;
    return true;
  }).map((block) => block.id);
}
/** Pre-order list of blocks a user can currently see: children of a closed toggle are hidden. */
export function visibleOrder(doc: ResearchDocument): Block[] {
  const tree = treeOf(doc), hidden = new Set<string>(), closed = new Set<string>(), out: Block[] = [];
  for (const block of tree.order) {
    if (block.parentId !== null && (hidden.has(block.parentId) || closed.has(block.parentId))) { hidden.add(block.id); continue; }
    out.push(block);
    if (block.content.type === 'toggle' && !block.content.open) closed.add(block.id);
  }
  return out;
}
export function previousVisible(doc: ResearchDocument, id: string): Block | undefined {
  const order = visibleOrder(doc), index = order.findIndex((block) => block.id === id);
  return index > 0 ? order[index - 1] : undefined;
}
export function nextVisible(doc: ResearchDocument, id: string): Block | undefined {
  const order = visibleOrder(doc), index = order.findIndex((block) => block.id === id);
  return index !== -1 ? order[index + 1] : undefined;
}
