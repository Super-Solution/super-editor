import type { Block, BlockContent, Operation, ResearchDocument } from '@super-solution/editor-core';
import type { Caret, FieldKey } from './types.js';
import { cellField, fieldKeys, isEditableType, isEmptyContent, itemField, parseField } from './fields.js';
import { concatRuns, deleteRange, runsFromText, runsLength, runsPlainText, splitRuns } from './inline.js';
import { blockInput, plural } from './plan.js';
import type { EditTarget, IdFactory, PlanResult } from './plan.js';
import { listChecked, listIndent, listSetIndent, listSplice } from './structure.js';
import { hasChildren, previousVisible, treeOf, visibleOrder } from './tree.js';

/** Pure planners for caret-driven edits (Enter, Backspace, Delete). They work on the draft content the user is typing, guarded by the version they started from. */
export type EditSubject = {
  blockId: string; field: FieldKey;
  /** Draft content (what the user sees), which may differ from the committed block. */
  content: BlockContent;
  /** Block version the draft was based on: the expectedVersion of any update. */
  version: number;
  start: number; end: number;
};
const update = (s: EditSubject, content: BlockContent): Operation => ({ type: 'updateBlock', blockId: s.blockId, expectedVersion: s.version, content });
const emptyParagraph = (): BlockContent => ({ type: 'paragraph', runs: [] });
const siblingBefore = (doc: ResearchDocument, block: Block): string | null => {
  const siblings = treeOf(doc).children.get(block.parentId) ?? [], at = siblings.findIndex((entry) => entry.id === block.id);
  return at > 0 ? siblings[at - 1]!.id : null;
};

/** Where the caret goes when an editable block is entered from above (`start`) or below (`end`). Null for blocks without text. */
export function editTargetFor(block: Pick<Block, 'id' | 'content'>, edge: 'start' | 'end'): EditTarget | null {
  const { content } = block;
  if (!isEditableType(content.type)) return null;
  if (content.type === 'list') { if (!content.items.length) return null; return { blockId: block.id, field: itemField(edge === 'start' ? 0 : content.items.length - 1), caret: edge }; }
  if (content.type === 'table') {
    if (!content.columns.length) return null;
    return { blockId: block.id, field: edge === 'start' ? cellField(-1, 0) : cellField(content.rows.length - 1, content.columns.length - 1), caret: edge };
  }
  return { blockId: block.id, field: 'main', caret: edge };
}

export function planEnter(doc: ResearchDocument, s: EditSubject, createId: IdFactory): PlanResult {
  const block = treeOf(doc).byId.get(s.blockId);
  if (!block) return null;
  const { content } = s, parentId = block.parentId;
  const asParagraphAbove = (changed: BlockContent | null): PlanResult => {
    const above = blockInput(createId('block'), parentId, emptyParagraph());
    return { operations: [...(changed ? [update(s, changed)] : []), { type: 'insertBlocks', blocks: [above], afterId: siblingBefore(doc, block) }], edit: { blockId: s.blockId, field: s.field, caret: 'start' }, summary: 'Inserted a block above' };
  };
  switch (content.type) {
    case 'paragraph': case 'quote': case 'callout': {
      const cleared = deleteRange(content.runs, s.start, s.end), empty = runsLength(cleared) === 0 && !cleared.some((run) => run.citationId !== undefined);
      if (content.type !== 'paragraph' && empty) return { operations: [update(s, emptyParagraph())], edit: { blockId: s.blockId, field: 'main', caret: 'start' }, summary: 'Left the block' };
      if (s.start === 0 && s.end === 0 && !empty) return asParagraphAbove(null);
      const [before, after] = splitRuns(cleared, s.start);
      const next = blockInput(createId('block'), parentId, { type: 'paragraph', runs: after });
      return { operations: [update(s, { ...content, runs: before }), { type: 'insertBlocks', blocks: [next], afterId: s.blockId }], edit: { blockId: next.id, field: 'main', caret: 'start' }, summary: 'Inserted a paragraph' };
    }
    case 'heading': {
      const text = content.text.slice(0, s.start) + content.text.slice(s.end), before = text.slice(0, s.start), after = text.slice(s.start);
      if (s.start === 0 && text !== '') return asParagraphAbove(null);
      const next = blockInput(createId('block'), parentId, { type: 'paragraph', runs: runsFromText(after) });
      return { operations: [update(s, { ...content, text: before }), { type: 'insertBlocks', blocks: [next], afterId: s.blockId }], edit: { blockId: next.id, field: 'main', caret: 'start' }, summary: 'Inserted a paragraph' };
    }
    case 'section': case 'toggle': {
      const text = content.title.slice(0, s.start) + content.title.slice(s.end), before = text.slice(0, s.start), after = text.slice(s.start);
      const child = blockInput(createId('block'), s.blockId, { type: 'paragraph', runs: runsFromText(after) });
      const title: BlockContent = content.type === 'toggle' ? { ...content, title: before, open: true } : { ...content, title: before };
      return { operations: [update(s, title), { type: 'insertBlocks', blocks: [child], afterId: null }], edit: { blockId: child.id, field: 'main', caret: 'start' }, summary: `Added a block inside the ${content.type}` };
    }
    case 'list': {
      const field = parseField(s.field);
      if (field.kind !== 'item') return null;
      const index = field.index, text = content.items[index] ?? '';
      const cleared = text.slice(0, s.start) + text.slice(s.end), before = cleared.slice(0, s.start), after = cleared.slice(s.start);
      const indent = listIndent(content)[index] ?? 0, checked = listChecked(content)[index] ?? false, count = content.items.length;
      if (cleared === '') {
        if (indent > 0) { const next = listSetIndent(content, index, -1); return next ? { operations: [update(s, next)], edit: { blockId: s.blockId, field: s.field, caret: 'start' }, summary: 'Outdented' } : null; }
        // An empty item leaves the list: the item becomes a paragraph, splitting the list when it sits in the middle.
        const para = blockInput(createId('block'), parentId, emptyParagraph());
        if (count === 1) return { operations: [update(s, emptyParagraph())], edit: { blockId: s.blockId, field: 'main', caret: 'start' }, summary: 'Left the list' };
        if (index === count - 1) return { operations: [update(s, listSplice(content, index, 1, [])), { type: 'insertBlocks', blocks: [para], afterId: s.blockId }], edit: { blockId: para.id, field: 'main', caret: 'start' }, summary: 'Left the list' };
        if (index === 0) return { operations: [update(s, listSplice(content, 0, 1, [])), { type: 'insertBlocks', blocks: [para], afterId: siblingBefore(doc, block) }], edit: { blockId: para.id, field: 'main', caret: 'start' }, summary: 'Left the list' };
        const tail = blockInput(createId('block'), parentId, listSplice(content, 0, index + 1, []));
        return { operations: [update(s, listSplice(content, index, count - index, [])), { type: 'insertBlocks', blocks: [para, tail], afterId: s.blockId }], edit: { blockId: para.id, field: 'main', caret: 'start' }, summary: 'Left the list' };
      }
      return { operations: [update(s, listSplice(content, index, 1, [{ text: before, checked, indent }, { text: after, checked: false, indent }]))], edit: { blockId: s.blockId, field: itemField(index + 1), caret: 'start' }, summary: 'Added a list item' };
    }
    default: return null;
  }
}

/** Backspace with the caret at the very start of a field (or in an empty block). */
export function planBackspaceAtStart(doc: ResearchDocument, s: EditSubject, createId: IdFactory): PlanResult {
  const tree = treeOf(doc), block = tree.byId.get(s.blockId);
  if (!block) return null;
  const { content } = s, previous = previousVisible(doc, s.blockId);
  const toParagraph = (): PlanResult => {
    const text = content.type === 'heading' || content.type === 'code' ? content.text : content.type === 'paragraph' || content.type === 'quote' || content.type === 'callout' ? runsPlainText(content.runs) : '';
    const runs = content.type === 'quote' || content.type === 'callout' ? content.runs : runsFromText(text);
    return { operations: [update(s, { type: 'paragraph', runs })], edit: { blockId: s.blockId, field: 'main', caret: 'start' }, summary: 'Turned into text' };
  };
  const removeBlock = (): PlanResult => {
    if (tree.order.length <= 1 || !previous) return null;
    const target = editTargetFor(previous, 'end');
    return { operations: [{ type: 'deleteBlocks', blocks: [{ blockId: s.blockId, expectedVersion: s.version }] }], ...(target ? { edit: target } : { select: [previous.id] }), focus: previous.id, summary: 'Deleted an empty block' };
  };
  switch (content.type) {
    case 'paragraph': {
      if (isEmptyContent(content)) return removeBlock();
      if (!previous || previous.parentId !== block.parentId) return null;
      const merge = mergeInto(previous, content.runs);
      if (!merge) return null;
      return { operations: [{ type: 'updateBlock', blockId: previous.id, expectedVersion: previous.version, content: merge.content }, { type: 'deleteBlocks', blocks: [{ blockId: s.blockId, expectedVersion: s.version }] }], edit: { blockId: previous.id, field: 'main', caret: merge.caret }, summary: 'Merged with the previous block' };
    }
    case 'heading': case 'quote': case 'callout': return toParagraph();
    case 'code': return content.text === '' ? toParagraph() : null;
    case 'section': case 'toggle': {
      if (content.title !== '' || hasChildren(doc, s.blockId)) return null;
      return removeBlock();
    }
    case 'list': {
      const field = parseField(s.field);
      if (field.kind !== 'item') return null;
      const index = field.index, count = content.items.length, text = content.items[index] ?? '';
      if ((listIndent(content)[index] ?? 0) > 0) { const next = listSetIndent(content, index, -1); return next ? { operations: [update(s, next)], edit: { blockId: s.blockId, field: s.field, caret: 'start' }, summary: 'Outdented' } : null; }
      if (index > 0) {
        const previousText = content.items[index - 1] ?? '';
        const merged = listSplice(content, index - 1, 2, [{ text: previousText + text, checked: listChecked(content)[index - 1] ?? false, indent: listIndent(content)[index - 1] ?? 0 }]);
        return { operations: [update(s, merged)], edit: { blockId: s.blockId, field: itemField(index - 1), caret: previousText.length }, summary: 'Merged list items' };
      }
      // First item: it becomes a paragraph above the rest of the list.
      if (count === 1) return { operations: [update(s, { type: 'paragraph', runs: runsFromText(text) })], edit: { blockId: s.blockId, field: 'main', caret: 'start' }, summary: 'Turned into text' };
      const para = blockInput(createId('block'), block.parentId, { type: 'paragraph', runs: runsFromText(text) });
      return { operations: [update(s, listSplice(content, 0, 1, [])), { type: 'insertBlocks', blocks: [para], afterId: siblingBefore(doc, block) }], edit: { blockId: para.id, field: 'main', caret: 'start' }, summary: 'Turned into text' };
    }
    default: return null;
  }
}
/** Appends a following paragraph's runs onto a text-bearing block. */
function mergeInto(target: Block, runs: BlockContent extends never ? never : import('@super-solution/editor-core').InlineRun[]): { content: BlockContent; caret: number } | null {
  const { content } = target;
  switch (content.type) {
    case 'paragraph': case 'quote': case 'callout': return { content: { ...content, runs: concatRuns(content.runs, runs) }, caret: runsLength(content.runs) };
    case 'heading': return { content: { ...content, text: content.text + runsPlainText(runs) }, caret: content.text.length };
    default: return null;
  }
}
/** Delete with the caret at the very end of a paragraph: pulls the next sibling paragraph up. */
export function planDeleteAtEnd(doc: ResearchDocument, s: EditSubject): PlanResult {
  const tree = treeOf(doc), block = tree.byId.get(s.blockId);
  if (!block || s.content.type !== 'paragraph') return null;
  const order = visibleOrder(doc), at = order.findIndex((entry) => entry.id === s.blockId), next = order[at + 1];
  if (!next || next.parentId !== block.parentId || next.content.type !== 'paragraph') return null;
  return { operations: [update(s, { ...s.content, runs: concatRuns(s.content.runs, next.content.runs) }), { type: 'deleteBlocks', blocks: [{ blockId: next.id, expectedVersion: next.version }] }], edit: { blockId: s.blockId, field: 'main', caret: runsLength(s.content.runs) }, summary: 'Merged with the next block' };
}
export { plural, fieldKeys };
