import { useMemo, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { diffDocuments, summarizeRevision } from '@super-solution/editor-core';
import type { DocumentDiff, ResearchDocument, Revision } from '@super-solution/editor-core';
import { template } from '@super-solution/editor-ui';
import type { DiffMarks, PartialLabels } from '@super-solution/editor-ui';
import { useLabels } from '../render/context.js';
import { absoluteTime, relativeTime, useNow } from './hooks.js';

/** One row of history. The Trading API returns this shape; `revisionEntries` builds it from an editor's own revisions. */
export type RevisionEntry = { revision: number; at: string; actorKind: 'human' | 'agent' | 'system'; summary: string; actorId?: string };

/** Newest first, with a human sentence per revision from core's `summarizeRevision`. */
export function revisionEntries(revisions: readonly Revision[]): RevisionEntry[] {
  return revisions.map((revision) => ({ revision: revision.number, at: revision.at, actorKind: revision.actor.kind, actorId: revision.actor.id, summary: summarizeRevision(revision) })).reverse();
}
const isRevision = (value: Revision | RevisionEntry): value is Revision => 'number' in value;
function toEntry(value: Revision | RevisionEntry): RevisionEntry { return isRevision(value) ? { revision: value.number, at: value.at, actorKind: value.actor.kind, actorId: value.actor.id, summary: summarizeRevision(value) } : value; }

/** Ids to highlight in `ReportView` for a diff, so a compare view shows what an agent changed. */
export function diffMarks(diff: DocumentDiff | null | undefined): DiffMarks | undefined {
  return diff ? { added: diff.added, changed: diff.changed, moved: diff.moved } : undefined;
}
/** `diffDocuments(previous, current)` memoized; `null` until `previous` is loaded. */
export function useRevisionDiff(previous: ResearchDocument | null | undefined, current: ResearchDocument): DocumentDiff | null {
  return useMemo(() => previous ? diffDocuments(previous, current) : null, [previous, current]);
}

export type RevisionHistoryProps = {
  /** Core revisions, or entries from an API. Order does not matter; the list shows newest first. */
  revisions: readonly (Revision | RevisionEntry)[];
  /** The revision that is on screen now; it is marked "Current" and cannot be restored. */
  currentRevision?: number;
  selected?: number | null;
  onSelect?: (entry: RevisionEntry) => void;
  /** Shows the Restore button for the selected revision. */
  onRestore?: (entry: RevisionEntry) => void;
  /** Shows the Compare button; load the old revision and pass the result as `diff`. */
  onCompare?: (entry: RevisionEntry) => void;
  /** Result of comparing the selected revision with the current document. */
  diff?: DocumentDiff | null;
  loading?: boolean;
  /** Fixed clock for tests and server rendering. */
  now?: number;
  locale?: string;
  labels?: PartialLabels;
  className?: string;
};

/** A list of revisions with who and what, a selected state, Restore and Compare, and a diff summary. Keyboard: arrows move, Enter selects. */
export function RevisionHistory({ revisions, currentRevision, selected, onSelect, onRestore, onCompare, diff, loading, now: fixedNow, locale, labels: override, className }: RevisionHistoryProps): ReactNode {
  const labels = useLabels(override);
  const ticking = useNow(fixedNow === undefined, 60_000), now = fixedNow ?? ticking;
  const entries = useMemo(() => revisions.map(toEntry).sort((a, b) => b.revision - a.revision), [revisions]);
  const list = useRef<HTMLUListElement>(null);
  const current = currentRevision ?? entries[0]?.revision;
  const chosen = entries.find((entry) => entry.revision === selected);
  const move = (event: KeyboardEvent): void => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button.se-history-item') ?? []);
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    buttons[next]?.focus();
  };
  const actor = (kind: RevisionEntry['actorKind']): string => kind === 'agent' ? labels.history.agent : kind === 'human' ? labels.history.human : labels.history.system;
  return <section className={`se-panel se-history${className ? ` ${className}` : ''}`} aria-label={labels.history.title} aria-busy={loading || undefined}>
    <h2 className="se-panel-title">{labels.history.title}</h2>
    {entries.length === 0 ? <p className="se-panel-empty">{labels.history.empty}</p> : <ul className="se-history-list" ref={list} aria-label={labels.history.list} onKeyDown={move}>
      {entries.map((entry) => {
        const isCurrent = entry.revision === current, isSelected = entry.revision === selected;
        return <li key={entry.revision}>
          <button type="button" className="se-history-item" data-kind={entry.actorKind} data-selected={isSelected || undefined} aria-current={isCurrent ? 'true' : undefined} aria-pressed={onSelect ? isSelected : undefined} onClick={() => onSelect?.(entry)}>
            <span className="se-history-head">
              <span className="se-badge" data-kind={entry.actorKind}>{actor(entry.actorKind)}</span>
              <span className="se-history-revision">{template(labels.history.revision, { revision: entry.revision })}</span>
              {isCurrent ? <span className="se-history-current">{labels.history.current}</span> : null}
            </span>
            <span className="se-history-summary">{entry.summary}</span>
            <time className="se-history-time" dateTime={entry.at} title={absoluteTime(entry.at, locale)}>{relativeTime(entry.at, now, labels.save.justNow, locale)}</time>
          </button>
        </li>;
      })}
    </ul>}
    {chosen && (onRestore || onCompare) ? <div className="se-history-actions">
      {onCompare ? <button type="button" className="se-button" onClick={() => onCompare(chosen)}>{labels.history.compare}</button> : null}
      {onRestore ? <button type="button" className="se-button" data-primary disabled={chosen.revision === current} onClick={() => onRestore(chosen)}>{labels.history.restore}</button> : null}
    </div> : null}
    {chosen && diff !== undefined ? <p className="se-history-diff" role="status">{diff && (diff.added.length + diff.changed.length + diff.removed.length + diff.moved.length) > 0
      ? template(labels.history.diffSummary, { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, moved: diff.moved.length })
      : labels.history.diffNone}</p> : null}
  </section>;
}
