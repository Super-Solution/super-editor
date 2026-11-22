// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import type { Block, BlockContent, ChartSpec, ResearchDocument } from '@supersolutions/super-editor-core';
import type { ChartTheme } from '../charts/palette.js';
import type { Labels, PartialLabels } from './labels.js';
import type { EmbedPolicy } from './models.js';

/** Block ids to mark as changed relative to another revision (see `diffDocuments`). */
export type DiffMarks = { added?: Iterable<string>; changed?: Iterable<string>; moved?: Iterable<string> };
/** Highlights text matches in the rendered blocks. `activeBlockId` marks the current match. */
export type FindHighlight = { query: string; caseSensitive?: boolean; activeBlockId?: string | null };
export type Density = 'compact' | 'comfortable' | 'spacious';
/** `host` follows the page's own switch (an ancestor with class `dark`, `data-theme="dark"` and similar); see tokens.css. */
export type ThemeName = 'light' | 'dark' | 'auto' | 'host';

/** Options shared by the DOM and React renderers (all optional). */
export type SharedRenderOptions = {
  className?: string | undefined;
  embedPolicy?: EmbedPolicy | undefined;
  /** Any subset of the UI strings; the rest stay English. */
  labels?: PartialLabels | undefined;
  locale?: string | undefined;
  /** IANA time zone (for example `Asia/Taipei`) for timestamps and the "updated" time. With `locale` or this set they are formatted for people; with neither they stay ISO text. */
  timeZone?: string | undefined;
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
  /**
   * Draws `card` blocks, by card kind. Pass a chat plugin's `mounts` (super-protocol `CardMount`) as they are: each card is
   * mounted with placement `document`. A kind without a mount, or one that fails, shows the block's title and `alt` text.
   */
  cardMounts?: Readonly<Record<string, CardMount>> | undefined;
};

/** Where a card is drawn. Structurally super-protocol's `CardPlacement`; a document always passes `document`. */
export type CardPlacement = 'inline' | 'panel' | 'document';
/** The part of super-protocol's `CardMountContext` a document fills in. */
export type CardMountContext = { theme: 'light' | 'dark'; placement?: CardPlacement; locale?: string };
export type CardMountHandle = { update(spec: unknown, context: CardMountContext): void; destroy(): void };
/** Structurally super-protocol's `CardMount`, so a chat plugin's mounts work here unchanged. */
export type CardMount = (container: HTMLElement, spec: unknown, context: CardMountContext) => CardMountHandle;

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
