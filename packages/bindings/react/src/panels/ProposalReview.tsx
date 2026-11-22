// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
'use client';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { reviewProposal } from '@supersolutions/super-editor-core';
import type { ApplyResult, Editor, ProposalChange, ProposalReview as ProposalReviewModel, ResearchDocument, Transaction } from '@supersolutions/super-editor-core';
import { template } from '@supersolutions/super-editor-ui';
import type { PartialLabels } from '@supersolutions/super-editor-ui';
import { useLabels } from '../render/context.js';
import { ReportView } from '../render/ReportView.js';
import { diffMarks } from './RevisionHistory.js';

export type ProposalReviewProps = {
  /** The document the proposal would change (its current state). */
  document: ResearchDocument;
  /** The agent's transaction, as received (any value: a malformed one is reported, not thrown). */
  proposal: unknown;
  /** Accept applies the proposal through this editor, as the proposal's own actor, then calls `onResult`. Without an editor only `onAccept` is called. */
  editor?: Editor;
  onAccept?: (transaction: Transaction) => void;
  onReject?: (transaction: Transaction | null) => void;
  /** The apply result when `editor` was used (to toast a conflict). */
  onResult?: (result: ApplyResult) => void;
  /** Offer "Show in document": the document as it would be, with changed blocks marked. */
  preview?: boolean;
  locale?: string;
  labels?: PartialLabels;
  className?: string;
};

/** Reviews the model without a component: the same data `ProposalReview` renders. */
export function useProposalReview(document: ResearchDocument, proposal: unknown): ProposalReviewModel {
  return useMemo(() => reviewProposal(document, proposal), [document, proposal]);
}

const KINDS: readonly ProposalChange['kind'][] = ['added', 'changed', 'removed', 'moved'];

/**
 * Human review of an agent's proposed change: who proposed it, what it would add, change, remove or move (before and after text),
 * whether it can still be applied, and Accept / Reject. Nothing is applied until Accept; a stale or invalid proposal cannot be accepted.
 */
export function ProposalReview({ document, proposal, editor, onAccept, onReject, onResult, preview, labels: override, className }: ProposalReviewProps): ReactNode {
  const labels = useLabels(override), text = labels.proposal;
  const review = useProposalReview(document, proposal);
  const [showing, setShowing] = useState(false);
  if (proposal === undefined || proposal === null) return <section className={`se-panel se-proposal${className ? ` ${className}` : ''}`}><p className="se-panel-empty">{text.empty}</p></section>;
  const tx = review.transaction;
  const accept = (): void => {
    if (review.status !== 'ready' || !tx) return;
    if (editor) onResult?.(editor.apply(tx));
    onAccept?.(tx);
  };
  const counts = review.citations;
  const statusLabel = review.status === 'ready' ? text.ready : review.status === 'stale' ? text.stale : text.invalid;
  return <section className={`se-panel se-proposal${className ? ` ${className}` : ''}`} aria-label={text.title} data-status={review.status}>
    <h2 className="se-panel-title">{text.title}</h2>
    {tx ? <p className="se-proposal-meta">
      <span className="se-badge" data-kind={tx.actor.kind}>{template(text.proposedBy, { actor: tx.actor.id })}</span>{' '}
      <span>{template(text.basedOn, { revision: tx.baseRevision })}</span>
    </p> : null}
    <p className="se-proposal-status" role="status" data-status={review.status}>{statusLabel}</p>
    {review.summary ? <p className="se-proposal-summary">{review.summary}</p> : null}
    {review.status === 'stale' ? <p className="se-proposal-note">{template(text.staleBody, { current: review.currentRevision, base: review.baseRevision ?? 0 })}</p> : null}
    {review.status !== 'ready' ? <ul className="se-proposal-issues">{review.issues.map((issue, index) => <li key={index}>{issue.message}{issue.hint ? <small> {issue.hint}</small> : null}</li>)}</ul> : null}
    {review.status === 'ready' ? <>
      {review.changes.length === 0 && !review.title && !review.formatChanged && !counts.added.length && !counts.changed.length && !counts.removed.length ? <p className="se-panel-empty">{text.noChanges}</p> : null}
      {review.title ? <div className="se-proposal-change" data-kind="changed"><strong>{text.titleChange}</strong><del>{review.title.before}</del><ins>{review.title.after}</ins></div> : null}
      {review.formatChanged ? <p className="se-proposal-note">{text.formatChange}</p> : null}
      {counts.added.length || counts.changed.length || counts.removed.length ? <p className="se-proposal-note">{template(text.citationsChange, { added: counts.added.length, changed: counts.changed.length, removed: counts.removed.length })}</p> : null}
      {KINDS.map((kind) => {
        const list = review.changes.filter((change) => change.kind === kind);
        return list.length ? <div className="se-proposal-group" key={kind}>
          <h3 className="se-panel-title">{text[kind]} ({list.length})</h3>
          <ul className="se-proposal-list">{list.map((change) => <li className="se-proposal-change" data-kind={change.kind} key={`${change.kind}-${change.blockId}`}>
            <span className="se-badge">{change.type}</span>
            {change.before !== undefined && change.kind !== 'moved' ? <del title={text.before}>{change.before || text.unchangedText}</del> : null}
            {change.after !== undefined && change.kind !== 'removed' ? <ins title={text.after}>{change.after || text.unchangedText}</ins> : null}
          </li>)}</ul>
        </div> : null;
      })}
      {preview && review.after ? <>
        <button type="button" className="se-link-button" aria-expanded={showing} onClick={() => setShowing((value) => !value)}>{showing ? text.hidePreview : text.showPreview}</button>
        {showing ? <div className="se-proposal-preview"><ReportView document={review.after} showHeader={false} {...(diffMarks(review.diff) ? { diff: diffMarks(review.diff)! } : {})} chartActions={false} /></div> : null}
      </> : null}
    </> : null}
    <div className="se-proposal-actions">
      <button type="button" className="se-button" data-primary title={text.acceptHint} disabled={review.status !== 'ready'} onClick={accept}>{text.accept}</button>
      <button type="button" className="se-button" onClick={() => onReject?.(tx)}>{text.reject}</button>
    </div>
  </section>;
}
