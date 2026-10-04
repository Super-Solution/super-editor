import type { Caret, ConflictInfo, FieldKey, Placement } from './types.js';
import type { SlashItem } from './catalog.js';
import type { DropTarget } from './drop.js';
import type { Mark, MarkState } from './inline.js';
import type { SelectionState } from './selection.js';
import type { Highlight } from '@super-solution/editor-core';

/** Everything the UI needs to render the interaction layer. Plain data; `getState()` returns a new object whenever any part changes. */
export type EditingState = { blockId: string; field: FieldKey; caret: Caret; selectEnd?: number; seq: number };
export type SlashState = {
  blockId: string; field: FieldKey;
  /** Offset of the typed "/" in the field text, or null when the menu was opened with the "+" button. */
  anchor: number | null;
  query: string; activeIndex: number; items: readonly SlashItem[];
  /** The "+" button inserts after this block instead of replacing an empty paragraph. */
  insertAfter: boolean;
};
export type DragState = { ids: readonly string[]; pointerType: string; target: DropTarget | null; placement: Placement | null };
export type BlockMenuState = { blockIds: readonly string[]; anchorId: string; submenu: 'turn-into' | null };
export type TextSelectionState = {
  blockId: string; field: FieldKey; start: number; end: number;
  marks: Readonly<Record<Mark, MarkState>>; link: string | null; highlight: Highlight | 'mixed' | null;
};
export type PromptState =
  | { kind: 'link'; blockId: string; field: FieldKey; start: number; end: number; href: string; error: string | null }
  | { kind: 'url'; item: SlashItem; blockId: string; error: string | null };
export type SyncRequest = { seq: number; blockId: string; field: FieldKey | null; start: number; end: number };
export type InteractionState = {
  readOnly: boolean;
  selection: SelectionState;
  editing: EditingState | null;
  hover: string | null;
  slash: SlashState | null;
  menu: BlockMenuState | null;
  help: boolean;
  drag: DragState | null;
  textSelection: TextSelectionState | null;
  conflicts: Readonly<Record<string, ConflictInfo>>;
  prompt: PromptState | null;
  chartEditor: string | null;
  sync: SyncRequest | null;
};

export type Store<S> = { get(): S; set(patch: Partial<S>): void; subscribe(listener: () => void): () => void };
export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      let changed = false;
      for (const key of Object.keys(patch) as (keyof S)[]) if (!Object.is(state[key], patch[key])) { changed = true; break; }
      if (!changed) return;
      state = { ...state, ...patch };
      for (const listener of [...listeners]) { try { listener(); } catch { /* A host listener must not break editing. */ } }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
