import type { ReactNode } from 'react';
import { findBlocks, safeUrl, type ResearchDocument } from '@super-solution/editor-core';
import { hostOf, revealBlock } from '@super-solution/editor-ui';
import { CitationHoverCard, EmptyState } from '@super-solution/editor-react';

/** The document's citations, numbered the way inline markers are. Hovering a marker shows the same card the document shows. */
export function SourcesTab({ report, onAgent }: { report: ResearchDocument; onAgent(): void }): ReactNode {
  if (!report.citations.length) {
    return <EmptyState title="No sources yet" description="Sources belong to the document, and inline markers point at them. Ask the agent to add one."
      actions={[{ label: 'Open the Agent tab', onClick: onAgent, primary: true }]} />;
  }
  return <section className="se-panel" aria-label="Sources">
    <h2 className="se-panel-title">Sources</h2>
    <ol className="sources">
      {report.citations.map((citation, index) => {
        const cited = findBlocks(report, { citationId: citation.id }), url = safeUrl(citation.url);
        return <li key={citation.id}>
          <CitationHoverCard citation={citation} number={index + 1} citationId={citation.id} />
          <div className="source-body">
            {url ? <a href={url} target="_blank" rel="noopener noreferrer">{citation.title}</a> : <span>{citation.title}</span>}
            <small>{hostOf(citation.url)} · accessed {citation.accessedAt.slice(0, 10)}{citation.publishedAt ? ` · published ${citation.publishedAt.slice(0, 10)}` : ''}</small>
            {cited.length ? <button type="button" className="se-link-button" onClick={() => revealBlock(document, cited[0]!.id)}>Cited in {cited.length} {cited.length === 1 ? 'block' : 'blocks'}</button> : <small>Not cited in any block</small>}
          </div>
        </li>;
      })}
    </ol>
  </section>;
}
