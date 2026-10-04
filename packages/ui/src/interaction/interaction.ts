import { createBlockId, isContainerType, reservedIds, safeUrl } from '@super-solution/editor-core';
import type { ApplyResult, Block, BlockContent, CalloutTone, Editor, EditorIssue, InlineRun, Operation, ResearchDocument, Highlight } from '@super-solution/editor-core';
import type { SlashItem, SlashLabels } from './catalog.js';
import { createSlashCatalog } from './catalog.js';
import { compatibleChartKinds, patchChartSpec } from './chart-edit.js';
import type { ChartPatch } from './chart-edit.js';
import { CLIPBOARD_MIME, parseBlocksPayload, planPaste, serializeBlocks } from './clipboard.js';
import type { ClipboardPayload } from './clipboard.js';
import { TURN_INTO_TARGETS, canTurnInto, targetOf } from './convert.js';
import type { TurnIntoTarget } from './convert.js';
import { createDrafts } from './drafts.js';
import { editTargetFor, planBackspaceAtStart, planDeleteAtEnd, planEnter } from './edit-plan.js';
import type { EditSubject } from './edit-plan.js';
import { cellField, fieldRuns, fieldText, hasRichField, isEditableType, itemField, parseField, withFieldRuns, withFieldText } from './fields.js';
import { deleteRange, highlightState, linkAt, markState, MARKS, runsLength, runsPlainText, setHighlight, setLink, splitRuns, toggleMark, wordRangeAt, concatRuns } from './inline.js';
import type { Mark } from './inline.js';
import { matchInputRule } from './input-rules.js';
import type { InputRuleMatch } from './input-rules.js';
import { blockInput, planDelete, planDuplicate, planInsert, planMove, planStepMove, planTurnInto } from './plan.js';
import type { EditTarget, IdFactory, Plan, PlanResult } from './plan.js';
import { dropTargetAt, placementOf, isNoopPlacement } from './drop.js';
import type { DropOptions, DropTarget, LayoutIndex } from './drop.js';
import { emptySelection, extendSelection, moveSelectionFocus, pruneSelection, selectAllBlocks, selectMany, selectOnly, toggleSelection } from './selection.js';
import { createShortcutRegistry, detectPlatform, formatShortcut } from './shortcuts.js';
import type { KeyEventLike, ShortcutRegistry } from './shortcuts.js';
import { filterSlashItems } from './slash.js';
import { createStore } from './state.js';
import type { InteractionState, SlashState, SyncRequest, TextSelectionState } from './state.js';
import { listSetChecked, listSetIndent, listSplice, tableAddColumn, tableAddRow, tableRemoveColumn, tableRemoveRow, tableSetAlign } from './structure.js';
import { depthOf, descendantsOf, hasChildren, rootsOf, treeOf, visibleOrder } from './tree.js';
import type { Caret, ConflictInfo, FeedbackEvent, FieldKey, InteractionActor, Placement, Platform } from './types.js';
import { localId } from '../presentation.js';
import { registerDefaultShortcuts } from './defaults.js';

export type InteractionOptions = {
  /** Who edits. Interaction is for people: the actor must be `kind: "human"`. Default `{ id: "local-human", kind: "human" }`. */
  actor?: { id: string; kind: 'human' };
  readOnly?: boolean;
  platform?: Platform;
  /** Milliseconds of typing silence before text is committed. 0 commits on every edit. Default 600. */
  commitDelayMs?: number;
  /** Mint block ids (tests, or hosts with their own scheme). Default: `block-<n>`, never reusing a live or retired id. */
  createId?: (prefix: string, reserved: Set<string>) => string;
  now?: () => string;
  /** Called when an edit lost a race with another writer. */
  onConflict?: (info: ConflictInfo) => void;
  /** Every user-visible outcome: successes with an optional Undo action, errors and conflicts. Hosts render toasts from this. */
  onFeedback?: (event: FeedbackEvent) => void;
  /** Override or disable (`null`) shortcuts by id, for example `{ 'format.bold': ['Mod+Alt+B'], 'block.duplicate': null }`. */
  shortcuts?: Readonly<Record<string, readonly string[] | null>> | false;
  slashItems?: (defaults: SlashItem[]) => SlashItem[];
  slashLabels?: SlashLabels;
  /** Links created in the editor must be https unless the host allows http as well. */
  linkSchemes?: 'https' | 'http-https';
  /** Writes text to the system clipboard. Default: `navigator.clipboard.writeText`. */
  copyText?: (text: string) => void | Promise<void>;
  /** Base URL for "copy link to block". Default: the current page without its hash. */
  linkBase?: () => string;
};
/** The live editing surface of one text field, registered by the DOM layer. */
export type EditableHandle = {
  /** Reads the DOM into the draft now. */
  sync(): void;
  selection(): { start: number; end: number } | null;
  caretLine(): { first: boolean; last: boolean };
  focus(): void;
};
export type MenuAction = { id: string; label: string; icon?: string; shortcut?: string; danger?: boolean; disabled?: boolean; current?: boolean; children?: MenuAction[] };
export type ShortcutContext = { interaction: Interaction; state: InteractionState };
export type DataTransferLike = { getData(type: string): string; setData(type: string, value: string): void };
type Selection = { start: number; end: number };

export interface Interaction {
  readonly editor: Editor;
  readonly actor: InteractionActor;
  readonly platform: Platform;
  getState(): InteractionState;
  subscribe(listener: () => void): () => void;
  setReadOnly(readOnly: boolean): void;
  setHover(id: string | null): void;
  /** Leaves the innermost thing: slash menu, prompt, menu, help, editing (selecting the block), then the block selection. Returns whether anything closed. */
  escape(): boolean;
  openHelp(): void; closeHelp(): void; toggleHelp(): void;
  openChartEditor(blockId: string): void; closeChartEditor(): void;
  readonly selection: {
    select(id: string, mode?: 'replace' | 'toggle' | 'extend'): void;
    set(ids: readonly string[]): void;
    selectAll(): void; clear(): void;
    /** Arrow keys over the selection; `extend` is Shift+Arrow. */
    move(delta: -1 | 1, extend?: boolean): void;
    ids(): string[];
  };
  readonly edit: {
    start(blockId: string, target?: { field?: FieldKey; caret?: Caret; selectEnd?: number }): boolean;
    stop(): void;
    register(blockId: string, field: FieldKey, handle: EditableHandle): () => void;
    /** The DOM reports new field text or runs after the user typed. */
    input(blockId: string, field: FieldKey, value: string | InlineRun[], meta?: { caret?: number; data?: string | null }): void;
    reportSelection(blockId: string, field: FieldKey, start: number, end: number): void;
    /** Re-render a field from the draft. The DOM layer applies it. */
    requestSync(blockId: string, field: FieldKey | null, start: number, end: number): void;
    enter(): boolean; softBreak(): boolean; backspace(): boolean; deleteForward(): boolean;
    /** Tab / Shift+Tab: indents a list item, inserts spaces in code. */
    indent(delta: 1 | -1): boolean;
    /** Arrow keys at the edge of a field move to the neighbouring item, cell or block. */
    navigate(direction: 'up' | 'down' | 'left' | 'right'): boolean;
    insertText(text: string): boolean;
    insertRuns(runs: InlineRun[]): boolean;
    caret(): { blockId: string; field: FieldKey; start: number; end: number } | null;
    flush(blockId?: string): void;
    draftContent(blockId: string): BlockContent | undefined;
    resolveConflict(blockId: string, choice: 'mine' | 'theirs'): void;
  };
  readonly format: {
    toggle(mark: Mark): boolean;
    highlight(color: Highlight | null): boolean;
    openLink(): boolean;
    applyLink(href: string): boolean;
    closePrompt(): void;
  };
  readonly commands: {
    deleteBlocks(ids?: readonly string[]): ApplyResult | null;
    duplicateBlocks(ids?: readonly string[]): ApplyResult | null;
    moveBlocks(ids: readonly string[], placement: Placement): ApplyResult | null;
    moveStep(direction: 'up' | 'down', ids?: readonly string[]): ApplyResult | null;
    turnInto(target: TurnIntoTarget, ids?: readonly string[], tone?: CalloutTone): ApplyResult | null;
    insertBlocks(contents: readonly BlockContent[], where?: { parentId?: string | null; afterId?: string | null }): ApplyResult | null;
    undo(): ApplyResult | null; redo(): ApplyResult | null;
    setChecked(blockId: string, index: number, checked: boolean): ApplyResult | null;
    setOpen(blockId: string, open: boolean): ApplyResult | null;
    table: {
      addRow(blockId: string, at?: number): ApplyResult | null; addColumn(blockId: string, at?: number): ApplyResult | null;
      removeRow(blockId: string, row: number): ApplyResult | null; removeColumn(blockId: string, column: number): ApplyResult | null;
      setAlign(blockId: string, column: number, align: 'left' | 'center' | 'right'): ApplyResult | null;
    };
    patchChart(blockId: string, patch: ChartPatch): ApplyResult | null;
    copyId(blockId: string): void; copyLink(blockId: string): void;
  };
  readonly slash: {
    open(blockId: string, field?: FieldKey, anchor?: number | null): void;
    /** The "+" button: a new empty paragraph after (or first inside) the block, with the menu open. */
    openAfter(blockId: string): void;
    setQuery(query: string): void;
    move(delta: -1 | 1): void;
    setActive(index: number): void;
    run(item?: SlashItem, input?: string): ApplyResult | null;
    submitInput(value: string): ApplyResult | null;
    close(): void;
    items(): readonly SlashItem[];
  };
  readonly drag: {
    start(ids: readonly string[], pointerType?: string): boolean;
    update(target: DropTarget | null): void;
    /** Convenience for pointer handlers: resolve the target from layout geometry and update. */
    hover(layout: LayoutIndex, x: number, y: number, options?: DropOptions): DropTarget | null;
    drop(): ApplyResult | null;
    cancel(): void;
  };
  readonly menu: {
    open(ids: readonly string[], anchorId?: string): void;
    close(): void;
    openSubmenu(submenu: 'turn-into' | null): void;
    actions(): MenuAction[];
    run(actionId: string): void;
  };
  readonly clipboard: {
    serialize(ids?: readonly string[]): ClipboardPayload | null;
    copy(data: DataTransferLike): boolean;
    cut(data: DataTransferLike): boolean;
    paste(data: DataTransferLike): boolean;
    copyToSystem(ids?: readonly string[]): Promise<boolean>;
  };
  readonly shortcuts: ShortcutRegistry<ShortcutContext> & { handleKeyDown(event: KeyEventLike): boolean };
  destroy(): void;
}

const HUMAN_DEFAULT = { id: 'local-human', kind: 'human' as const };
const clampCaret = (caret: Caret, length: number): number => caret === 'start' ? 0 : caret === 'end' ? length : Math.max(0, Math.min(length, caret));

export function createInteraction(editor: Editor, options: InteractionOptions = {}): Interaction {
  const actor = options.actor ?? HUMAN_DEFAULT;
  if (!actor || actor.kind !== 'human' || typeof actor.id !== 'string' || !actor.id) throw new TypeError('createInteraction requires a human actor ({ id, kind: "human" }); agents edit through the API, MCP or CLI transports.');
  const platform = options.platform ?? detectPlatform();
  const catalog = options.slashItems ? options.slashItems(createSlashCatalog(options.slashLabels)) : createSlashCatalog(options.slashLabels);
  const store = createStore<InteractionState>({
    readOnly: !!options.readOnly, selection: emptySelection, editing: null, hover: null, slash: null, menu: null, help: false,
    drag: null, textSelection: null, conflicts: Object.freeze({}), prompt: null, chartEditor: null, sync: null,
  });
  const handles = new Map<string, EditableHandle>();
  const handleKey = (blockId: string, field: FieldKey): string => `${blockId}\u0000${field}`;
  let seq = 0, syncSeq = 0, destroyed = false;
  let lastRule: { blockId: string; restore: BlockContent; caret: number } | null = null;
  const now = (): string => options.now?.() ?? new Date().toISOString();
  const doc = (): ResearchDocument => editor.getSnapshot();
  const blockOf = (id: string): Block | undefined => treeOf(doc()).byId.get(id);
  const makeIds = (): IdFactory => {
    const reserved = reservedIds(doc());
    return (prefix) => options.createId ? options.createId(prefix, reserved) : createBlockId(prefix, reserved);
  };

  // ---- feedback and applying -------------------------------------------------------------------------------------
  const notify = (event: FeedbackEvent): void => { try { options.onFeedback?.(event); } catch { /* Host callbacks must not break editing. */ } };
  const describe = (issues: readonly EditorIssue[]): string => {
    const first = issues[0];
    if (!first) return 'The change could not be applied.';
    return first.hint ? `${first.message} ${first.hint}` : first.message;
  };
  function reportFailure(command: string, result: Extract<ApplyResult, { ok: false }>): void {
    const conflict = result.issues.find((issue) => issue.code === 'conflict');
    if (conflict) {
      const info: ConflictInfo = { command, message: 'The document changed while you were working, so this change was not applied. Nothing was lost; try again.', issues: result.issues, ...(conflict.blockId ? { blockId: conflict.blockId } : {}) };
      try { options.onConflict?.(info); } catch { /* ignore */ }
      notify({ kind: 'conflict', message: info.message, ...(conflict.blockId ? { blockIds: [conflict.blockId] } : {}) });
    } else notify({ kind: 'error', message: describe(result.issues) });
  }
  function run(command: string, operations: Operation[]): ApplyResult {
    const result = editor.apply({ id: localId('human'), actor, baseRevision: doc().revision, operations });
    if (!result.ok) reportFailure(command, result);
    return result;
  }
  const writable = (): boolean => {
    if (!store.get().readOnly && !destroyed) return true;
    notify({ kind: 'info', message: 'This document is read-only.' });
    return false;
  };
  const drafts = createDrafts({
    editor, delayMs: options.commitDelayMs ?? 600,
    commit: (blockId, content, expectedVersion) => run('commit', [{ type: 'updateBlock', blockId, expectedVersion, content }]),
    onConflict: (info) => { try { options.onConflict?.(info); } catch { /* ignore */ } },
    onFeedback: notify,
    onConflictsChanged: (conflicts) => store.set({ conflicts }),
    requestResync: (blockId) => requestSync(blockId, null, 0, 0),
  });

  // ---- selection --------------------------------------------------------------------------------------------------
  const order = (): string[] => visibleOrder(doc()).map((block) => block.id);
  function setSelection(selection: InteractionState['selection']): void {
    if (selection.ids.length && store.get().editing) { drafts.flush(store.get().editing!.blockId); store.set({ selection, editing: null, slash: null, textSelection: null }); }
    else store.set({ selection });
  }
  const selection: Interaction['selection'] = {
    select(id, mode = 'replace') {
      if (!blockOf(id)) return;
      const current = store.get().selection, all = order();
      setSelection(mode === 'toggle' ? toggleSelection(current, all, id) : mode === 'extend' ? extendSelection(current, all, id) : selectOnly(id));
    },
    set(ids) { setSelection(selectMany(order(), ids.filter((id) => !!blockOf(id)))); },
    selectAll() { setSelection(selectAllBlocks(order())); },
    clear() { store.set({ selection: emptySelection }); },
    move(delta, extend = false) { store.set({ selection: moveSelectionFocus(store.get().selection, order(), delta, extend) }); },
    ids: () => [...store.get().selection.ids],
  };
  const targetIds = (ids?: readonly string[]): string[] => {
    if (ids) return [...ids];
    const state = store.get();
    return state.selection.ids.length ? [...state.selection.ids] : state.editing ? [state.editing.blockId] : [];
  };

  // ---- plan execution ---------------------------------------------------------------------------------------------
  /** Runs a plan, then applies its follow-up (selection, caret). `consumed` drafts are replaced by the plan's own content. */
  function execute(result: PlanResult, command: string, consumed: readonly string[] = [], extra: { undo?: boolean; followFocus?: boolean } = {}): ApplyResult | null {
    if (!result) return null;
    if ('error' in result) { notify({ kind: 'error', message: result.error }); return null; }
    const plan: Plan = result;
    const outcome = drafts.guarded(consumed, () => run(command, plan.operations));
    if (!outcome.ok) return outcome;
    const message = plan.summary;
    notify({ kind: 'success', message, ...(extra.undo ? { action: { label: 'Undo', run: () => { commands.undo(); } } } : {}) });
    lastRule = null;
    follow(plan, extra.followFocus !== false);
    return outcome;
  }
  function follow(plan: Plan, followFocus: boolean): void {
    if (plan.edit) { selection.clear(); api.edit.start(plan.edit.blockId, { ...(plan.edit.field ? { field: plan.edit.field } : {}), ...(plan.edit.caret !== undefined ? { caret: plan.edit.caret } : {}) }); return; }
    if (plan.select) { store.set({ selection: selectMany(order(), plan.select), editing: null, slash: null }); return; }
    if (plan.focus !== undefined && followFocus) {
      const target = plan.focus ? blockOf(plan.focus) : undefined;
      const edit = target ? editTargetFor(target, 'end') : null;
      if (edit) api.edit.start(edit.blockId, { ...(edit.field ? { field: edit.field } : {}), caret: 'end' });
      else if (target) store.set({ selection: selectOnly(target.id), editing: null }); else store.set({ editing: null });
    }
  }
  const flushAll = (): void => { drafts.flushAll(); };

  // ---- commands ---------------------------------------------------------------------------------------------------
  const immediate = (blockId: string, command: string, produce: (content: BlockContent) => BlockContent | null): ApplyResult | null => {
    if (!writable()) return null;
    const result = drafts.editNow(blockId, produce);
    if (result && !result.ok) reportFailure(command, result);
    return result;
  };
  const commands: Interaction['commands'] = {
    deleteBlocks(ids) {
      if (!writable()) return null;
      const chosen = targetIds(ids), wasEditing = !!store.get().editing; flushAll();
      // Deleting selected blocks leaves the keyboard alone; deleting the block you are typing in moves the caret to its neighbour.
      return execute(planDelete(doc(), chosen), 'deleteBlocks', [], { undo: true, followFocus: wasEditing });
    },
    duplicateBlocks(ids) {
      if (!writable()) return null;
      const chosen = targetIds(ids); flushAll();
      return execute(planDuplicate(doc(), chosen, makeIds()), 'duplicateBlocks');
    },
    moveBlocks(ids, placement) {
      if (!writable()) return null;
      flushAll();
      return execute(planMove(doc(), ids, placement), 'moveBlocks');
    },
    moveStep(direction, ids) {
      if (!writable()) return null;
      const editing = store.get().editing, chosen = targetIds(ids); flushAll();
      const result = execute(planStepMove(doc(), chosen, direction), 'moveBlocks');
      // Moving a block you are typing in keeps the caret there.
      if (result?.ok && editing) api.edit.start(editing.blockId, { field: editing.field, caret: editing.caret });
      return result;
    },
    turnInto(target, ids, tone) {
      if (!writable()) return null;
      const editing = store.get().editing, caret = editing ? api.edit.caret() : null, chosen = targetIds(ids); flushAll();
      const result = execute(planTurnInto(doc(), chosen, target, makeIds(), tone), 'turnInto');
      if (result?.ok && editing && chosen.length === 1 && chosen[0] === editing.blockId) {
        const block = blockOf(editing.blockId);
        const entry = block ? editTargetFor(block, 'start') : null;
        if (block && entry) api.edit.start(block.id, { field: entry.field ?? 'main', caret: caret ? caret.start : 'end' });
      }
      return result;
    },
    insertBlocks(contents, where = {}) {
      if (!writable() || !contents.length) return null;
      flushAll();
      const parentId = where.parentId ?? null;
      const siblings = treeOf(doc()).children.get(parentId) ?? [];
      const afterId = where.afterId === undefined ? siblings[siblings.length - 1]?.id ?? null : where.afterId;
      return execute(planInsert(doc(), parentId, afterId, contents, makeIds()), 'insertBlocks');
    },
    undo() { return history('undo'); },
    redo() { return history('redo'); },
    setChecked: (blockId, index, checked) => immediate(blockId, 'setChecked', (content) => content.type === 'list' && content.style === 'todo' && index >= 0 && index < content.items.length ? listSetChecked(content, index, checked) : null),
    setOpen: (blockId, open) => immediate(blockId, 'setOpen', (content) => content.type === 'toggle' ? { ...content, open } : null),
    table: {
      addRow(blockId, at) { const result = immediate(blockId, 'tableAddRow', (content) => content.type === 'table' ? tableAddRow(content, at) : null); if (result?.ok) { const block = blockOf(blockId); if (block?.content.type === 'table') api.edit.start(blockId, { field: cellField(at ?? block.content.rows.length - 1, 0), caret: 'start' }); } return result; },
      addColumn(blockId, at) { const result = immediate(blockId, 'tableAddColumn', (content) => content.type === 'table' ? tableAddColumn(content, at) : null); if (result?.ok) { const block = blockOf(blockId); if (block?.content.type === 'table') api.edit.start(blockId, { field: cellField(-1, at ?? block.content.columns.length - 1), caret: 'end' }); } return result; },
      removeRow: (blockId, row) => immediate(blockId, 'tableRemoveRow', (content) => content.type === 'table' ? tableRemoveRow(content, row) : null),
      removeColumn: (blockId, column) => immediate(blockId, 'tableRemoveColumn', (content) => content.type === 'table' ? tableRemoveColumn(content, column) : null),
      setAlign: (blockId, column, align) => immediate(blockId, 'tableAlign', (content) => content.type === 'table' ? tableSetAlign(content, column, align) : null),
    },
    patchChart: (blockId, patch) => immediate(blockId, 'patchChart', (content) => content.type === 'chart' ? { ...content, spec: patchChartSpec(content.spec, patch) } : null),
    copyId(blockId) { void writeClipboard(blockId).then(() => notify({ kind: 'success', message: 'Block ID copied', blockIds: [blockId] })); },
    copyLink(blockId) {
      const base = options.linkBase?.() ?? (globalThis as { location?: { href?: string } }).location?.href?.split('#')[0] ?? '';
      void writeClipboard(`${base}#${blockId}`).then(() => notify({ kind: 'success', message: 'Link to block copied', blockIds: [blockId] }));
    },
  };
  async function writeClipboard(text: string): Promise<void> {
    try {
      if (options.copyText) await options.copyText(text);
      else await (globalThis as { navigator?: { clipboard?: { writeText(value: string): Promise<void> } } }).navigator?.clipboard?.writeText(text);
    } catch { notify({ kind: 'error', message: 'Could not write to the clipboard.' }); }
  }
  function history(kind: 'undo' | 'redo'): ApplyResult | null {
    if (!writable()) return null;
    flushAll();
    const result = kind === 'undo' ? editor.undo(actor, doc().revision) : editor.redo(actor, doc().revision);
    if (!result.ok) {
      if (result.issues.some((issue) => issue.code === 'history')) notify({ kind: 'info', message: kind === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.' });
      else reportFailure(kind, result);
    }
    return result;
  }

  // ---- editing -----------------------------------------------------------------------------------------------------
  function requestSync(blockId: string, field: FieldKey | null, start: number, end: number): void {
    const request: SyncRequest = { seq: ++syncSeq, blockId, field, start, end };
    store.set({ sync: request });
  }
  function readCaret(): { blockId: string; field: FieldKey; start: number; end: number } | null {
    const editing = store.get().editing;
    if (!editing) return null;
    const handle = handles.get(handleKey(editing.blockId, editing.field));
    handle?.sync();
    const content = drafts.contentOf(editing.blockId);
    if (!content) return null;
    const live = handle?.selection();
    if (live) return { blockId: editing.blockId, field: editing.field, start: live.start, end: live.end };
    const reported = store.get().textSelection;
    if (reported && reported.blockId === editing.blockId && reported.field === editing.field) return { blockId: editing.blockId, field: editing.field, start: reported.start, end: reported.end };
    const length = fieldText(content, editing.field).length, caret = clampCaret(editing.caret, length);
    return { blockId: editing.blockId, field: editing.field, start: caret, end: editing.selectEnd === undefined ? caret : clampCaret(editing.selectEnd, length) };
  }
  function subject(): EditSubject | null {
    const caret = readCaret();
    if (!caret) return null;
    const content = drafts.contentOf(caret.blockId), version = drafts.versionOf(caret.blockId);
    return content && version !== undefined ? { ...caret, content, version } : null;
  }
  const others = (blockId: string): void => { for (const id of drafts.dirtyIds()) if (id !== blockId) drafts.flush(id); };
  function reportSelection(blockId: string, field: FieldKey, start: number, end: number): void {
    const content = drafts.contentOf(blockId);
    if (!content) return;
    const runs = fieldRuns(content, field);
    const marks = Object.fromEntries(MARKS.map((mark) => [mark, runs ? markState(runs, start, end, mark) : 'none'])) as TextSelectionState['marks'];
    const link = runs ? linkAt(runs, start)?.href ?? null : null;
    const highlight = runs ? highlightState(runs, start, end) : null;
    if (lastRule && (start !== 0 || end !== 0)) lastRule = null;
    const previous = store.get().textSelection;
    if (previous && previous.blockId === blockId && previous.field === field && previous.start === start && previous.end === end && previous.link === link && previous.highlight === highlight && MARKS.every((mark) => previous.marks[mark] === marks[mark])) return;
    store.set({ textSelection: { blockId, field, start, end, marks, link, highlight } });
  }
  const edit: Interaction['edit'] = {
    start(blockId, target = {}) {
      if (!writable()) return false;
      const block = blockOf(blockId);
      if (!block || !isEditableType(block.content.type)) return false;
      const previous = store.get().editing;
      if (previous && previous.blockId !== blockId) { drafts.flush(previous.blockId); lastRule = null; }
      const first = editTargetFor(block, target.caret === 'end' ? 'end' : 'start');
      const field = target.field ?? first?.field ?? 'main';
      store.set({ editing: { blockId, field, caret: target.caret ?? 'end', ...(target.selectEnd === undefined ? {} : { selectEnd: target.selectEnd }), seq: ++seq },
        selection: emptySelection, slash: previous?.blockId === blockId ? store.get().slash : null, menu: null, textSelection: null });
      return true;
    },
    stop() {
      const editing = store.get().editing;
      if (editing) drafts.flush(editing.blockId);
      store.set({ editing: null, slash: null, textSelection: null });
    },
    register(blockId, field, handle) { const key = handleKey(blockId, field); handles.set(key, handle); return () => { if (handles.get(key) === handle) handles.delete(key); }; },
    input(blockId, field, value, meta = {}) {
      if (store.get().readOnly) return;
      lastRule = null;
      const ok = drafts.edit(blockId, (content) => typeof value === 'string' ? withFieldText(content, field, value) : withFieldRuns(content, field, value));
      if (!ok) return;
      const caret = meta.caret;
      if (caret !== undefined && field === 'main') {
        const content = drafts.contentOf(blockId);
        if (content?.type === 'paragraph') {
          const rule = matchInputRule(content, caret, meta.data === ' ' ? 'space' : 'input');
          if (rule) { applyInputRule(blockId, rule, caret); return; }
        }
        updateSlashFromText(blockId, field, caret, meta.data ?? null);
      }
    },
    reportSelection,
    requestSync,
    enter() {
      if (!writable()) return false;
      const current = subject();
      if (!current) return false;
      if (current.content.type === 'code') return edit.insertText('\n');
      if (current.content.type === 'table') return edit.navigate('down');
      const rule = matchInputRule(current.content, current.start, 'enter');
      if (rule && current.start === current.end) { applyInputRule(current.blockId, rule, current.start); return true; }
      others(current.blockId);
      execute(planEnter(doc(), current, makeIds()), 'enter', [current.blockId]);
      return true;
    },
    softBreak() {
      const current = subject();
      if (!current) return false;
      if (hasRichField(current.content, current.field) || current.content.type === 'code') return edit.insertText('\n');
      return true;
    },
    backspace() {
      if (!writable()) return false;
      const current = subject();
      if (!current || current.start !== 0 || current.end !== 0) return false;
      if (lastRule && lastRule.blockId === current.blockId) {
        const undo = lastRule; lastRule = null;
        const operations: Operation[] = [{ type: 'updateBlock', blockId: current.blockId, expectedVersion: current.version, content: undo.restore }];
        const result = drafts.guarded([current.blockId], () => run('inputRule', operations));
        if (result.ok) api.edit.start(current.blockId, { field: 'main', caret: undo.caret });
        return true;
      }
      others(current.blockId);
      const plan = planBackspaceAtStart(doc(), current, makeIds());
      if (!plan) return false;
      execute(plan, 'backspace', [current.blockId]);
      return true;
    },
    deleteForward() {
      if (!writable()) return false;
      const current = subject();
      if (!current || current.start !== current.end || current.field !== 'main' || current.content.type !== 'paragraph' || current.end !== runsLength(current.content.runs)) return false;
      others(current.blockId);
      const plan = planDeleteAtEnd(doc(), current);
      if (!plan) return false;
      execute(plan, 'delete', [current.blockId]);
      return true;
    },
    indent(delta) {
      if (!writable()) return false;
      const current = subject();
      if (!current) return false;
      if (current.content.type === 'code') {
        if (delta > 0) return edit.insertText('  ');
        return false;
      }
      const field = parseField(current.field);
      if (current.content.type !== 'list' || field.kind !== 'item') return false;
      const next = listSetIndent(current.content, field.index, delta);
      if (!next) return true;
      drafts.edit(current.blockId, () => next);
      requestSync(current.blockId, null, current.start, current.end);
      return true;
    },
    navigate(direction) {
      const current = readCaret();
      if (!current) return false;
      const block = blockOf(current.blockId), content = drafts.contentOf(current.blockId);
      if (!block || !content) return false;
      const length = fieldText(content, current.field).length, collapsed = current.start === current.end;
      const handle = handles.get(handleKey(current.blockId, current.field)), line = handle?.caretLine() ?? { first: true, last: true };
      const atStart = collapsed && current.start === 0, atEnd = collapsed && current.end === length;
      const edge = direction === 'up' ? collapsed && line.first : direction === 'down' ? collapsed && line.last : direction === 'left' ? atStart : atEnd;
      if (!edge) return false;
      const forward = direction === 'down' || direction === 'right';
      const field = parseField(current.field);
      if (content.type === 'list' && field.kind === 'item') {
        const next = field.index + (forward ? 1 : -1);
        if (next >= 0 && next < content.items.length) { api.edit.start(current.blockId, { field: itemField(next), caret: forward ? 'start' : 'end' }); return true; }
      }
      if (content.type === 'table' && field.kind === 'cell') {
        const columns = content.columns.length, rows = content.rows.length;
        let row = field.row, col = field.col;
        if (direction === 'down') row++; else if (direction === 'up') row--;
        else if (direction === 'right') { col++; if (col >= columns) { col = 0; row++; } } else { col--; if (col < 0) { col = columns - 1; row--; } }
        if (row >= -1 && row < rows && col >= 0 && col < columns) { api.edit.start(current.blockId, { field: cellField(row, col), caret: forward ? 'start' : 'end' }); return true; }
      }
      const list = visibleOrder(doc()), at = list.findIndex((entry) => entry.id === current.blockId), neighbour = list[at + (forward ? 1 : -1)];
      if (!neighbour) return false;
      const target = editTargetFor(neighbour, forward ? 'start' : 'end');
      if (target) api.edit.start(neighbour.id, { ...(target.field ? { field: target.field } : {}), caret: forward ? 'start' : 'end' });
      else { drafts.flush(current.blockId); store.set({ selection: selectOnly(neighbour.id), editing: null, slash: null, textSelection: null }); }
      return true;
    },
    insertText(text) {
      if (!writable()) return false;
      const current = readCaret();
      if (!current) return false;
      const content = drafts.contentOf(current.blockId);
      if (!content) return false;
      const runs = fieldRuns(content, current.field);
      const caret = current.start + text.length;
      if (runs) {
        const [before, after] = splitRuns(deleteRange(runs, current.start, current.end), current.start);
        const inheritFrom = [...before].reverse().find((run) => run.text !== '') ?? after.find((run) => run.text !== '');
        const { text: _t, citationId: _c, href: _h, ...format } = inheritFrom ?? { text: '' };
        drafts.edit(current.blockId, (c) => withFieldRuns(c, current.field, concatRuns(concatRuns(before, [{ ...format, text }]), after)));
      } else {
        const value = fieldText(content, current.field);
        drafts.edit(current.blockId, (c) => withFieldText(c, current.field, value.slice(0, current.start) + text + value.slice(current.end)));
      }
      requestSync(current.blockId, current.field, caret, caret);
      return true;
    },
    insertRuns(inserted) {
      if (!writable()) return false;
      const current = readCaret();
      if (!current) return false;
      const content = drafts.contentOf(current.blockId), runs = content ? fieldRuns(content, current.field) : null;
      if (!content || !runs) return edit.insertText(runsPlainText(inserted));
      const [before, after] = splitRuns(deleteRange(runs, current.start, current.end), current.start);
      const caret = current.start + runsLength(inserted);
      drafts.edit(current.blockId, (c) => withFieldRuns(c, current.field, concatRuns(concatRuns(before, inserted), after)));
      requestSync(current.blockId, current.field, caret, caret);
      return true;
    },
    caret: readCaret,
    flush(blockId) { if (blockId) drafts.flush(blockId); else flushAll(); },
    draftContent: (blockId) => drafts.contentOf(blockId),
    resolveConflict(blockId, choice) { const result = drafts.resolve(blockId, choice); if (result && !result.ok) reportFailure('commit', result); },
  };

  function applyInputRule(blockId: string, rule: InputRuleMatch, caret: number): void {
    const before = drafts.contentOf(blockId), version = drafts.versionOf(blockId);
    if (!before || version === undefined || !writable()) return;
    const operations: Operation[] = [{ type: 'updateBlock', blockId, expectedVersion: version, content: rule.content }];
    let follower: string | null = null;
    if (rule.followWithParagraph) {
      const ids = makeIds(), paragraph = blockInput(ids('block'), blockOf(blockId)?.parentId ?? null, { type: 'paragraph', runs: [] });
      follower = paragraph.id;
      operations.push({ type: 'insertBlocks', blocks: [paragraph], afterId: blockId });
    }
    const result = drafts.guarded([blockId], () => run('inputRule', operations));
    if (!result.ok) return;
    lastRule = { blockId, restore: before, caret };
    store.set({ slash: null });
    if (follower) { api.edit.start(follower, { field: 'main', caret: 'start' }); lastRule = null; return; }
    const entry = editTargetFor({ id: blockId, content: rule.content }, 'start');
    if (entry) api.edit.start(blockId, { field: entry.field ?? 'main', caret: 0 });
    else store.set({ editing: null });
  }

  // ---- inline formatting -------------------------------------------------------------------------------------------
  /** Selected range, widened to the word under a collapsed caret, for the rich field being edited. */
  function formatRange(): { blockId: string; field: FieldKey; runs: InlineRun[]; start: number; end: number; caretStart: number; caretEnd: number } | null {
    const caret = readCaret();
    if (!caret) return null;
    const content = drafts.contentOf(caret.blockId), runs = content ? fieldRuns(content, caret.field) : null;
    if (!runs) return null;
    let { start, end } = caret;
    if (start === end) { const word = wordRangeAt(runsPlainText(runs), start); if (!word) return null; start = word.start; end = word.end; }
    return { blockId: caret.blockId, field: caret.field, runs, start, end, caretStart: caret.start, caretEnd: caret.end };
  }
  const format: Interaction['format'] = {
    toggle(mark) {
      if (!writable()) return false;
      const range = formatRange();
      if (!range) return false;
      const next = toggleMark(range.runs, range.start, range.end, mark);
      drafts.edit(range.blockId, (content) => withFieldRuns(content, range.field, next));
      requestSync(range.blockId, range.field, range.caretStart, range.caretEnd);
      return true;
    },
    highlight(color) {
      if (!writable()) return false;
      const range = formatRange();
      if (!range) return false;
      const next = setHighlight(range.runs, range.start, range.end, color);
      drafts.edit(range.blockId, (content) => withFieldRuns(content, range.field, next));
      requestSync(range.blockId, range.field, range.caretStart, range.caretEnd);
      return true;
    },
    openLink() {
      if (!writable()) return false;
      const range = formatRange();
      if (!range) return false;
      const existing = linkAt(range.runs, range.caretStart);
      const start = existing && range.caretStart === range.caretEnd ? existing.start : range.start, end = existing && range.caretStart === range.caretEnd ? existing.end : range.end;
      store.set({ prompt: { kind: 'link', blockId: range.blockId, field: range.field, start, end, href: existing?.href ?? '', error: null } });
      return true;
    },
    applyLink(input) {
      const prompt = store.get().prompt;
      if (!prompt || prompt.kind !== 'link') return false;
      const content = drafts.contentOf(prompt.blockId), runs = content ? fieldRuns(content, prompt.field) : null;
      if (!runs) { store.set({ prompt: null }); return false; }
      const text = input.trim();
      let href: string | null = null;
      if (text) {
        const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
        href = safeUrl(candidate);
        if (!href || (options.linkSchemes !== 'http-https' && !href.startsWith('https:'))) {
          store.set({ prompt: { ...prompt, href: input, error: options.linkSchemes === 'http-https' ? 'Enter a full web address, for example https://example.com.' : 'Links must use https, for example https://example.com.' } });
          return false;
        }
      }
      const next = setLink(runs, prompt.start, prompt.end, href);
      drafts.edit(prompt.blockId, (c) => withFieldRuns(c, prompt.field, next));
      store.set({ prompt: null });
      requestSync(prompt.blockId, prompt.field, prompt.end, prompt.end);
      return true;
    },
    closePrompt() {
      const prompt = store.get().prompt;
      store.set({ prompt: null });
      if (prompt && prompt.kind === 'link') requestSync(prompt.blockId, null, prompt.start, prompt.end);
    },
  };

  // ---- slash menu --------------------------------------------------------------------------------------------------
  const slashItems = (query: string): readonly SlashItem[] => filterSlashItems(catalog, query);
  function setSlash(next: SlashState | null): void { store.set({ slash: next }); }
  function updateSlashFromText(blockId: string, field: FieldKey, caret: number, data: string | null): void {
    const content = drafts.contentOf(blockId), state = store.get().slash;
    if (!content || content.type !== 'paragraph') return;
    const text = fieldText(content, field);
    if (state && state.blockId === blockId) {
      let query: string;
      if (state.anchor === null) query = text;
      else {
        if (text[state.anchor] !== '/' || caret <= state.anchor) { setSlash(null); return; }
        query = text.slice(state.anchor + 1, caret);
      }
      const items = slashItems(query);
      if ((state.anchor !== null && /\s\s|^\s/.test(query) && !items.length) || (!items.length && query.length > 12)) { setSlash(null); return; }
      setSlash({ ...state, query, items, activeIndex: 0 });
      return;
    }
    if (data === '/' && caret >= 1 && text[caret - 1] === '/' && (caret === 1 || /\s/.test(text[caret - 2] ?? ''))) api.slash.open(blockId, field, caret - 1);
  }
  const slash: Interaction['slash'] = {
    open(blockId, field = 'main', anchor = null) {
      if (!writable()) return;
      setSlash({ blockId, field, anchor, query: '', activeIndex: 0, items: slashItems(''), insertAfter: false });
    },
    openAfter(blockId) {
      if (!writable()) return;
      flushAll();
      const block = blockOf(blockId);
      if (!block) return;
      const empty = block.content.type === 'paragraph' && runsPlainText(block.content.runs) === '' && !hasChildren(doc(), blockId);
      if (empty) { api.edit.start(blockId, { field: 'main', caret: 'start' }); setSlash({ blockId, field: 'main', anchor: null, query: '', activeIndex: 0, items: slashItems(''), insertAfter: true }); return; }
      const container = isContainerType(block.content.type);
      const plan = container ? planInsert(doc(), blockId, null, [{ type: 'paragraph', runs: [] }], makeIds()) : planInsert(doc(), block.parentId, blockId, [{ type: 'paragraph', runs: [] }], makeIds());
      if ('error' in plan) { notify({ kind: 'error', message: plan.error }); return; }
      const result = run('insert', plan.operations);
      if (!result.ok) return;
      const id = plan.select![0]!;
      api.edit.start(id, { field: 'main', caret: 'start' });
      setSlash({ blockId: id, field: 'main', anchor: null, query: '', activeIndex: 0, items: slashItems(''), insertAfter: true });
    },
    setQuery(query) {
      const state = store.get().slash;
      if (!state) return;
      setSlash({ ...state, query, items: slashItems(query), activeIndex: 0 });
    },
    move(delta) {
      const state = store.get().slash;
      if (!state || !state.items.length) return;
      setSlash({ ...state, activeIndex: (state.activeIndex + delta + state.items.length) % state.items.length });
    },
    setActive(index) { const state = store.get().slash; if (state && index >= 0 && index < state.items.length) setSlash({ ...state, activeIndex: index }); },
    run(chosen, input) {
      const state = store.get().slash;
      if (!state || !writable()) return null;
      const item = chosen ?? state.items[state.activeIndex];
      if (!item) return null;
      return runSlashItem(state, item, input);
    },
    submitInput(value) {
      const prompt = store.get().prompt;
      if (!prompt || prompt.kind !== 'url') return null;
      const url = safeUrl(value.trim(), { httpsOnly: true });
      if (!url) { store.set({ prompt: { ...prompt, error: 'Enter a full https address, for example https://example.com/page.' } }); return null; }
      store.set({ prompt: null });
      return runSlashItem({ blockId: prompt.blockId, field: 'main', anchor: null, query: '', activeIndex: 0, items: [], insertAfter: true }, prompt.item, url, true);
    },
    close() { setSlash(null); },
    items: () => store.get().slash?.items ?? catalog,
  };
  function runSlashItem(state: SlashState, item: SlashItem, input: string | undefined, skipStrip = false): ApplyResult | null {
    const block = blockOf(state.blockId), content = drafts.contentOf(state.blockId), version = drafts.versionOf(state.blockId);
    if (!block || !content || version === undefined) { setSlash(null); return null; }
    // Remove the typed "/query" (or, when opened by "+", whatever was typed) from the paragraph first.
    let stripped = content;
    if (content.type === 'paragraph' && !skipStrip) {
      const text = runsPlainText(content.runs);
      const from = state.anchor ?? 0, to = state.anchor === null ? text.length : Math.min(text.length, state.anchor + 1 + state.query.length);
      stripped = { ...content, runs: deleteRange(content.runs, from, to) };
    }
    if (item.input && input === undefined) {
      drafts.edit(state.blockId, () => stripped);
      setSlash(null);
      store.set({ prompt: { kind: 'url', item, blockId: state.blockId, error: null } });
      return null;
    }
    const created = item.create({ now: now(), ...(input === undefined ? {} : { input }) });
    const empty = stripped.type === 'paragraph' && runsPlainText(stripped.runs) === '' && !stripped.runs.some((run) => run.citationId !== undefined);
    const ids = makeIds(), operations: Operation[] = [];
    let focusId = state.blockId;
    if (empty && stripped.type === 'paragraph') {
      operations.push({ type: 'updateBlock', blockId: state.blockId, expectedVersion: version, content: created });
    } else {
      if (stripped !== content) operations.push({ type: 'updateBlock', blockId: state.blockId, expectedVersion: version, content: stripped });
      const added = blockInput(ids('block'), block.parentId, created);
      operations.push({ type: 'insertBlocks', blocks: [added], afterId: state.blockId });
      focusId = added.id;
    }
    // Blocks without text need a paragraph after them so typing can continue.
    let trailing: string | null = null;
    if (!isEditableType(created.type)) {
      const siblings = treeOf(doc()).children.get(block.parentId) ?? [], at = siblings.findIndex((entry) => entry.id === state.blockId);
      const next = siblings[at + 1];
      if (!next || !isEditableType(next.content.type)) {
        const paragraph = blockInput(ids('block'), block.parentId, { type: 'paragraph', runs: [] });
        trailing = paragraph.id;
        operations.push({ type: 'insertBlocks', blocks: [paragraph], afterId: focusId });
      }
    }
    const result = drafts.guarded([state.blockId], () => run('slash', operations));
    setSlash(null);
    if (!result.ok) return result;
    notify({ kind: 'success', message: `Inserted ${item.label.toLowerCase()}`, blockIds: [focusId] });
    if (trailing) api.edit.start(trailing, { field: 'main', caret: 'start' });
    else { const entry = editTargetFor({ id: focusId, content: created }, 'start'); if (entry) api.edit.start(focusId, { field: entry.field ?? 'main', caret: 'start' }); }
    return result;
  }

  // ---- drag and drop -----------------------------------------------------------------------------------------------
  const drag: Interaction['drag'] = {
    start(ids, pointerType = 'mouse') {
      if (!writable()) return false;
      const roots = rootsOf(doc(), ids);
      if (!roots.length) return false;
      flushAll();
      store.set({ drag: { ids: roots, pointerType, target: null, placement: null }, selection: selectMany(order(), roots), editing: null, menu: null, slash: null });
      return true;
    },
    update(target) {
      const state = store.get().drag;
      if (!state) return;
      const placement = target ? placementOf(doc(), target, state.ids) : null;
      const valid = placement && !isNoopPlacement(doc(), state.ids, placement) ? placement : null;
      store.set({ drag: { ...state, target: valid ? target : null, placement: valid } });
    },
    hover(layout, x, y, dropOptions) {
      const state = store.get().drag;
      if (!state) return null;
      const target = dropTargetAt(layout, doc(), state.ids, x, y, dropOptions);
      drag.update(target);
      return store.get().drag?.target ?? null;
    },
    drop() {
      const state = store.get().drag;
      if (!state) return null;
      store.set({ drag: null });
      if (!state.placement) return null;
      return execute(planMove(doc(), state.ids, state.placement), 'moveBlocks');
    },
    cancel() { if (store.get().drag) store.set({ drag: null }); },
  };

  // ---- block menu --------------------------------------------------------------------------------------------------
  const shortcutLabel = (id: string): string | undefined => { const keys = registry.keysFor(id)[0]; return keys ? formatShortcut(keys, platform) : undefined; };
  const menu: Interaction['menu'] = {
    open(ids, anchorId) {
      const roots = rootsOf(doc(), ids);
      if (!roots.length) return;
      store.set({ menu: { blockIds: roots, anchorId: anchorId ?? roots[0]!, submenu: null }, selection: selectMany(order(), roots), editing: null, slash: null });
    },
    close() { if (store.get().menu) store.set({ menu: null }); },
    openSubmenu(submenu) { const state = store.get().menu; if (state) store.set({ menu: { ...state, submenu } }); },
    actions() {
      const state = store.get().menu;
      const ids = state ? state.blockIds : store.get().selection.ids, d = doc(), blocks = ids.map((id) => treeOf(d).byId.get(id)).filter((block): block is Block => !!block);
      if (!blocks.length) return [];
      const single = blocks.length === 1 ? blocks[0]! : null, readOnly = store.get().readOnly;
      const turn = TURN_INTO_TARGETS.map((entry) => ({ entry, usable: blocks.every((block) => targetOf(block.content) === entry.id || canTurnInto(block.content, entry.id, hasChildren(d, block.id))) && blocks.some((block) => targetOf(block.content) !== entry.id) }));
      const current = blocks.length ? targetOf(blocks[0]!.content) : null;
      const actions: MenuAction[] = [];
      if (single?.content.type === 'chart') actions.push({ id: 'edit-chart', label: 'Edit chart', icon: '◧', disabled: readOnly });
      const turnChildren = turn.filter((entry) => entry.usable || entry.entry.id === current).map(({ entry }) => ({ id: `turn:${entry.id}`, label: entry.label, icon: entry.icon, current: entry.id === current, disabled: readOnly || entry.id === current }));
      if (turnChildren.some((child) => !child.disabled)) actions.push({ id: 'turn-into', label: 'Turn into', icon: '↻', children: turnChildren, disabled: readOnly });
      const duplicateShortcut = shortcutLabel('block.duplicate'), upShortcut = shortcutLabel('block.moveUp'), downShortcut = shortcutLabel('block.moveDown');
      actions.push({ id: 'duplicate', label: 'Duplicate', icon: '⧉', disabled: readOnly, ...(duplicateShortcut ? { shortcut: duplicateShortcut } : {}) });
      if (single) actions.push({ id: 'copy-id', label: 'Copy block ID', icon: '#' }, { id: 'copy-link', label: 'Copy link to block', icon: '⚓' });
      actions.push({ id: 'copy', label: blocks.length > 1 ? 'Copy as markdown' : 'Copy as markdown', icon: '⎘' });
      actions.push({ id: 'move-up', label: 'Move up', icon: '↑', disabled: readOnly, ...(upShortcut ? { shortcut: upShortcut } : {}) }, { id: 'move-down', label: 'Move down', icon: '↓', disabled: readOnly, ...(downShortcut ? { shortcut: downShortcut } : {}) });
      if (blocks.every((block) => block.parentId !== null) && blocks.every((block) => block.parentId === blocks[0]!.parentId)) actions.push({ id: 'move-out', label: 'Move out of section', icon: '⇤', disabled: readOnly });
      actions.push({ id: 'delete', label: 'Delete', icon: '✕', danger: true, disabled: readOnly });
      return actions;
    },
    run(actionId) {
      const state = store.get().menu;
      const ids = state ? [...state.blockIds] : [...store.get().selection.ids];
      if (!ids.length) return;
      const close = (): void => { store.set({ menu: null }); };
      if (actionId.startsWith('turn:')) { close(); commands.turnInto(actionId.slice(5) as TurnIntoTarget, ids); return; }
      switch (actionId) {
        case 'turn-into': menu.openSubmenu('turn-into'); return;
        case 'edit-chart': close(); api.openChartEditor(ids[0]!); return;
        case 'duplicate': close(); commands.duplicateBlocks(ids); return;
        case 'copy-id': close(); commands.copyId(ids[0]!); return;
        case 'copy-link': close(); commands.copyLink(ids[0]!); return;
        case 'copy': close(); void api.clipboard.copyToSystem(ids); return;
        case 'move-up': close(); commands.moveStep('up', ids); return;
        case 'move-down': close(); commands.moveStep('down', ids); return;
        case 'move-out': {
          close();
          const first = blockOf(ids[0]!), parent = first?.parentId ? blockOf(first.parentId) : undefined;
          if (parent) commands.moveBlocks(ids, { parentId: parent.parentId, afterId: parent.id });
          return;
        }
        case 'delete': close(); commands.deleteBlocks(ids); return;
      }
    },
  };

  // ---- clipboard ---------------------------------------------------------------------------------------------------
  const pasteBlocks = (pasted: readonly ReturnType<typeof blockInput>[]): boolean => {
    if (!pasted.length || !writable()) return false;
    const state = store.get(), current = state.editing ? blockOf(state.editing.blockId) : undefined;
    const draft = current ? drafts.contentOf(current.id) : undefined;
    others(current?.id ?? '');
    const d = doc(), tree = treeOf(d);
    let parentId: string | null, afterId: string | null;
    const operations: Operation[] = [];
    let consumed: string[] = [];
    if (current) {
      parentId = current.parentId; afterId = current.id;
      const emptyParagraph = draft?.type === 'paragraph' && runsPlainText(draft.runs) === '';
      if (emptyParagraph) { const siblings = tree.children.get(parentId) ?? [], at = siblings.findIndex((block) => block.id === current.id); afterId = at > 0 ? siblings[at - 1]!.id : null; consumed = [current.id]; }
    } else if (state.selection.ids.length) {
      const roots = rootsOf(d, state.selection.ids), last = tree.byId.get(roots[roots.length - 1]!);
      parentId = last?.parentId ?? null; afterId = last?.id ?? null;
    } else {
      parentId = null; const top = tree.children.get(null) ?? []; afterId = top[top.length - 1]?.id ?? null;
    }
    const blocks = pasted.map((block) => block.parentId === null ? { ...block, parentId } : block);
    operations.push({ type: 'insertBlocks', blocks, afterId });
    if (consumed.length && current) operations.push({ type: 'deleteBlocks', blocks: [{ blockId: current.id, expectedVersion: drafts.versionOf(current.id) ?? current.version }] });
    const result = drafts.guarded(consumed, () => run('paste', operations));
    if (!result.ok) return true;
    notify({ kind: 'success', message: `Pasted ${pasted.length} block${pasted.length === 1 ? '' : 's'}`, blockIds: blocks.map((block) => block.id) });
    const lastBlock = blocks[blocks.length - 1]!, entry = editTargetFor({ id: lastBlock.id, content: lastBlock.content }, 'end');
    if (entry) api.edit.start(lastBlock.id, { field: entry.field ?? 'main', caret: 'end' });
    else store.set({ selection: selectMany(order(), blocks.filter((block) => block.parentId === parentId).map((block) => block.id)), editing: null });
    return true;
  };
  const clipboard: Interaction['clipboard'] = {
    serialize(ids) { return serializeBlocks(doc(), targetIds(ids)); },
    copy(data) {
      const state = store.get();
      if (!state.selection.ids.length) return false;
      const payload = serializeBlocks(doc(), state.selection.ids);
      if (!payload) return false;
      data.setData('text/plain', payload.text); data.setData(CLIPBOARD_MIME, payload.json);
      notify({ kind: 'success', message: `Copied ${state.selection.ids.length} block${state.selection.ids.length === 1 ? '' : 's'}` });
      return true;
    },
    cut(data) {
      if (!writable()) return false;
      if (!clipboard.copy(data)) return false;
      commands.deleteBlocks(store.get().selection.ids);
      return true;
    },
    paste(data) {
      if (!writable()) return false;
      const ids = makeIds(), json = data.getData(CLIPBOARD_MIME), text = data.getData('text/plain');
      const blocks = parseBlocksPayload(json, doc(), ids);
      if (blocks) return pasteBlocks(blocks);
      const caret = store.get().editing ? readCaret() : null, content = caret ? drafts.contentOf(caret.blockId) : undefined;
      if (caret && content) {
        const rich = hasRichField(content, caret.field);
        if (content.type === 'code') return edit.insertText(text.replace(/\r\n?/g, '\n'));
        if (!rich) {
          const field = parseField(caret.field);
          const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
          if (content.type === 'list' && field.kind === 'item' && lines.length > 1) {
            const value = fieldText(content, caret.field), head = value.slice(0, caret.start) + lines[0]!, tail = value.slice(caret.end);
            const items = [{ text: head }, ...lines.slice(1, -1).map((line) => ({ text: line })), { text: lines[lines.length - 1]! + tail }];
            drafts.edit(caret.blockId, (c) => c.type === 'list' ? listSplice(c, field.index, 1, items) : c);
            requestSync(caret.blockId, null, 0, 0);
            return true;
          }
          return lines.length ? edit.insertText(lines.join(' ')) : true;
        }
      }
      const plan = planPaste(text, { hasSelection: !!caret && caret.start !== caret.end, inRichField: !!(caret && content && hasRichField(content, caret.field)), ...(options.linkSchemes ? { linkSchemes: options.linkSchemes } : {}) }, ids);
      if (!plan) return false;
      if (plan.kind === 'link') { const range = formatRange(); if (!range) return false; const next = setLink(range.runs, range.start, range.end, plan.href); drafts.edit(range.blockId, (c) => withFieldRuns(c, range.field, next)); requestSync(range.blockId, range.field, range.caretStart, range.caretEnd); return true; }
      if (plan.kind === 'inline') {
        if (caret) return edit.insertRuns(plan.runs);
        return pasteBlocks([blockInput(ids('block'), null, { type: 'paragraph', runs: plan.runs })]);
      }
      return pasteBlocks(plan.blocks);
    },
    async copyToSystem(ids) {
      const payload = serializeBlocks(doc(), targetIds(ids));
      if (!payload) return false;
      await writeClipboard(payload.text);
      notify({ kind: 'success', message: 'Copied as markdown' });
      return true;
    },
  };

  // ---- shortcuts / misc --------------------------------------------------------------------------------------------
  const registry = createShortcutRegistry<ShortcutContext>({ platform });
  const api: Interaction = {
    editor, actor: actor as InteractionActor, platform,
    getState: store.get, subscribe: store.subscribe,
    setReadOnly(readOnly) {
      if (readOnly) { flushAll(); store.set({ readOnly: true, editing: null, slash: null, menu: null, prompt: null, drag: null, textSelection: null, chartEditor: null }); }
      else store.set({ readOnly: false });
    },
    setHover(id) { store.set({ hover: id }); },
    escape() {
      const state = store.get();
      if (state.slash) { setSlash(null); return true; }
      if (state.prompt) { format.closePrompt(); return true; }
      if (state.chartEditor) { store.set({ chartEditor: null }); return true; }
      if (state.menu) { store.set({ menu: null }); return true; }
      if (state.help) { store.set({ help: false }); return true; }
      if (state.drag) { drag.cancel(); return true; }
      if (state.editing) { const id = state.editing.blockId; edit.stop(); store.set({ selection: selectOnly(id) }); return true; }
      if (state.selection.ids.length) { selection.clear(); return true; }
      return false;
    },
    openHelp() { store.set({ help: true }); }, closeHelp() { store.set({ help: false }); }, toggleHelp() { store.set({ help: !store.get().help }); },
    openChartEditor(blockId) { if (blockOf(blockId)?.content.type === 'chart') store.set({ chartEditor: blockId, menu: null }); },
    closeChartEditor() { store.set({ chartEditor: null }); },
    selection, edit, format, commands, slash, drag, menu, clipboard,
    shortcuts: Object.assign(registry, { handleKeyDown(event: KeyEventLike): boolean { return registry.handle(event, { interaction: api, state: store.get() }); } }),
    destroy() { destroyed = true; unsubscribe(); drafts.dispose(); handles.clear(); },
  };
  if (options.shortcuts !== false) registerDefaultShortcuts(api, registry);
  if (options.shortcuts) for (const [id, keys] of Object.entries(options.shortcuts)) registry.override(id, keys);

  // Keep every part of the state pointing at blocks that still exist.
  const unsubscribe = editor.subscribe(() => {
    if (destroyed) return;
    const state = store.get(), exists = (id: string): boolean => !!blockOf(id);
    const patch: Partial<InteractionState> = {};
    const pruned = pruneSelection(state.selection, exists);
    if (pruned !== state.selection) patch.selection = pruned;
    if (state.editing && !exists(state.editing.blockId)) { patch.editing = null; patch.slash = null; patch.textSelection = null; }
    if (state.hover && !exists(state.hover)) patch.hover = null;
    if (state.slash && !exists(state.slash.blockId)) patch.slash = null;
    if (state.menu) { const ids = state.menu.blockIds.filter(exists); if (!ids.length) patch.menu = null; else if (ids.length !== state.menu.blockIds.length) patch.menu = { ...state.menu, blockIds: ids, anchorId: exists(state.menu.anchorId) ? state.menu.anchorId : ids[0]! }; }
    if (state.chartEditor && !exists(state.chartEditor)) patch.chartEditor = null;
    if (state.drag && !state.drag.ids.every(exists)) patch.drag = null;
    if (Object.keys(patch).length) store.set(patch);
  });
  return api;
}
export { compatibleChartKinds };
