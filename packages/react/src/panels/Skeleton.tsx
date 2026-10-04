import type { CSSProperties, ReactNode } from 'react';
import type { PartialLabels } from '@super-solution/editor-ui';
import { useLabels } from '../render/context.js';

export type SkeletonProps = {
  /** `text` draws that many lines; `block` one rectangle; `circle` a round avatar. */
  shape?: 'text' | 'block' | 'circle';
  lines?: number;
  width?: number | string;
  height?: number | string;
  className?: string;
};
/** A shimmering placeholder. Purely visual: wrap groups in `role="status"` (see DocumentSkeleton). */
export function Skeleton({ shape = 'text', lines = 1, width, height, className }: SkeletonProps): ReactNode {
  if (shape === 'text' && lines > 1) {
    return <span className={`se-skeleton-lines${className ? ` ${className}` : ''}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => <span key={index} className="se-skeleton" data-shape="text" style={{ width: index === lines - 1 ? '62%' : width ?? '100%' } as CSSProperties} />)}
    </span>;
  }
  return <span className={`se-skeleton${className ? ` ${className}` : ''}`} data-shape={shape} aria-hidden="true" style={{ width, height } as CSSProperties} />;
}

/** A document-shaped loading placeholder: title, paragraphs and a chart. Announces "Loading" once to assistive tech. */
export function DocumentSkeleton({ labels: override, blocks = 3 }: { labels?: PartialLabels; blocks?: number }): ReactNode {
  const labels = useLabels(override);
  return <div className="se-skeleton-document" role="status" aria-live="polite" aria-busy="true">
    <span className="se-sr">{labels.skeleton.loading}</span>
    <Skeleton shape="block" width="55%" height="2rem" />
    {Array.from({ length: blocks }, (_, index) => <Skeleton key={index} lines={index === 1 ? 5 : 3} />)}
    <Skeleton shape="block" height="14rem" />
    <Skeleton lines={2} />
  </div>;
}
