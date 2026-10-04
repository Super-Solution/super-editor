import type { Block, BlockContent, ChartSpec, ResearchDocument } from '@super-solution/editor-core';
import type { ChartTheme } from '../charts/palette.js';
import type { Labels, PartialLabels } from './labels.js';
import type { EmbedPolicy } from './models.js';

/** Block ids to mark as changed relative to another revision (see `diffDocuments`). */
export type DiffMarks = { added?: Iterable<string>; changed?: Iterable<string>; moved?: Iterable<string> };
/** Highlights text matches in the rendered blocks. `activeBlockId` marks the current match. */
export type FindHighlight = { query: string; caseSensitive?: boolean; activeBlockId?: string | null };
export type Density = 'compact' | 'comfortable' | 'spacious';
export type ThemeName = 'light' | 'dark' | 'auto';

/** Options shared by the DOM and React renderers (all optional). */
export type SharedRenderOptions = {
  className?: string | undefined;
  embedPolicy?: EmbedPolicy | undefined;
  /** Any subset of the UI strings; the rest stay English. */
  labels?: PartialLabels | undefined;
  locale?: string | undefined;
  /** Called when a reader opens or closes a toggle. The view updates itself either way. */
  onToggle?: ((block: Block, open: boolean) => void) | undefined;
  /** When set, to-do checkboxes become interactive and report the new state. */
  onToggleTodo?: ((block: Block, index: number, checked: boolean) => void) | undefined;
  /** A block failed to render; the block shows an error card and the rest of the document is unaffected. */
  onRenderError?: ((error: unknown, block: Block) => void) | undefined;
  diff?: DiffMarks | undefined;
  find?: FindHighlight | undefined;
  /** Show the chart toolbar (view data, export). Default true. */
  chartActions?: boolean | undefined;
  /** Render the title and metadata header. Default true. */
  showHeader?: boolean | undefined;
  /** Sets `data-se-theme`. Without it the host's CSS tokens and `prefers-color-scheme` decide. */
  theme?: ThemeName | undefined;
  density?: Density | undefined;
  /** Colors used when a chart is exported as SVG/PNG. Default light. */
  exportTheme?: ChartTheme | undefined;
};

export type RenderOptions = SharedRenderOptions & {
  document?: Document | undefined;
  blockRenderers?: Partial<Record<BlockContent['type'], BlockRenderer>> | undefined;
  chartRenderers?: Record<string, ChartRenderer> | undefined;
};
export type RenderContext = {
  document: Document; report: ResearchDocument; options: RenderOptions; labels: Labels;
  renderDefaultBlock(block: Block): HTMLElement;
};
export type BlockRenderer = (block: Block, context: RenderContext) => HTMLElement;
export type ChartRenderer = (spec: ChartSpec, context: RenderContext) => HTMLElement;
export type { EmbedPolicy };
