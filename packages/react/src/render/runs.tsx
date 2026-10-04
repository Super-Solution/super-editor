import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { Block, InlineRun, ResearchDocument } from '@super-solution/editor-core';
import { runSegments, splitMatches, template } from '@super-solution/editor-ui';
import type { Labels, SharedRenderOptions } from '@super-solution/editor-ui';
import { CitationHoverCard } from '../panels/CitationHoverCard.js';

type FindContext = Pick<SharedRenderOptions, 'find'>;

/** Text with the active find query wrapped in <mark>. Without a query it is the plain string. */
export function HighlightedText({ text, options, blockId }: { text: string; options: FindContext; blockId?: string }): ReactNode {
  const find = options.find;
  if (!find?.query) return text;
  return <>{splitMatches(text, find.query, find.caseSensitive).map((part, index) => part.match
    ? <mark key={index} className="se-find-match" data-active={blockId !== undefined && find.activeBlockId === blockId ? 'true' : undefined}>{part.text}</mark>
    : <Fragment key={index}>{part.text}</Fragment>)}</>;
}

export function Runs({ runs, report, labels, options, block }: { runs: readonly InlineRun[]; report: ResearchDocument; labels: Labels; options: FindContext; block?: Block }): ReactNode {
  return <>{runSegments(runs, report.citations).map((segment, index) => {
    let node: ReactNode = <HighlightedText text={segment.text} options={options} {...(block ? { blockId: block.id } : {})} />;
    if (segment.code) node = <code>{node}</code>;
    if (segment.italic) node = <em>{node}</em>;
    if (segment.bold) node = <strong>{node}</strong>;
    if (segment.strike) node = <s>{node}</s>;
    if (segment.underline) node = <u>{node}</u>;
    if (segment.highlight) node = <mark className="se-highlight" data-highlight={segment.highlight}>{node}</mark>;
    if (segment.href) node = <a href={segment.href} target="_blank" rel="noopener noreferrer">{node}</a>;
    else if (segment.unsafeHref) node = <span>{node} {labels.document.unsafeUrl}</span>;
    return <Fragment key={index}>{node}{segment.citation
      ? <CitationHoverCard citationId={segment.citation.id} citation={segment.citation.citation} number={segment.citation.number} />
      : null}</Fragment>;
  })}</>;
}
export { template };
