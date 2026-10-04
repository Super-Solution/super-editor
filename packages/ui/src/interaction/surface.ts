import { isContainerType } from '@super-solution/editor-core';
import { cellField, isEditableType, itemField } from './fields.js';
import { hitTest, indexLayout } from './drop.js';
import type { DropOptions, LayoutBox, LayoutIndex } from './drop.js';
import { textOffsetOf } from './inline-dom.js';
import type { Interaction } from './interaction.js';
import { treeOf } from './tree.js';
import type { Box, Caret, FieldKey } from './types.js';

/**
 * Pointer, keyboard and clipboard wiring for one rendered document. It is the only place that reads layout: block boxes are measured
 * lazily, cached until the document or layout changes, and expressed in the root's content coordinates so scrolling never invalidates them.
 */
export type SurfaceOptions = {
  /** How far left of a block the pointer still counts as hovering it (room for the gutter). Default 56. */
  gutterWidth?: number;
  dropOptions?: DropOptions;
  /** Touch: how long to hold a block before it can be dragged. Default 350 ms. */
  longPressMs?: number;
  /** Pointer travel before a handle press becomes a drag. Default 4 px. */
  dragThreshold?: number;
  /** Replace DOM measurement (tests, virtualized hosts). */
  measure?: (root: HTMLElement, interaction: Interaction) => LayoutBox[];
};
export type SurfaceBinding = {
  readonly root: HTMLElement;
  layout(): LayoutIndex;
  /** Fresh content-space box of a rendered block, or null when it is not on screen. */
  rectOf(id: string): Box | null;
  invalidate(): void;
  /** Called when layout may have changed without any state change (resize, image load). */
  subscribe(listener: () => void): () => void;
  /** Pointer position in content space. */
  toContent(clientX: number, clientY: number): { x: number; y: number };
  destroy(): void;
};
const POPUP = '[data-se-popup]', CONTROLS = 'button, input, select, textarea, label, summary, [data-se-no-edit]';

function contentOrigin(root: HTMLElement): { left: number; top: number } {
  const rect = root.getBoundingClientRect();
  return { left: rect.left - root.scrollLeft + root.clientLeft, top: rect.top - root.scrollTop + root.clientTop };
}
export function measureBlocks(root: HTMLElement, interaction: Interaction): LayoutBox[] {
  const tree = treeOf(interaction.editor.getSnapshot()), origin = contentOrigin(root), boxes: LayoutBox[] = [], seen = new Set<string>();
  root.querySelectorAll<HTMLElement>('[data-block-id]').forEach((element) => {
    const id = element.getAttribute('data-block-id');
    if (!id || seen.has(id) || element.closest(`${POPUP},[data-se-gutter]`)) return;
    const block = tree.byId.get(id);
    if (!block) return;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    seen.add(id);
    boxes.push({ id, parentId: block.parentId, left: rect.left - origin.left, top: rect.top - origin.top, right: rect.right - origin.left, bottom: rect.bottom - origin.top });
  });
  return boxes;
}
function scrollParent(element: HTMLElement): HTMLElement | null {
  const view = element.ownerDocument.defaultView;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const overflow = view?.getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

export function attachInteraction(root: HTMLElement, interaction: Interaction, options: SurfaceOptions = {}): SurfaceBinding {
  const doc = root.ownerDocument, view = doc.defaultView;
  const gutter = options.gutterWidth ?? 56, threshold = options.dragThreshold ?? 4, longPress = options.longPressMs ?? 350;
  const dropOptions: DropOptions = { expandLeft: gutter, ...options.dropOptions };
  let cache: LayoutIndex | null = null, destroyed = false, lastLayoutKey = '';
  const listeners = new Set<() => void>();
  const disposers: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, handler: (event: never) => void, capture: boolean | AddEventListenerOptions = false): void => {
    target.addEventListener(type, handler as unknown as EventListener, capture);
    disposers.push(() => target.removeEventListener(type, handler as unknown as EventListener, capture));
  };
  const layout = (): LayoutIndex => cache ?? (cache = indexLayout((options.measure ?? measureBlocks)(root, interaction)));
  const toContent = (clientX: number, clientY: number): { x: number; y: number } => { const origin = contentOrigin(root); return { x: clientX - origin.left, y: clientY - origin.top }; };
  const invalidate = (): void => { cache = null; };
  const announceLayout = (): void => { cache = null; for (const listener of [...listeners]) listener(); };
  const rectOf = (id: string): Box | null => {
    const element = [...root.querySelectorAll<HTMLElement>('[data-block-id]')].find((node) => node.getAttribute('data-block-id') === id && !node.closest(`${POPUP},[data-se-gutter]`));
    if (!element) return null;
    const rect = element.getBoundingClientRect(), origin = contentOrigin(root);
    return { left: rect.left - origin.left, top: rect.top - origin.top, right: rect.right - origin.left, bottom: rect.bottom - origin.top };
  };

  // ---- document and state changes ----------------------------------------------------------------------------------
  disposers.push(interaction.editor.subscribe(invalidate));
  const syncAttributes = (): void => {
    const state = interaction.getState();
    root.toggleAttribute('data-se-dragging', !!state.drag);
    root.toggleAttribute('data-se-editing', !!state.editing);
    root.toggleAttribute('data-se-selecting', state.selection.ids.length > 0);
    root.toggleAttribute('data-se-readonly', state.readOnly);
    // Only state that changes what is rendered in the flow (not overlays such as hover or drag targets) invalidates measured boxes.
    const layoutKey = `${state.editing?.blockId ?? ''}:${state.editing?.field ?? ''}:${state.sync?.seq ?? 0}:${Object.keys(state.conflicts).join(',')}:${state.readOnly}`;
    if (layoutKey !== lastLayoutKey) { lastLayoutKey = layoutKey; invalidate(); }
    // Keys act on a block selection only while focus is inside the document, so pull focus there when blocks get selected.
    if (state.selection.ids.length && !state.editing && !root.contains(doc.activeElement) && !state.drag) root.focus({ preventScroll: true });
  };
  disposers.push(interaction.subscribe(syncAttributes));
  syncAttributes();
  if (view?.ResizeObserver) { const observer = new view.ResizeObserver(announceLayout); observer.observe(root); disposers.push(() => observer.disconnect()); }
  listen(root, 'load', announceLayout, true);
  listen(root, 'toggle', announceLayout, true);
  if (view) listen(view, 'resize', announceLayout);

  // ---- keyboard ---------------------------------------------------------------------------------------------------
  listen(root, 'keydown', (event: KeyboardEvent) => {
    const target = event.target as Element | null;
    if (target?.closest?.(POPUP)) return;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && !target.closest('[data-se-editable]')) return;
    if (interaction.shortcuts.handleKeyDown(event)) event.stopPropagation();
  });
  listen(doc, 'keydown', (event: KeyboardEvent) => { if (event.key === 'Escape' && interaction.getState().drag) { interaction.drag.cancel(); endPointer(); } });

  // ---- hover --------------------------------------------------------------------------------------------------------
  let pending: { kind: 'handle' | 'press'; ids: string[]; id: string; x: number; y: number; pointerType: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
  let dragging = false, scrollFrame: number | null = null, lastClientY = 0;
  listen(root, 'pointermove', (event: PointerEvent) => {
    if (event.pointerType === 'touch' || dragging || pending) return;
    const target = event.target as Element | null;
    if (target?.closest?.(POPUP)) return;
    if (target?.closest?.('[data-se-gutter]')) return;
    const point = toContent(event.clientX, event.clientY);
    interaction.setHover(hitTest(layout(), point.x, point.y, gutter)?.id ?? null);
  });
  listen(root, 'pointerleave', (event: PointerEvent) => {
    if (dragging) return;
    const related = (event as unknown as { relatedTarget?: Element | null }).relatedTarget;
    if (related && root.contains(related)) return;
    interaction.setHover(null);
  });

  // ---- drag (mouse handle, touch long-press) --------------------------------------------------------------------
  function endPointer(): void {
    if (pending?.timer) clearTimeout(pending.timer);
    pending = null; dragging = false;
    if (scrollFrame !== null) { view?.cancelAnimationFrame?.(scrollFrame); scrollFrame = null; }
    doc.removeEventListener('pointermove', onPointerMove); doc.removeEventListener('pointerup', onPointerUp); doc.removeEventListener('pointercancel', onPointerCancel);
  }
  function beginDrag(): void {
    if (!pending) return;
    if (!interaction.drag.start(pending.ids, pending.pointerType)) { endPointer(); return; }
    dragging = true; lastClientY = pending.y;
    (view?.navigator as { vibrate?: (ms: number) => boolean } | undefined)?.vibrate?.(8);
  }
  function autoScroll(): void {
    scrollFrame = null;
    if (!dragging || !view) return;
    const parent = scrollParent(root), edge = 56;
    const top = parent ? parent.getBoundingClientRect().top : 0, bottom = parent ? parent.getBoundingClientRect().bottom : view.innerHeight;
    const speed = lastClientY < top + edge ? -(edge - (lastClientY - top)) / edge * 18 : lastClientY > bottom - edge ? (edge - (bottom - lastClientY)) / edge * 18 : 0;
    if (speed) { if (parent) parent.scrollTop += speed; else { try { view.scrollBy(0, speed); } catch { /* No layout engine. */ } } }
    scrollFrame = view.requestAnimationFrame(autoScroll);
  }
  function onPointerMove(event: PointerEvent): void {
    if (!pending) return;
    const distance = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
    if (!dragging) {
      if (pending.kind === 'press') { if (distance > 8) endPointer(); return; }
      if (distance < threshold) return;
      beginDrag();
      if (!dragging) return;
      if (view) scrollFrame = view.requestAnimationFrame(autoScroll);
    }
    event.preventDefault?.();
    lastClientY = event.clientY;
    const point = toContent(event.clientX, event.clientY);
    interaction.drag.hover(layout(), point.x, point.y, dropOptions);
  }
  function onPointerUp(): void {
    const current = pending, wasDragging = dragging;
    endPointer();
    if (wasDragging) { interaction.drag.drop(); return; }
    // A press on the handle that never moved is a click: select the block and open its menu.
    if (current?.kind === 'handle') interaction.menu.open(current.ids, current.id);
  }
  function onPointerCancel(): void { if (dragging) interaction.drag.cancel(); endPointer(); }
  const armDocumentListeners = (): void => { doc.addEventListener('pointermove', onPointerMove); doc.addEventListener('pointerup', onPointerUp); doc.addEventListener('pointercancel', onPointerCancel); };
  listen(root, 'pointerdown', (event: PointerEvent) => {
    const state = interaction.getState();
    if (state.readOnly || (event.button !== undefined && event.button !== 0)) return;
    const target = event.target as Element | null;
    const handle = target?.closest?.('[data-se-drag-handle]');
    const pointerType = event.pointerType || 'mouse';
    if (handle) {
      const id = handle.getAttribute('data-se-block-id');
      if (!id) return;
      const selected = state.selection.ids;
      pending = { kind: 'handle', ids: selected.length > 1 && selected.includes(id) ? [...selected] : [id], id, x: event.clientX, y: event.clientY, pointerType, timer: null };
      armDocumentListeners();
      return;
    }
    if (pointerType !== 'touch' || target?.closest?.(`${POPUP},[data-se-gutter],[data-se-editable]`)) return;
    const block = target?.closest?.('[data-block-id]');
    const id = block?.getAttribute('data-block-id');
    if (!id) return;
    const timer = setTimeout(() => { if (pending && pending.kind === 'press') { pending.timer = null; beginDrag(); if (dragging && view) scrollFrame = view.requestAnimationFrame(autoScroll); } }, longPress);
    pending = { kind: 'press', ids: [id], id, x: event.clientX, y: event.clientY, pointerType, timer };
    armDocumentListeners();
  });
  // Once a drag has started the browser must not scroll or select under the finger.
  listen(root, 'touchmove', (event: TouchEvent) => { if (dragging) event.preventDefault(); }, { passive: false });
  listen(root, 'contextmenu', (event: Event) => { if (dragging || pending?.kind === 'press') event.preventDefault(); });

  // ---- click: edit text, select other blocks ------------------------------------------------------------------
  function caretIn(host: Element): Caret {
    const selection = doc.getSelection?.();
    if (!selection || !selection.anchorNode || !host.contains(selection.anchorNode)) return 'end';
    return textOffsetOf(host as HTMLElement, selection.anchorNode, selection.anchorOffset);
  }
  /** Which field of which block a click on rendered (not yet editable) content means. */
  function targetFromClick(blockElement: Element, target: Element, type: string): { field: FieldKey; caret: Caret } {
    if (type === 'list') {
      const items = [...blockElement.querySelectorAll('li')], item = target.closest('li');
      const index = item ? Math.max(0, items.indexOf(item)) : Math.max(0, items.length - 1);
      return { field: itemField(index), caret: item ? caretIn(item) : 'end' };
    }
    if (type === 'table') {
      const cell = target.closest('td,th') as HTMLTableCellElement | null;
      if (!cell) return { field: cellField(-1, 0), caret: 'end' };
      const row = cell.closest('tr'), inHead = !!row?.closest('thead');
      const body = [...blockElement.querySelectorAll('tbody tr')];
      return { field: cellField(inHead ? -1 : Math.max(0, row ? body.indexOf(row) : 0), cell.cellIndex), caret: caretIn(cell) };
    }
    return { field: 'main', caret: caretIn(blockElement) };
  }
  listen(root, 'click', (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target as Element | null;
    if (!target || target.closest(`${POPUP},[data-se-gutter],[data-se-editable]`)) return;
    if (target.closest(CONTROLS) && !target.closest('a')) return;
    const state = interaction.getState();
    const blockElement = target.closest('[data-block-id]');
    const id = blockElement?.getAttribute('data-block-id') ?? null;
    const block = id ? treeOf(interaction.editor.getSnapshot()).byId.get(id) : undefined;
    const modified = event.shiftKey || event.metaKey || event.ctrlKey;
    if (!block || !blockElement) {
      if (state.selection.ids.length) interaction.selection.clear();
      return;
    }
    if (modified && !state.readOnly) {
      event.preventDefault(); doc.getSelection?.()?.removeAllRanges();
      interaction.selection.select(block.id, event.shiftKey ? 'extend' : 'toggle');
      return;
    }
    if (state.readOnly) { interaction.selection.select(block.id); return; }
    const anchor = target.closest('a');
    if (anchor && blockElement.contains(anchor) && isEditableType(block.content.type)) event.preventDefault();
    const selected = doc.getSelection?.();
    if (selected && !selected.isCollapsed && blockElement.contains(selected.anchorNode)) return;
    if (!isEditableType(block.content.type)) { interaction.selection.select(block.id); return; }
    // Clicking the empty area of a section or toggle (not its title) selects it instead of editing.
    if (isContainerType(block.content.type) && (target === blockElement || target.hasAttribute('data-block-id'))) { interaction.selection.select(block.id); return; }
    const place = targetFromClick(blockElement, target, block.content.type);
    interaction.edit.start(block.id, { field: place.field, caret: place.caret });
  });
  listen(root, 'dblclick', (event: MouseEvent) => {
    const target = event.target as Element | null;
    if (!target || target.closest(`${POPUP},[data-se-gutter],[data-se-editable]`)) return;
    const id = target.closest('[data-block-id]')?.getAttribute('data-block-id');
    const block = id ? treeOf(interaction.editor.getSnapshot()).byId.get(id) : undefined;
    if (block?.content.type === 'chart' && !interaction.getState().readOnly) interaction.openChartEditor(block.id);
  });

  // ---- clipboard for block selections ---------------------------------------------------------------------------
  const blockSelection = (event: Event): boolean => !interaction.getState().editing && interaction.getState().selection.ids.length > 0 && !(event.target as Element | null)?.closest?.(POPUP);
  listen(root, 'copy', (event: ClipboardEvent) => { if (blockSelection(event) && event.clipboardData && interaction.clipboard.copy(event.clipboardData)) event.preventDefault(); });
  listen(root, 'cut', (event: ClipboardEvent) => { if (blockSelection(event) && event.clipboardData && interaction.clipboard.cut(event.clipboardData)) event.preventDefault(); });
  listen(root, 'paste', (event: ClipboardEvent) => {
    if (event.defaultPrevented || interaction.getState().editing || (event.target as Element | null)?.closest?.(POPUP)) return;
    if (event.clipboardData && interaction.clipboard.paste(event.clipboardData)) event.preventDefault();
  });

  // ---- leaving the document -------------------------------------------------------------------------------------
  listen(root, 'focusout', (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (next && root.contains(next)) return;
    // Switching windows or tabs keeps the editing session; moving focus elsewhere on the page ends it.
    if (!next && !doc.hasFocus()) return;
    if (interaction.getState().editing) interaction.edit.stop();
  });

  return {
    root, layout, rectOf, invalidate, toContent,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    destroy() { if (destroyed) return; destroyed = true; endPointer(); disposers.forEach((dispose) => dispose()); listeners.clear(); },
  };
}
