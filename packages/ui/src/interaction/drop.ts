import { isContainerType } from '@super-solution/editor-core';
import type { ResearchDocument } from '@super-solution/editor-core';
import type { Box, Placement } from './types.js';
import { descendantsOf, rootsOf, treeOf } from './tree.js';

/** Pure geometry for hover, drag and drop. A "layout" is the content-space boxes of rendered blocks; tests feed it fake boxes. */
export type LayoutBox = Box & { id: string; parentId: string | null };
export type LayoutIndex = {
  boxes: readonly LayoutBox[]; byId: ReadonlyMap<string, LayoutBox>; children: ReadonlyMap<string | null, readonly LayoutBox[]>; depth: ReadonlyMap<string, number>;
};
export type DropPosition = 'before' | 'after' | 'inside-start' | 'inside-end';
export type DropTarget = { overId: string; position: DropPosition };
export type DropIndicator = { top: number; left: number; width: number; inside: boolean };
export type DropOptions = {
  /** Pointer slack to the left of blocks, so the gutter counts as part of its block. */
  expandLeft?: number;
  /** Pointer further left than the last child of a container by this much drops after the container. */
  outdent?: number;
  /** Indentation used to draw "inside" indicators. */
  indent?: number;
};

export function indexLayout(boxes: readonly LayoutBox[]): LayoutIndex {
  const byId = new Map(boxes.map((box) => [box.id, box] as const));
  const children = new Map<string | null, LayoutBox[]>();
  for (const box of boxes) {
    const key = box.parentId !== null && byId.has(box.parentId) ? box.parentId : null;
    const siblings = children.get(key);
    if (siblings) siblings.push(box); else children.set(key, [box]);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.top - b.top || a.left - b.left);
  const depth = new Map<string, number>();
  const measure = (box: LayoutBox): number => {
    const known = depth.get(box.id);
    if (known !== undefined) return known;
    const parent = box.parentId !== null ? byId.get(box.parentId) : undefined;
    const value = parent ? measure(parent) + 1 : 0;
    depth.set(box.id, value);
    return value;
  };
  boxes.forEach(measure);
  return { boxes, byId, children, depth };
}
const contains = (box: Box, x: number, y: number, expandLeft = 0): boolean => x >= box.left - expandLeft && x <= box.right && y >= box.top && y <= box.bottom;
/** Deepest (then smallest) box under a point. */
export function hitTest(index: LayoutIndex, x: number, y: number, expandLeft = 0, skip?: (id: string) => boolean): LayoutBox | null {
  let best: LayoutBox | null = null, bestDepth = -1, bestArea = Infinity;
  for (const box of index.boxes) {
    if (skip?.(box.id) || !contains(box, x, y, expandLeft)) continue;
    const depth = index.depth.get(box.id) ?? 0, area = (box.right - box.left) * (box.bottom - box.top);
    if (depth > bestDepth || (depth === bestDepth && area < bestArea)) { best = box; bestDepth = depth; bestArea = area; }
  }
  return best;
}

export function dropTargetAt(index: LayoutIndex, doc: ResearchDocument, movingIds: readonly string[], x: number, y: number, options: DropOptions = {}): DropTarget | null {
  const tree = treeOf(doc), expandLeft = options.expandLeft ?? 0, outdent = options.outdent ?? 28;
  const moving = new Set<string>();
  for (const id of rootsOf(doc, movingIds)) { moving.add(id); for (const child of descendantsOf(doc, id)) moving.add(child.id); }
  if (!moving.size) return null;
  const kids = (id: string | null): LayoutBox[] => (index.children.get(id) ?? []).filter((box) => !moving.has(box.id));
  const isContainer = (id: string): boolean => { const block = tree.byId.get(id); return !!block && isContainerType(block.content.type); };
  let target: DropTarget | null = null;
  const hit = hitTest(index, x, y, expandLeft, (id) => moving.has(id));
  if (!hit) {
    const top = kids(null);
    const first = top[0], last = top[top.length - 1];
    if (!first || !last) return null;
    if (y < first.top) target = { overId: first.id, position: 'before' };
    else if (y >= last.bottom) target = { overId: last.id, position: 'after' };
    else { const next = top.find((box) => box.top > y); target = next ? { overId: next.id, position: 'before' } : { overId: last.id, position: 'after' }; }
  } else if (isContainer(hit.id)) {
    const children = kids(hit.id), first = children[0], last = children[children.length - 1];
    if (!first || !last) target = y < hit.top + (hit.bottom - hit.top) * .35 ? { overId: hit.id, position: 'before' } : { overId: hit.id, position: 'inside-end' };
    else if (y < first.top) target = y < hit.top + (first.top - hit.top) * .5 ? { overId: hit.id, position: 'before' } : { overId: hit.id, position: 'inside-start' };
    else if (y >= last.bottom) target = { overId: hit.id, position: 'after' };
    else { const next = children.find((box) => box.top > y); target = next ? { overId: next.id, position: 'before' } : { overId: last.id, position: 'after' }; }
  } else target = y < (hit.top + hit.bottom) / 2 ? { overId: hit.id, position: 'before' } : { overId: hit.id, position: 'after' };
  // Dragging out to the left of the last child of a container drops after the container, repeatedly.
  for (let guard = 0; target && target.position === 'after' && guard < 64; guard++) {
    const box = index.byId.get(target.overId), block = tree.byId.get(target.overId);
    const parentId = block?.parentId ?? null;
    if (!box || parentId === null) break;
    const siblings = kids(parentId);
    if (siblings[siblings.length - 1]?.id !== box.id || x >= box.left - outdent) break;
    target = { overId: parentId, position: 'after' };
  }
  return target && !moving.has(target.overId) ? target : null;
}

/** Converts a drop target into `moveBlocks` arguments. The anchor is never one of the moved blocks. */
export function placementOf(doc: ResearchDocument, target: DropTarget, movingIds: readonly string[]): Placement | null {
  const tree = treeOf(doc), over = tree.byId.get(target.overId);
  if (!over) return null;
  const roots = new Set(rootsOf(doc, movingIds));
  const blocked = new Set<string>(roots);
  for (const id of roots) for (const child of descendantsOf(doc, id)) blocked.add(child.id);
  if (blocked.has(over.id)) return null;
  const siblingsWithout = (parentId: string | null) => (tree.children.get(parentId) ?? []).filter((block) => !roots.has(block.id));
  switch (target.position) {
    case 'after': return { parentId: over.parentId, afterId: over.id };
    case 'before': {
      const siblings = siblingsWithout(over.parentId), at = siblings.findIndex((block) => block.id === over.id);
      return { parentId: over.parentId, afterId: at > 0 ? siblings[at - 1]!.id : null };
    }
    case 'inside-start': return isContainerType(over.content.type) ? { parentId: over.id, afterId: null } : null;
    case 'inside-end': {
      if (!isContainerType(over.content.type)) return null;
      const siblings = siblingsWithout(over.id);
      return { parentId: over.id, afterId: siblings.length ? siblings[siblings.length - 1]!.id : null };
    }
  }
}
/** True when moving would leave the blocks exactly where they already are. */
export function isNoopPlacement(doc: ResearchDocument, movingIds: readonly string[], placement: Placement): boolean {
  const tree = treeOf(doc), roots = rootsOf(doc, movingIds);
  if (!roots.length || !roots.every((id) => tree.byId.get(id)?.parentId === placement.parentId)) return false;
  const siblings = tree.children.get(placement.parentId) ?? [];
  const positions = roots.map((id) => siblings.findIndex((block) => block.id === id));
  if (positions.some((position, at) => position === -1 || (at > 0 && position !== positions[at - 1]! + 1))) return false;
  const previous = siblings[positions[0]! - 1];
  return (previous?.id ?? null) === placement.afterId;
}
export function indicatorFor(index: LayoutIndex, target: DropTarget, options: DropOptions = {}, movingIds: readonly string[] = []): DropIndicator | null {
  const box = index.byId.get(target.overId);
  if (!box) return null;
  const moving = new Set(movingIds), indent = options.indent ?? 20;
  const width = box.right - box.left;
  const children = (index.children.get(box.id) ?? []).filter((child) => !moving.has(child.id));
  switch (target.position) {
    case 'before': return { top: box.top, left: box.left, width, inside: false };
    case 'after': return { top: box.bottom, left: box.left, width, inside: false };
    case 'inside-start': { const first = children[0]; return { top: first ? first.top : box.bottom, left: box.left + indent, width: Math.max(0, width - indent), inside: true }; }
    case 'inside-end': { const last = children[children.length - 1]; return { top: last ? last.bottom : box.bottom, left: box.left + indent, width: Math.max(0, width - indent), inside: true }; }
  }
}
