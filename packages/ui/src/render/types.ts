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
  className?: string;
  embedPolicy?: EmbedPolicy;
  /** Any subset of the UI strings; the rest stay English. */
  labels?: PartialLabels;
  locale?: string;
  /** Called when a reader opens or closes a toggle. The view updates itself either way. */
  onToggle?: (block: Block, open: boolean) => void;
  /** When set, to-do checkboxes become interactive and report the new state. */
  onToggleTodo?: (block: Block, index: number, checked: boolean) => void;
  /** A block failed to render; the block shows an error card and the rest of the document is unaffected. */
  onRenderError?: (error: unknown, block: Block) => void;
  diff?: DiffMarks;
  find?: FindHighlight;
  /** Show the chart toolbar (view data, export). Default true. */
  chartActions?: boolean;
  /** Render the title and metadata header. Default true. */
  showHeader?: boolean;
  /** Sets `data-se-theme`. Without it the host's CSS tokens and `prefers-color-scheme` decide. */
  theme?: ThemeName;
  density?: Density;
  /** Colors used when a chart is exported as SVG/PNG. Default light. */
  exportTheme?: ChartTheme;
};

export type RenderOptions = SharedRenderOptions & {
  document?: Document;
  blockRenderers?: Partial<Record<BlockContent['type'], BlockRenderer>>;
  chartRenderers?: Record<string, ChartRenderer>;
};
export type RenderContext = {
  document: Document; report: ResearchDocument; options: RenderOptions; labels: Labels;
  renderDefaultBlock(block: Block): HTMLElement;
};
export type BlockRenderer = (block: Block, context: RenderContext) => HTMLElement;
export type ChartRenderer = (spec: ChartSpec, context: RenderContext) => HTMLElement;
export type { EmbedPolicy };
