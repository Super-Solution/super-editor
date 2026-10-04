import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { DocumentDiff, ResearchDocument } from '@super-solution/editor-core';
import { RevisionHistory, revisionEntries, type RevisionEntry } from '@super-solution/editor-react';
import type { Doc } from './documents.js';

type Props = { doc: Doc; report: ResearchDocument; selected: number | null; diff: DocumentDiff | null; onSelect(revision: number | null): void; onRestore(entry: RevisionEntry): void };

/**
 * `RevisionHistory` over this session's revisions (`editor.getRevisions()` through `revisionEntries`). Selecting one outlines in the document
 * what changed since (the `diff` the page passes to the editor); Restore applies it as a new revision.
 */
export function HistoryTab({ doc, report, selected, diff, onSelect, onRestore }: Props): ReactNode {
  const entries = useMemo<RevisionEntry[]>(() => [
    ...revisionEntries(doc.editor.getRevisions()),
    { revision: doc.baseline.revision, at: doc.baseline.updatedAt, actorKind: 'system', summary: 'The page as it was opened.' },
  ], [doc, report]);
  return <>
    <p className="tab-note">Every accepted edit is one revision: yours, the agent&apos;s, undo and redo. Pick one to outline what changed since in the document.</p>
    <RevisionHistory revisions={entries} currentRevision={report.revision} selected={selected} {...(selected === null ? {} : { diff })}
      onSelect={(entry) => onSelect(entry.revision === selected ? null : entry.revision)} onRestore={onRestore} />
  </>;
}
