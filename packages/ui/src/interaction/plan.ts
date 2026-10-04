import { isContainerType } from '@super-solution/editor-core';
import type { BlockContent, BlockInput, Operation, ResearchDocument } from '@super-solution/editor-core';
import type { Caret, FieldKey, Placement } from './types.js';
import { canTurnInto, convertContent, targetOf } from './convert.js';
import type { TurnIntoTarget } from './convert.js';
import { isNoopPlacement } from './drop.js';
import { descendantsOf, hasChildren, rootsOf, treeOf, visibleOrder } from './tree.js';
import type { CalloutTone } from '@super-solution/editor-core';

/**
 * Pure planners: given a document snapshot and an intent, produce the operations to submit. The interaction layer
 * runs a plan through `editor.apply` with the human actor; nothing here touches the editor, the DOM or timers.
 */
export type EditTarget = { blockId: string; field?: FieldKey; caret?: Caret };
export type Plan = {
  operations: Operation[];
  /** Blocks to select afterwards. */
  select?: string[];
  /** Block to place the caret in afterwards. */
  edit?: EditTarget;
  summary: string;
  /** For deletions: where focus should go. */
  focus?: string | null;
};
export type PlanResult = Plan | { error: string } | null;
export type IdFactory = (prefix: string) => string;
export const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const refs = (doc: ResearchDocument, ids: readonly string[]): { blockId: string; expectedVersion: number }[] => {
  const { byId } = treeOf(doc);
  return ids.map((blockId) => ({ blockId, expectedVersion: byId.get(blockId)!.version }));
};
export function blockInput(id: string, parentId: string | null, content: BlockContent): BlockInput { return { id, parentId, content, citationIds: [] }; }

export function planDelete(doc: ResearchDocument, ids: readonly string[]): PlanResult {
  const roots = rootsOf(doc, ids);
  if (!roots.length) return null;
  const doomed = new Set(roots);
  for (const id of roots) for (const child of descendantsOf(doc, id)) doomed.add(child.id);
  const order = visibleOrder(doc), first = order.findIndex((block) => doomed.has(block.id));
  let focus: string | null = null;
  for (let at = first - 1; at >= 0 && focus === null; at--) if (!doomed.has(order[at]!.id)) focus = order[at]!.id;
  for (let at = first + 1; at < order.length && focus === null; at++) if (!doomed.has(order[at]!.id)) focus = order[at]!.id;
  return { operations: [{ type: 'deleteBlocks', blocks: refs(doc, roots) }], focus, summary: `Deleted ${plural(roots.length, 'block')}` };
}

export function planDuplicate(doc: ResearchDocument, ids: readonly string[], createId: IdFactory): PlanResult {
  const roots = rootsOf(doc, ids);
  if (!roots.length) return null;
  const tree = treeOf(doc), operations: Operation[] = [], copies: string[] = [];
  const sameParent = roots.every((id) => tree.byId.get(id)!.parentId === tree.byId.get(roots[0]!)!.parentId);
  const chain = sameParent && roots.length > 1;
  for (const root of roots) {
    const newIds: Record<string, string> = {};
    for (const block of [tree.byId.get(root)!, ...descendantsOf(doc, root)]) newIds[block.id] = createId('block');
    // A selection of siblings duplicates as a group after the last one, in order; otherwise each copy follows its original.
    const afterId = chain ? (copies.length ? copies[copies.length - 1]! : roots[roots.length - 1]!) : undefined;
    operations.push({ type: 'duplicateBlock', blockId: root, expectedVersion: tree.byId.get(root)!.version, newIds, ...(afterId === undefined ? {} : { afterId }) });
    copies.push(newIds[root]!);
  }
  return { operations, select: copies, summary: `Duplicated ${plural(roots.length, 'block')}` };
}

export function planMove(doc: ResearchDocument, ids: readonly string[], placement: Placement): PlanResult {
  const roots = rootsOf(doc, ids);
  if (!roots.length) return null;
  if (isNoopPlacement(doc, roots, placement)) return null;
  return { operations: [{ type: 'moveBlocks', blocks: refs(doc, roots), parentId: placement.parentId, afterId: placement.afterId }], select: roots, summary: `Moved ${plural(roots.length, 'block')}` };
}

/** Keyboard move (Alt+Shift+Up/Down): swaps with the neighbouring sibling, or leaves the container at its first/last position. */
export function planStepMove(doc: ResearchDocument, ids: readonly string[], direction: 'up' | 'down'): PlanResult {
  const roots = rootsOf(doc, ids);
  if (!roots.length) return null;
  const tree = treeOf(doc), parentId = tree.byId.get(roots[0]!)!.parentId;
  if (!roots.every((id) => tree.byId.get(id)!.parentId === parentId)) return { error: 'Select blocks that share the same parent to move them with the keyboard.' };
  const siblings = tree.children.get(parentId) ?? [], moving = new Set(roots);
  const free = siblings.filter((block) => !moving.has(block.id));
  const indices = roots.map((id) => siblings.findIndex((block) => block.id === id));
  let placement: Placement | null = null;
  if (direction === 'up') {
    const previous = [...siblings.slice(0, indices[0]!)].reverse().find((block) => !moving.has(block.id));
    if (previous) { const at = free.findIndex((block) => block.id === previous.id); placement = { parentId, afterId: at > 0 ? free[at - 1]!.id : null }; }
    else if (parentId !== null) {
      const parent = tree.byId.get(parentId)!, uncles = (tree.children.get(parent.parentId) ?? []), at = uncles.findIndex((block) => block.id === parentId);
      placement = { parentId: parent.parentId, afterId: at > 0 ? uncles[at - 1]!.id : null };
    }
  } else {
    const next = siblings.slice(indices[indices.length - 1]! + 1).find((block) => !moving.has(block.id));
    if (next) placement = { parentId, afterId: next.id };
    else if (parentId !== null) placement = { parentId: tree.byId.get(parentId)!.parentId, afterId: parentId };
  }
  if (!placement) return null;
  return planMove(doc, roots, placement);
}

export function planTurnInto(doc: ResearchDocument, ids: readonly string[], target: TurnIntoTarget, createId: IdFactory, tone?: CalloutTone): PlanResult {
  const roots = rootsOf(doc, ids);
  if (!roots.length) return null;
  const tree = treeOf(doc), operations: Operation[] = [], select: string[] = [];
  let changed = 0;
  for (const id of roots) {
    const block = tree.byId.get(id)!;
    if (!canTurnInto(block.content, target, hasChildren(doc, id))) continue;
    const converted = convertContent(block.content, target, tone);
    if (!converted) continue;
    operations.push({ type: 'updateBlock', blockId: id, expectedVersion: block.version, content: converted.content });
    select.push(id); changed++;
    if (converted.extra.length) {
      const extras = converted.extra.map((content) => blockInput(createId('block'), block.parentId, content));
      operations.push({ type: 'insertBlocks', blocks: extras, afterId: id });
      select.push(...extras.map((extra) => extra.id));
    }
  }
  if (!operations.length) return roots.some((id) => targetOf(tree.byId.get(id)!.content) === target) ? null : { error: 'These blocks cannot be turned into that type.' };
  return { operations, select, summary: `Turned ${plural(changed, 'block')} into ${target}` };
}

/** Inserts blocks as siblings after `afterId` (or first among `parentId`'s children when null). */
export function planInsert(doc: ResearchDocument, parentId: string | null, afterId: string | null, contents: readonly BlockContent[], createId: IdFactory): Plan | { error: string } {
  if (parentId !== null) { const parent = treeOf(doc).byId.get(parentId); if (!parent || !isContainerType(parent.content.type)) return { error: 'Blocks can only be placed inside a section or toggle.' }; }
  const blocks = contents.map((content) => blockInput(createId('block'), parentId, content));
  return { operations: [{ type: 'insertBlocks', blocks, afterId }], select: blocks.map((block) => block.id), summary: `Inserted ${plural(blocks.length, 'block')}` };
}
