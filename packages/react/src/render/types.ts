import type { ReactNode } from 'react';
import type { Actor, Block, BlockContent, ChartSpec, ResearchDocument } from '@super-solution/editor-core';
import type { Labels, SharedRenderOptions } from '@super-solution/editor-ui';

export type ReactRenderContext = {
  report: ResearchDocument; options: ReportViewProps; labels: Labels;
  renderDefaultBlock(block: Block): ReactNode;
};
export type ReactBlockRenderer = (block: Block, context: ReactRenderContext) => ReactNode;
export type ReactChartRenderer = (spec: ChartSpec, context: ReactRenderContext) => ReactNode;

export type ReportViewProps = SharedRenderOptions & {
  document: ResearchDocument;
  /** Replace how one block type renders. Return `context.renderDefaultBlock(block)` to fall back. */
  blockRenderers?: Partial<Record<BlockContent['type'], ReactBlockRenderer>> | undefined;
  /** Replace how one chart kind renders (for example a candlestick view from your own charting library). */
  chartRenderers?: Record<string, ReactChartRenderer> | undefined;
  /** Extra UI after each block (edit buttons, comment markers). A new function identity re-renders every block. */
  renderBlockActions?: ((block: Block) => ReactNode) | undefined;
  /**
   * Blocks that render only near the viewport. `true` (default) turns it on above 300 blocks; a number sets the threshold;
   * `false` renders everything. Needs IntersectionObserver; without it every block renders.
   */
  virtualize?: boolean | number | undefined;
  /** Re-render a block only when its id, version, or the document facts it depends on change. Default true. */
  memoize?: boolean | undefined;
  /** Shown instead of the blocks when the document has none. `false` shows nothing. */
  emptyState?: ReactNode | undefined;
  /** Replace the title and metadata header. */
  header?: ReactNode | undefined;
  /** Show a document skeleton instead of content while loading. */
  loading?: boolean | undefined;
  /** Who made the latest change, for the screen-reader announcement ("updated by an agent"). */
  lastActor?: Actor['kind'] | undefined;
  /** Turn off the polite live announcement when the revision changes. */
  announce?: boolean | undefined;
};
