/** Serializable v1 contract. IDs are caller-assigned and never rewritten. */
export type Actor = { id: string; kind: 'human' | 'agent' | 'system' };
export type Highlight = 'yellow' | 'green' | 'blue' | 'pink' | 'gray';
export type InlineRun = {
  text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string;
  strike?: boolean; underline?: boolean; highlight?: Highlight;
  /** Inline citation marker; must reference an id in `document.citations`. */
  citationId?: string;
};
/** Unknown kinds stay valid and render as a data fallback. */
export type ChartKind = 'pie' | 'donut' | 'bar' | 'trend' | 'line' | 'area' | 'scatter' | 'histogram'
  | 'candlestick' | 'heatmap' | 'waterfall';
export type ChartSpec = {
  kind: string; title: string; labels: string[];
  series: { name: string; values: number[]; color?: string }[];
  unit?: string; asOf?: string;
  stacked?: boolean; horizontal?: boolean;
  yAxis?: { label?: string; format?: 'number' | 'percent' | 'currency' | 'compact'; min?: number; max?: number; currency?: string };
  xLabel?: string; caption?: string;
  /** Human-readable provenance, for example "OKX daily candles". */
  source?: string;
  /** `at` is one of `labels` for category-axis kinds. */
  annotations?: { label: string; at: string; value?: number }[];
  /** Scatter data. `labels`/`series` still carry a data-table fallback. */
  points?: { series: string; x: number; y: number }[];
  /** Candlestick data. `labels`/`series` still carry a close-price fallback. */
  ohlc?: { t: string; o: number; h: number; l: number; c: number; v?: number }[];
  /** Heatmap data. `labels`/`series` still carry a row-by-row fallback. */
  matrix?: { rows: string[]; columns: string[]; values: number[][] };
};
export type CalloutTone = 'info' | 'success' | 'warning' | 'danger' | 'note';
export type BlockContent =
  | { type: 'section'; title: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; runs: InlineRun[] }
  | { type: 'list'; ordered: boolean; items: string[];
      style?: 'bullet' | 'number' | 'todo'; checked?: boolean[]; indent?: number[] }
  | { type: 'table'; columns: string[]; rows: string[][];
      align?: ('left' | 'center' | 'right')[]; caption?: string; headerColumn?: boolean }
  | { type: 'chart'; spec: ChartSpec }
  | { type: 'embed'; provider: 'superchart'; url: string; title: string; height?: number }
  | { type: 'timestamp'; at: string; label: string }
  | { type: 'quote'; runs: InlineRun[]; attribution?: string }
  | { type: 'callout'; tone: CalloutTone; title?: string; runs: InlineRun[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'divider' }
  | { type: 'image'; url: string; alt: string; caption?: string; width?: 'narrow' | 'normal' | 'wide' | 'full' }
  | { type: 'toggle'; title: string; open: boolean }
  | { type: 'metrics'; items: { label: string; value: string; change?: number; tone?: 'up' | 'down' | 'neutral'; hint?: string }[] }
  | { type: 'toc' }
  | { type: 'pageBreak' };
export type BlockType = BlockContent['type'];
export type BlockInput = {
  id: string; parentId: string | null; content: BlockContent; citationIds: string[];
};
export type Block = BlockInput & { version: number; createdAt: string; updatedAt: string };
export type Citation = { id: string; title: string; url: string; accessedAt: string; publishedAt?: string };
export type DocumentFormat = {
  page: 'screen' | 'A4' | 'letter'; font: 'sans' | 'serif' | 'mono';
  fontSize: number; lineHeight: number;
};
export type ResearchDocument = {
  schemaVersion: 1; id: string; title: string; revision: number;
  createdAt: string; updatedAt: string; format: DocumentFormat;
  blocks: Block[]; citations: Citation[];
  /** Deleted IDs remain reserved, including IDs abandoned by undo. */
  retiredBlockIds: string[];
};
export type Operation =
  | { type: 'insertBlock'; block: BlockInput; afterId?: string | null }
  | { type: 'updateBlock'; blockId: string; expectedVersion: number; content: BlockContent; citationIds?: string[] }
  | { type: 'moveBlock'; blockId: string; expectedVersion: number; parentId: string | null; afterId?: string | null }
  | { type: 'deleteBlock'; blockId: string; expectedVersion: number }
  | { type: 'setTitle'; title: string }
  | { type: 'setFormat'; format: DocumentFormat }
  | { type: 'addCitation'; citation: Citation }
  /** Ordered and all-or-nothing. The first block follows `afterId`; each later block follows the previous block with the same parent (or is appended to its parent). */
  | { type: 'insertBlocks'; blocks: BlockInput[]; afterId?: string | null }
  /** Deep copy. `newIds` maps the block and every descendant (old id to new id). Omitted `afterId` places the copy right after the original. */
  | { type: 'duplicateBlock'; blockId: string; expectedVersion: number; newIds: Record<string, string>; afterId?: string | null }
  /** Replaces text in one block. Fails with `not-found` when nothing matches. Matches may span inline runs. */
  | { type: 'replaceText'; blockId: string; expectedVersion: number; find: string; replace: string; all?: boolean; caseSensitive?: boolean }
  | { type: 'deleteBlocks'; blocks: { blockId: string; expectedVersion: number }[] }
  | { type: 'moveBlocks'; blocks: { blockId: string; expectedVersion: number }[]; parentId: string | null; afterId?: string | null }
  | { type: 'updateCitation'; citation: Citation }
  /** Also strips `citationIds` entries and inline `citationId` markers that reference it. */
  | { type: 'removeCitation'; citationId: string };
export type Transaction = {
  id: string; actor: Actor; baseRevision: number;
  /** Explicit opt-in: only version-guarded updateBlock and replaceText operations may rebase. */
  conflictPolicy?: 'reject' | 'rebase-safe'; operations: Operation[];
};
export type EditorIssue = {
  code: 'validation' | 'conflict' | 'not-found' | 'duplicate' | 'history';
  message: string; path?: string; blockId?: string;
  /** Actionable remediation for agents and UIs. */
  hint?: string;
};
export type Revision = {
  number: number; transactionId: string; actor: Actor; at: string;
  kind: 'apply' | 'undo' | 'redo'; operations: Operation[]; rebasedFrom?: number;
};
export type ApplyResult =
  | { ok: true; document: ResearchDocument; revision: Revision; duplicate?: true }
  | { ok: false; issues: EditorIssue[]; currentRevision: number };
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: EditorIssue[] };
export type EditorOptions = { now?: () => string; historyLimit?: number };
export interface Editor {
  getSnapshot(): ResearchDocument;
  subscribe(listener: () => void): () => void;
  apply(transaction: unknown): ApplyResult;
  undo(actor: Actor, expectedRevision: number): ApplyResult;
  redo(actor: Actor, expectedRevision: number): ApplyResult;
  getRevisions(): readonly Revision[];
}
