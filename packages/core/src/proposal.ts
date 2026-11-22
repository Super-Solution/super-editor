// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { diffDocuments, summarizeRevision, type DocumentDiff } from './diff.js';
import { applyToDocument } from './store.js';
import { contentText } from './text.js';
import type { BlockType, EditorIssue, ResearchDocument, Transaction } from './types.js';
import { validateTransaction } from './validation.js';
import { withHints } from './issues.js';

/**
 * Review of an agent's proposed transaction before it is applied: what would change, in words a person can check, and whether it
 * would be accepted now. Nothing is applied; the document is not modified.
 *
 * - `ready`: the transaction is valid against the current document; `changes` and `after` describe the result.
 * - `stale`: the document moved on since the proposal's `baseRevision` (or a block it touches changed); it needs to be re-proposed.
 * - `invalid`: it is malformed or would be rejected for another reason; `issues` say why.
 */
export type ProposalStatus = 'ready' | 'stale' | 'invalid';
export type ProposalChange = {
  blockId: string;
  kind: 'added' | 'changed' | 'removed' | 'moved';
  type: BlockType;
  /** The block's text before (changed and removed blocks). */
  before?: string;
  /** The block's text after (added and changed blocks). */
  after?: string;
};
export type ProposalReview = {
  status: ProposalStatus;
  issues: EditorIssue[];
  /** The validated transaction, or null when it is not even well formed. */
  transaction: Transaction | null;
  /** One sentence, for example "Agent research-agent inserted 3 blocks and edited 1 block." */
  summary: string;
  baseRevision: number | null;
  currentRevision: number;
  changes: ProposalChange[];
  title?: { before: string; after: string };
  formatChanged: boolean;
  citations: { added: string[]; removed: string[]; changed: string[] };
  /** The document as it would be after accepting (only when `ready`). */
  after: ResearchDocument | null;
  diff: DocumentDiff | null;
};

const failed = (document: ResearchDocument, status: ProposalStatus, issues: EditorIssue[], transaction: Transaction | null): ProposalReview => ({
  status, issues: withHints(issues), transaction, summary: '', baseRevision: transaction?.baseRevision ?? null, currentRevision: document.revision,
  changes: [], formatChanged: false, citations: { added: [], removed: [], changed: [] }, after: null, diff: null,
});

export function reviewProposal(document: ResearchDocument, proposal: unknown, options: { now?: () => string } = {}): ProposalReview {
  const checked = validateTransaction(proposal);
  if (!checked.ok) return failed(document, 'invalid', checked.issues, null);
  const transaction = checked.value;
  const summary = summarizeRevision({ number: document.revision + 1, transactionId: transaction.id, actor: transaction.actor, at: document.updatedAt, kind: 'apply', operations: transaction.operations });
  const result = applyToDocument(document, transaction, options.now ? { now: options.now } : {});
  if (!result.ok) {
    const stale = result.issues.some((issue) => issue.code === 'conflict');
    return { ...failed(document, stale ? 'stale' : 'invalid', result.issues, transaction), summary };
  }
  const diff = diffDocuments(document, result.document);
  const before = new Map(document.blocks.map((block) => [block.id, block])), after = new Map(result.document.blocks.map((block) => [block.id, block]));
  const changes: ProposalChange[] = [
    ...diff.added.map((id): ProposalChange => ({ blockId: id, kind: 'added', type: after.get(id)!.content.type, after: contentText(after.get(id)!.content) })),
    ...diff.changed.map((id): ProposalChange => ({ blockId: id, kind: 'changed', type: after.get(id)!.content.type, before: contentText(before.get(id)!.content), after: contentText(after.get(id)!.content) })),
    ...diff.removed.map((id): ProposalChange => ({ blockId: id, kind: 'removed', type: before.get(id)!.content.type, before: contentText(before.get(id)!.content) })),
    ...diff.moved.filter((id) => !diff.changed.includes(id)).map((id): ProposalChange => ({ blockId: id, kind: 'moved', type: after.get(id)!.content.type, after: contentText(after.get(id)!.content) })),
  ];
  return {
    status: 'ready', issues: [], transaction, summary, baseRevision: transaction.baseRevision, currentRevision: document.revision, changes,
    ...(diff.titleChanged ? { title: { before: document.title, after: result.document.title } } : {}),
    formatChanged: diff.formatChanged, citations: diff.citations, after: result.document, diff,
  };
}
