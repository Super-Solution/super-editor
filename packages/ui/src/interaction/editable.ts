import type { InlineRun } from '@super-solution/editor-core';
import { fieldRuns, fieldText } from './fields.js';
import type { Interaction } from './interaction.js';
import { runsEqual } from './inline.js';
import { caretLine, getSelectionOffsets, readRunsFrom, readTextFrom, renderRunsInto, renderTextInto, setSelectionOffsets, textLength } from './inline-dom.js';
import type { Caret, FieldKey } from './types.js';

/**
 * Turns one element into the live editing surface of one text field. All state lives in the interaction layer: this binding only
 * mirrors DOM edits into drafts and applies re-render and focus requests back to the DOM. It never decides what an edit means.
 */
export type EditableOptions = {
  interaction: Interaction; blockId: string; field: FieldKey;
  /** `rich` keeps inline marks (paragraph, quote, callout); `plain` is text only. */
  mode: 'rich' | 'plain';
  placeholder?: string;
  label?: string;
  /** Number shown for a citation marker, normally its index in the document's citations. */
  citationLabel?: (citationId: string) => string;
  /** Focus the field as soon as it is bound if the interaction state says this field is being edited. Default true. */
  autoFocus?: boolean;
};
export type EditableBinding = { render(): void; focus(caret?: Caret, selectEnd?: number): void; destroy(): void };

export function attachEditable(element: HTMLElement, options: EditableOptions): EditableBinding {
  const { interaction, blockId, field, mode } = options;
  const doc = element.ownerDocument;
  let composing = false, suppressFocus = false, lastData: string | null = null, appliedSync = interaction.getState().sync?.seq ?? 0, appliedFocus = -1, destroyed = false;
  const citationOptions = options.citationLabel ? { citationLabel: options.citationLabel } : {};
  element.setAttribute('contenteditable', 'true'); element.setAttribute('tabindex', '-1'); element.setAttribute('role', 'textbox'); element.setAttribute('aria-multiline', mode === 'rich' ? 'true' : 'false');
  element.setAttribute('spellcheck', 'true'); element.setAttribute('data-se-editable', ''); element.setAttribute('data-field', field); element.setAttribute('data-se-block-id', blockId);
  if (options.placeholder) element.setAttribute('data-placeholder', options.placeholder);
  if (options.label) element.setAttribute('aria-label', options.label);
  element.setAttribute('aria-readonly', 'false');

  const content = () => interaction.edit.draftContent(blockId);
  const markEmpty = (): void => { element.setAttribute('data-empty', textLength(element) === 0 ? 'true' : 'false'); };
  const read = (): string | InlineRun[] => mode === 'rich' ? readRunsFrom(element) : readTextFrom(element);
  const differs = (): boolean => {
    const current = content();
    if (!current) return false;
    if (mode === 'rich') { const runs = fieldRuns(current, field); return !!runs && !runsEqual(runs, readRunsFrom(element)); }
    return fieldText(current, field) !== readTextFrom(element);
  };
  const focused = (): boolean => doc.activeElement === element;
  function render(keepSelection = focused()): void {
    const current = content();
    if (!current) return;
    const saved = keepSelection ? getSelectionOffsets(element) : null;
    if (mode === 'rich') renderRunsInto(element, fieldRuns(current, field) ?? [], citationOptions); else renderTextInto(element, fieldText(current, field));
    markEmpty();
    if (saved) { const length = textLength(element); setSelectionOffsets(element, Math.min(saved.start, length), Math.min(saved.end, length)); }
  }
  function place(caret: Caret, selectEnd?: number): void {
    const length = textLength(element);
    const at = caret === 'start' ? 0 : caret === 'end' ? length : Math.max(0, Math.min(length, caret));
    element.focus({ preventScroll: true } as FocusOptions);
    setSelectionOffsets(element, at, selectEnd === undefined ? at : Math.max(0, Math.min(length, selectEnd)));
    element.scrollIntoView?.({ block: 'nearest' });
  }
  function sync(): void {
    if (destroyed || !differs()) return;
    interaction.edit.input(blockId, field, read(), { ...(getSelectionOffsets(element) ? { caret: getSelectionOffsets(element)!.end } : {}), data: lastData });
  }
  const unregister = interaction.edit.register(blockId, field, {
    sync,
    selection: () => getSelectionOffsets(element),
    caretLine: () => caretLine(element),
    focus: () => place('end'),
  });

  const on = <T extends Event>(target: EventTarget, type: string, listener: (event: T) => void, capture = false): (() => void) => { target.addEventListener(type, listener as EventListener, capture); return () => target.removeEventListener(type, listener as EventListener, capture); };
  const offs: (() => void)[] = [];
  offs.push(on<InputEvent>(element, 'beforeinput', (event) => {
    lastData = event.data ?? null;
    // Enter and undo are ours: virtual keyboards report them here rather than as key events.
    switch (event.inputType) {
      case 'insertParagraph': event.preventDefault(); interaction.edit.enter(); break;
      case 'insertLineBreak': event.preventDefault(); interaction.edit.softBreak(); break;
      case 'historyUndo': event.preventDefault(); interaction.commands.undo(); break;
      case 'historyRedo': event.preventDefault(); interaction.commands.redo(); break;
    }
  }));
  offs.push(on<InputEvent>(element, 'input', (event) => {
    if (event.data !== undefined && event.data !== null) lastData = event.data;
    markEmpty();
    const next = read(), selection = getSelectionOffsets(element);
    interaction.edit.input(blockId, field, next, { ...(selection && !composing && !event.isComposing ? { caret: selection.end } : {}), data: composing || event.isComposing ? null : event.data ?? lastData });
    lastData = null;
  }));
  offs.push(on(element, 'compositionstart', () => { composing = true; }));
  offs.push(on(element, 'compositionend', () => { composing = false; }));
  offs.push(on<ClipboardEvent>(element, 'paste', (event) => {
    event.preventDefault();
    if (event.clipboardData) interaction.clipboard.paste(event.clipboardData);
  }));
  offs.push(on<Event>(element, 'drop', (event) => event.preventDefault()));
  offs.push(on<FocusEvent>(element, 'focus', () => {
    const state = interaction.getState();
    if (state.editing?.blockId === blockId && state.editing.field === field) return;
    const selection = getSelectionOffsets(element);
    // The browser already placed the caret; do not move it again while the user may be mid-drag.
    suppressFocus = true;
    try { interaction.edit.start(blockId, { field, caret: selection ? selection.start : 'end' }); } finally { suppressFocus = false; }
  }));
  offs.push(on<FocusEvent>(element, 'blur', () => { if (!composing) interaction.edit.flush(blockId); }));
  offs.push(on(doc, 'selectionchange', () => {
    if (destroyed || !focused()) return;
    const selection = getSelectionOffsets(element);
    if (selection) interaction.edit.reportSelection(blockId, field, selection.start, selection.end);
  }));

  const applyState = (): void => {
    if (destroyed) return;
    const state = interaction.getState();
    const request = state.sync;
    if (request && request.seq > appliedSync) {
      appliedSync = request.seq;
      if (request.blockId === blockId && (request.field === null || request.field === field)) {
        render(false);
        if (request.field === field && focused()) { const length = textLength(element); setSelectionOffsets(element, Math.min(request.start, length), Math.min(request.end, length)); interaction.edit.reportSelection(blockId, field, Math.min(request.start, length), Math.min(request.end, length)); }
        else if (request.field === null && focused()) { const length = textLength(element); setSelectionOffsets(element, Math.min(request.start, length), Math.min(request.end, length)); }
      }
    }
    // The field is the combobox of an open slash menu: point assistive technology at the listbox and its highlighted option.
    const slash = state.slash;
    if (slash && slash.blockId === blockId && slash.field === field) {
      const active = slash.items[slash.activeIndex];
      element.setAttribute('aria-haspopup', 'listbox'); element.setAttribute('aria-expanded', 'true'); element.setAttribute('aria-controls', `${interaction.id}-slash`);
      if (active) element.setAttribute('aria-activedescendant', `${interaction.id}-slash-${active.id}`); else element.removeAttribute('aria-activedescendant');
    } else if (element.hasAttribute('aria-controls')) {
      for (const name of ['aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-activedescendant']) element.removeAttribute(name);
    }
    const editing = state.editing;
    if (editing && editing.blockId === blockId && editing.field === field && editing.seq !== appliedFocus) {
      appliedFocus = editing.seq;
      if (options.autoFocus !== false && !suppressFocus) place(editing.caret, editing.selectEnd);
    }
  };
  const offState = interaction.subscribe(applyState);
  // External changes (an agent, undo, another tab) refresh the field unless the user has unsent typing.
  const offDoc = interaction.editor.subscribe(() => { if (!destroyed && !composing && differs()) render(); });
  render(false);
  applyState();
  return {
    render: () => render(),
    focus: place,
    destroy() { destroyed = true; offs.forEach((off) => off()); offState(); offDoc(); unregister(); },
  };
}
