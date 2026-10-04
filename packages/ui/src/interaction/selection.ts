/** Block selection as pure reducers. `ids` is always in document (pre-)order; `anchorId` is where a shift-range started. */
export type SelectionState = { ids: readonly string[]; anchorId: string | null; focusId: string | null };
export const emptySelection: SelectionState = Object.freeze({ ids: Object.freeze([]) as readonly string[], anchorId: null, focusId: null });

/** Blocks from `a` to `b` inclusive, in `order`. Unknown ids yield an empty range. */
export function selectionRange(order: readonly string[], a: string, b: string): string[] {
  const from = order.indexOf(a), to = order.indexOf(b);
  if (from === -1 || to === -1) return [];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}
const inOrder = (order: readonly string[], ids: Iterable<string>): string[] => { const wanted = new Set(ids); return order.filter((id) => wanted.has(id)); };
export function selectOnly(id: string): SelectionState { return { ids: [id], anchorId: id, focusId: id }; }
export function selectMany(order: readonly string[], ids: readonly string[]): SelectionState {
  const sorted = inOrder(order, ids);
  return sorted.length ? { ids: sorted, anchorId: sorted[0]!, focusId: sorted[sorted.length - 1]! } : emptySelection;
}
export function toggleSelection(state: SelectionState, order: readonly string[], id: string): SelectionState {
  const has = state.ids.includes(id);
  const ids = inOrder(order, has ? state.ids.filter((entry) => entry !== id) : [...state.ids, id]);
  return ids.length ? { ids, anchorId: id, focusId: id } : emptySelection;
}
/** Shift-click: the range between the anchor and `id` replaces the selection. */
export function extendSelection(state: SelectionState, order: readonly string[], id: string): SelectionState {
  const anchor = state.anchorId && order.includes(state.anchorId) ? state.anchorId : id;
  const ids = selectionRange(order, anchor, id);
  return ids.length ? { ids, anchorId: anchor, focusId: id } : emptySelection;
}
export function selectAllBlocks(order: readonly string[]): SelectionState { return order.length ? { ids: [...order], anchorId: order[0]!, focusId: order[order.length - 1]! } : emptySelection; }
/** Arrow keys over a block selection. Without `extend` the selection collapses to the block next to its focus. */
export function moveSelectionFocus(state: SelectionState, order: readonly string[], delta: -1 | 1, extend: boolean): SelectionState {
  if (!state.ids.length || !order.length) return state;
  const focus = state.focusId && order.includes(state.focusId) ? state.focusId : state.ids[state.ids.length - 1]!;
  const at = order.indexOf(focus), next = Math.max(0, Math.min(order.length - 1, at + delta)), id = order[next]!;
  if (!extend) return selectOnly(id);
  return extendSelection(state, order, id);
}
export function pruneSelection(state: SelectionState, exists: (id: string) => boolean): SelectionState {
  const ids = state.ids.filter(exists);
  if (ids.length === state.ids.length && (!state.anchorId || exists(state.anchorId)) && (!state.focusId || exists(state.focusId))) return state;
  return ids.length ? { ids, anchorId: state.anchorId && exists(state.anchorId) ? state.anchorId : ids[0]!, focusId: state.focusId && exists(state.focusId) ? state.focusId : ids[ids.length - 1]! } : emptySelection;
}
