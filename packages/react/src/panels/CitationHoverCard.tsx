import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { safeUrl } from '@super-solution/editor-core';
import type { Citation } from '@super-solution/editor-core';
import { hostOf, template } from '@super-solution/editor-ui';
import type { PartialLabels } from '@super-solution/editor-ui';
import { useLabels } from '../render/context.js';

export type CitationHoverCardProps = {
  /** The source being cited. When missing (a dangling reference) only the number shows. */
  citation: Citation | undefined;
  /** 1-based number in the document's source list; 0 when unknown. */
  number: number;
  /** Id used for the in-page anchor `#cite-<id>` of the references list. */
  citationId: string;
  labels?: PartialLabels;
  /** Replaces the default `[n]` marker. */
  children?: ReactNode;
};

/**
 * An inline citation marker with a hover and focus card showing the source title, host and dates.
 * Esc dismisses the card; it also opens on keyboard focus, so it is not hover-only.
 */
export function CitationHoverCard({ citation, number, citationId, labels: override, children }: CitationHoverCardProps): ReactNode {
  const labels = useLabels(override), cardId = useId();
  const [dismissed, setDismissed] = useState(false);
  const url = citation ? safeUrl(citation.url) : null;
  return <sup className="se-citation" data-citation-id={citationId}
    onMouseEnter={() => setDismissed(false)} onFocus={() => setDismissed(false)}
    onKeyDown={(event) => { if (event.key === 'Escape') setDismissed(true); }}>
    <a className="se-citation-link" href={`#cite-${citationId}`} aria-label={template(labels.blocks.footnote, { number: number || '?' })} aria-describedby={citation ? cardId : undefined}>{children ?? `[${number || '?'}]`}</a>
    {citation ? <span className="se-citation-card" id={cardId} role="tooltip" data-dismissed={dismissed || undefined} style={dismissed ? { display: 'none' } : undefined}>
      <strong className="se-citation-card-title">{citation.title}</strong>
      {hostOf(citation.url) ? <span className="se-citation-card-host">{hostOf(citation.url)}</span> : null}
      <span className="se-citation-card-dates">
        <time dateTime={citation.accessedAt}>{labels.citation.accessed}: {citation.accessedAt}</time>
        {citation.publishedAt ? <> · <time dateTime={citation.publishedAt}>{labels.citation.published}: {citation.publishedAt}</time></> : null}
      </span>
      {url ? <a href={url} target="_blank" rel="noopener noreferrer">{labels.citation.open}</a> : null}
    </span> : null}
  </sup>;
}
