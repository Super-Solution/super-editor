// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

/**
 * The approval card a chat host shows before a tool that changes a document runs.
 * It is read by the person using the chat, so it says what will happen to their
 * document in their words: no tool names, block ids, versions or JSON.
 * The card shows `description`, then any `summary` rows, then `title` above the buttons.
 */
export type ToolApprovalWording = {
  /** The one question the buttons answer. */
  title: string;
  /** What will happen, in a sentence or two. */
  description: string;
  summary?: { label: string; value: string }[];
  /** The verb on the approve button. */
  confirmLabel: string;
  /** For changes that remove content. */
  danger?: boolean;
};

const MAX_QUOTE = 80;
const quote = (text: string): string => {
  const flat = text.trim().replace(/\s+/g, ' ');
  return `“${flat.length > MAX_QUOTE ? `${flat.slice(0, MAX_QUOTE - 1)}…` : flat}”`;
};
const asRecord = (input: unknown): Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : `${n} ${many}`);

const WORDING: Record<string, (input: Record<string, unknown>) => ToolApprovalWording | undefined> = {
  set_title: (input) => {
    const title = str(input.title);
    return {
      title: 'Rename the document?',
      description: title
        ? `This document will be titled ${quote(title)}. The new title shows in the header, in exports, and in the revision history.`
        : 'This document will get a new title. It shows in the header, in exports, and in the revision history.',
      confirmLabel: 'Rename',
    };
  },
  update_block_text: (input) => {
    const text = str(input.text);
    return {
      title: 'Rewrite this part?',
      description: 'One part of this document will be rewritten with new text.',
      ...(text ? { summary: [{ label: 'New text', value: quote(text) }] } : {}),
      confirmLabel: 'Rewrite',
    };
  },
  update_block: () => ({
    title: 'Replace this part?',
    description: 'One part of this document, such as a table, list or chart, will be replaced with new content.',
    confirmLabel: 'Replace',
  }),
  replace_text: (input) => {
    const find = str(input.find);
    if (!find) return undefined;
    const replacement = typeof input.replace === 'string' ? input.replace : '';
    const where = str(input.blockId) ? 'in one part of this document' : 'in this document';
    const which = input.all === false ? `The first ${quote(find)}` : `Every ${quote(find)}`;
    return replacement.trim()
      ? { title: 'Replace this text?', description: `${which} ${where} will change to ${quote(replacement)}.`, confirmLabel: 'Replace' }
      : { title: 'Remove this text?', description: `${which} ${where} will be removed.`, confirmLabel: 'Remove', danger: true };
  },
  delete_blocks: (input) => {
    const n = Array.isArray(input.blocks) ? input.blocks.length : 0;
    return {
      title: n === 1 ? 'Delete this part?' : n > 1 ? `Delete these ${n} parts?` : 'Delete these parts?',
      description: `${n > 0 ? plural(n, 'One part', 'parts') : 'Parts'} of this document will be deleted, along with anything inside ${n === 1 ? 'it' : 'them'}. You can undo this until you leave the chat.`,
      confirmLabel: 'Delete',
      danger: true,
    };
  },
  import_markdown: (input) => {
    const retitle = input.setTitle === true ? ' The title will change too.' : '';
    return input.mode === 'replace'
      ? {
          title: 'Replace the whole document?',
          description: `Everything in this document will be replaced with the imported text.${retitle} You can undo this afterward.`,
          confirmLabel: 'Replace',
          danger: true,
        }
      : { title: 'Add the imported text?', description: `The imported text will be added to this document.${retitle}`, confirmLabel: 'Add' };
  },
  apply_transaction: (input) => {
    const operations = asRecord(input.transaction).operations;
    const n = Array.isArray(operations) ? operations.length : 0;
    return {
      title: n === 1 ? 'Make this change?' : 'Make these changes?',
      description: n > 0 ? `${plural(n, 'One change', 'changes')} will be made to this document at once.` : 'Several changes will be made to this document at once.',
      confirmLabel: 'Apply',
    };
  },
  undo: () => ({ title: 'Undo the last edit?', description: 'Your latest edit to this document will be undone.', confirmLabel: 'Undo' }),
  redo: () => ({ title: 'Redo the edit?', description: 'The edit you just undid will be made again.', confirmLabel: 'Redo' }),
};

/** The approval wording for an editor tool (its name without the `editor_` prefix), or `undefined` to let the host word it. */
export function approvalWordingFor(name: string): ((input: unknown) => ToolApprovalWording | undefined) | undefined {
  const word = WORDING[name];
  return word ? (input) => word(asRecord(input)) : undefined;
}
