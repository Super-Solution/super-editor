/** Serializable v1 contract. IDs are caller-assigned and never rewritten. */
export type Actor = { id: string; kind: 'human' | 'agent' | 'system' };
export type InlineRun = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };
export type ChartSpec = {
  kind: string; title: string; labels: string[];
  series: { name: string; values: number[] }[];
  unit?: string; asOf?: string;
};
export type BlockContent =
  | { type: 'section'; title: string }
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'paragraph'; runs: InlineRun[] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'chart'; spec: ChartSpec }
  | { type: 'embed'; provider: 'superchart'; url: string; title: string }
  | { type: 'timestamp'; at: string; label: string };
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
  | { type: 'addCitation'; citation: Citation };
export type Transaction = {
  id: string; actor: Actor; baseRevision: number;
  /** Explicit opt-in: only version-guarded updateBlock operations may rebase. */
  conflictPolicy?: 'reject' | 'rebase-safe'; operations: Operation[];
};
export type EditorIssue = {
  code: 'validation' | 'conflict' | 'not-found' | 'duplicate' | 'history';
  message: string; path?: string; blockId?: string;
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
