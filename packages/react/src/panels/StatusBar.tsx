import { useDeferredValue, useMemo } from 'react';
import type { ReactNode } from 'react';
import { stats } from '@super-solution/editor-core';
import type { ResearchDocument } from '@super-solution/editor-core';
import { plural, template } from '@super-solution/editor-ui';
import type { Labels, PartialLabels } from '@super-solution/editor-ui';
import { useLabels } from '../render/context.js';
import { SaveIndicator } from './SaveIndicator.js';
import type { SaveIndicatorProps } from './SaveIndicator.js';

export type StatusBarProps = {
  document: ResearchDocument;
  /** Adds the save indicator. Omit to show only the document counts. */
  save?: Omit<SaveIndicatorProps, 'labels' | 'locale'>;
  /** Extra items (selection count, zoom, collaborators) rendered at the end. */
  children?: ReactNode;
  locale?: string;
  labels?: PartialLabels;
  className?: string;
};

/** Words, reading time, blocks and charts for a document, in the labels' language. Pure; used by StatusBar and exports. */
export function documentCounts(document: ResearchDocument, labels: Labels): { words: string; reading: string; blocks: string; charts: string; revision: string } {
  const summary = stats(document);
  return {
    words: plural(summary.words, labels.status.word, labels.status.words),
    reading: summary.readingMinutes === 0 ? '' : summary.readingMinutes < 1 ? labels.status.readingShort : template(labels.status.readingTime, { minutes: summary.readingMinutes }),
    blocks: plural(summary.blocks, labels.status.block, labels.status.blocks),
    charts: summary.charts ? plural(summary.charts, labels.status.chart, labels.status.charts) : '',
    revision: template(labels.status.revision, { revision: document.revision }),
  };
}

/** Footer for an editor: words, reading time, blocks, charts and revision on the left, save state on the right. */
export function StatusBar({ document, save, children, locale, labels: override, className }: StatusBarProps): ReactNode {
  const labels = useLabels(override);
  // Counting words is linear in document size; let typing stay responsive and catch up a frame later.
  const deferred = useDeferredValue(document);
  const counts = useMemo(() => documentCounts(deferred, labels), [deferred, labels]);
  const items = [counts.words, counts.reading, counts.blocks, counts.charts, counts.revision].filter(Boolean);
  return <div className={`se-status-bar${className ? ` ${className}` : ''}`} role="group" aria-label={labels.status.region}>
    <ul className="se-status-items">{items.map((item) => <li key={item}>{item}</li>)}</ul>
    {children}
    {save ? <SaveIndicator {...save} {...(locale ? { locale } : {})} {...(override ? { labels: override } : {})} /> : null}
  </div>;
}
