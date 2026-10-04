import type { Actor, ApplyResult, BlockContent, EditorIssue } from '@super-solution/editor-core';

export type Platform = 'mac' | 'other';
/** Content-space rectangle: pixels relative to the interaction root's scrollable content origin. */
export type Box = { left: number; top: number; right: number; bottom: number };
/** Which text field of a block an edit targets. Single-field blocks use `main`; lists use items; tables use cells (row -1 is the header). */
export type FieldKey = 'main' | `item:${number}` | `cell:${number}:${number}`;
export type Caret = 'start' | 'end' | number;
export type FeedbackKind = 'info' | 'success' | 'error' | 'conflict';
/** Everything a host may want to surface as a toast, live-region message or log line. */
export type FeedbackEvent = {
  kind: FeedbackKind; message: string; blockIds?: readonly string[];
  /** For example "Undo" after a delete. */
  action?: { label: string; run(): void };
};
export type ConflictInfo = {
  /** The command that hit the conflict, for example `deleteBlocks` or `commit`. */
  command: string; message: string; issues: readonly EditorIssue[]; blockId?: string;
  /** For an edit conflict: the local draft and the content now in the document. */
  mine?: BlockContent; theirs?: BlockContent;
};
export type CommandOutcome = ApplyResult | null;
export type InteractionActor = Actor & { kind: 'human' };
/** Placement arguments of a `moveBlocks` operation. */
export type Placement = { parentId: string | null; afterId: string | null };
