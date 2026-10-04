import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { b, createDocument, createEditor } from '@super-solution/editor-core';
import type { BlockInput, Editor, InlineRun } from '@super-solution/editor-core';
import {
  attachEditable, attachInteraction, createInteraction, getSelectionOffsets, readRunsFrom, renderDocument, renderRunsInto, setSelectionOffsets,
} from '@super-solution/editor-ui';
import type { Interaction, LayoutBox } from '@super-solution/editor-ui';

const at = '2026-10-05T12:00:00.000Z';
let counter = 0;
function seed(blocks: BlockInput[]): Editor {
  const editor = createEditor(createDocument({ id: 'doc', title: 'Doc' }, { now: () => at }), { now: () => at });
  const result = editor.apply({ id: `dom-seed-${++counter}`, actor: { id: 'h', kind: 'human' }, baseRevision: 0, operations: [{ type: 'addCitation', citation: { id: 'src', title: 'Source', url: 'https://example.com/s', accessedAt: at } }, ...blocks.map((block) => ({ type: 'insertBlock' as const, block }))] });
  assert.equal(result.ok, true, JSON.stringify(result));
  return editor;
}
const text = (editor: Editor, id: string): string => { const c = editor.getSnapshot().blocks.find((block) => block.id === id)!.content; return c.type === 'paragraph' ? c.runs.map((run) => run.text).join('') : c.type === 'heading' ? c.text : ''; };
function page(blocks: BlockInput[], options: { commitDelayMs?: number } = {}) {
  const dom = new JSDOM('<!doctype html><body><main id="root" tabindex="0"></main></body>', { pretendToBeVisual: true });
  const { window } = dom, { document } = window;
  const editor = seed(blocks);
  const root = document.getElementById('root')!;
  const interaction = createInteraction(editor, { commitDelayMs: options.commitDelayMs ?? 0, platform: 'other', now: () => at });
  const view = renderDocument(editor.getSnapshot(), { document });
  root.append(view);
  // A fake vertical layout: every block 40px, so geometry is deterministic without a layout engine.
  const measure = (): LayoutBox[] => {
    const boxes: LayoutBox[] = []; let y = 0;
    for (const block of editor.getSnapshot().blocks.filter((entry) => entry.parentId === null)) { boxes.push({ id: block.id, parentId: null, left: 100, right: 700, top: y, bottom: y + 40 }); y += 40; }
    return boxes;
  };
  const surface = attachInteraction(root, interaction, { measure, longPressMs: 15 });
  const rerender = (): void => { view.replaceWith(renderDocument(editor.getSnapshot(), { document })); };
  return { dom, document, window, editor, root, interaction, surface, rerender, destroy: () => { surface.destroy(); interaction.destroy(); window.close(); } };
}
type P = ReturnType<typeof page>;
function fire(p: P, target: EventTarget, type: string, init: Record<string, unknown> = {}): Event {
  const event = new p.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  for (const [key, value] of Object.entries(init)) if (!(key in event) || (event as unknown as Record<string, unknown>)[key] === undefined) Object.defineProperty(event, key, { value, configurable: true });
  target.dispatchEvent(event);
  return event;
}
function keydown(p: P, target: EventTarget, key: string, init: Record<string, unknown> = {}): KeyboardEvent {
  const event = new p.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

test('runs <-> DOM round trip keeps every mark, links and citation markers, and drops unsafe links', () => {
  const dom = new JSDOM('<!doctype html><p id="e"></p>');
  const el = dom.window.document.getElementById('e')!;
  const runs: InlineRun[] = [{ text: 'plain ' }, { text: 'all', bold: true, italic: true, code: true, strike: true, underline: true, highlight: 'pink' }, { text: ' link', href: 'https://example.com/x' }, { text: ' cited', citationId: 'src' }, { text: ' end\n' }];
  renderRunsInto(el, runs, { citationLabel: () => '1' });
  assert.equal(el.querySelectorAll('sup[data-citation-id="src"]').length, 1);
  assert.equal(el.querySelector('a')!.getAttribute('href'), 'https://example.com/x');
  assert.equal(el.querySelector('mark')!.getAttribute('data-highlight'), 'pink');
  assert.deepEqual(readRunsFrom(el), runs);
  renderRunsInto(el, [{ text: 'bad', href: 'javascript:alert(1)' }]);
  assert.equal(el.querySelector('a'), null);
  // Browser-made markup is understood too.
  el.innerHTML = 'a<b>b</b><i>i</i><span style="font-weight:700">w</span><a href="javascript:x">j</a><br>';
  assert.deepEqual(readRunsFrom(el), [{ text: 'a' }, { text: 'b', bold: true }, { text: 'i', italic: true }, { text: 'w', bold: true }, { text: 'j' }]);
});

test('selection offsets ignore citation markers and survive nested formatting', () => {
  const dom = new JSDOM('<!doctype html><p id="e"></p>');
  const el = dom.window.document.getElementById('e')!;
  renderRunsInto(el, [{ text: 'ab', bold: true, citationId: 'src' }, { text: 'cd' }], { citationLabel: () => '12' });
  setSelectionOffsets(el, 1, 3);
  assert.deepEqual(getSelectionOffsets(el), { start: 1, end: 3 });
  setSelectionOffsets(el, 4);
  assert.deepEqual(getSelectionOffsets(el), { start: 4, end: 4 });
  setSelectionOffsets(el, 0);
  assert.deepEqual(getSelectionOffsets(el), { start: 0, end: 0 });
  const range = dom.window.document.createRange();
  range.selectNodeContents(el);
  dom.window.document.getSelection()!.removeAllRanges(); dom.window.document.getSelection()!.addRange(range);
  assert.deepEqual(getSelectionOffsets(el), { start: 0, end: 4 });
});

test('editable: DOM input becomes a guarded human update, Enter splits, marks re-render with the selection kept', () => {
  const p = page([b.paragraph('a', 'hello'), b.paragraph('b', 'tail')]);
  const el = p.document.createElement('p');
  p.root.append(el);
  p.interaction.edit.start('a', { caret: 'end' });
  const binding = attachEditable(el, { interaction: p.interaction, blockId: 'a', field: 'main', mode: 'rich', placeholder: "Type '/' for commands" });
  assert.equal(el.getAttribute('contenteditable'), 'true');
  assert.equal(el.textContent, 'hello');
  assert.equal(p.document.activeElement, el, 'the editing request focuses the field');
  assert.deepEqual(getSelectionOffsets(el), { start: 5, end: 5 });
  // The user types "!".
  el.firstChild!.nodeValue = 'hello!';
  setSelectionOffsets(el, 6);
  el.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  assert.equal(text(p.editor, 'a'), 'hello!');
  assert.equal(p.editor.getRevisions().at(-1)!.actor.kind, 'human');
  // Mod+B with a selection bolds it in the DOM and the draft.
  setSelectionOffsets(el, 0, 5);
  const bold = keydown(p, el, 'b', { ctrlKey: true, code: 'KeyB' });
  assert.equal(bold.defaultPrevented, true);
  assert.equal(el.querySelector('strong')!.textContent, 'hello');
  assert.deepEqual(getSelectionOffsets(el), { start: 0, end: 5 });
  // Enter splits at the caret and the old field goes away with the block swap in the real UI; here the draft is committed.
  setSelectionOffsets(el, 2);
  const enter = keydown(p, el, 'Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.equal(p.editor.getSnapshot().blocks.length, 3);
  assert.deepEqual(p.editor.getSnapshot().blocks[0]!.content, { type: 'paragraph', runs: [{ text: 'he', bold: true }] });
  binding.destroy();
  p.destroy();
});

test('editable: external changes refresh the field, but unsent typing is kept and flagged', () => {
  const p = page([b.paragraph('a', 'one')], { commitDelayMs: 10_000 });
  const el = p.document.createElement('p');
  p.root.append(el);
  const binding = attachEditable(el, { interaction: p.interaction, blockId: 'a', field: 'main', mode: 'rich' });
  p.editor.apply({ id: 'agent-1', actor: { id: 'bot', kind: 'agent' }, baseRevision: p.editor.getSnapshot().revision, operations: [{ type: 'updateBlock', blockId: 'a', expectedVersion: 1, content: { type: 'paragraph', runs: [{ text: 'agent edit' }] } }] });
  assert.equal(el.textContent, 'agent edit', 'a clean field follows the document');
  el.firstChild!.nodeValue = 'agent edit and mine';
  el.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  p.editor.apply({ id: 'agent-2', actor: { id: 'bot', kind: 'agent' }, baseRevision: p.editor.getSnapshot().revision, operations: [{ type: 'updateBlock', blockId: 'a', expectedVersion: 2, content: { type: 'paragraph', runs: [{ text: 'agent again' }] } }] });
  assert.equal(el.textContent, 'agent edit and mine', 'typing is never overwritten');
  assert.ok(p.interaction.getState().conflicts.a);
  binding.destroy();
  p.destroy();
});

test('editable plain fields (heading) and virtual-keyboard Enter via beforeinput', () => {
  const p = page([b.heading('h', 2, 'Title')]);
  const el = p.document.createElement('h2');
  p.root.append(el);
  p.interaction.edit.start('h', { caret: 'end' });
  attachEditable(el, { interaction: p.interaction, blockId: 'h', field: 'main', mode: 'plain' });
  assert.equal(el.getAttribute('aria-multiline'), 'false');
  const before = new p.window.Event('beforeinput', { bubbles: true, cancelable: true });
  Object.defineProperty(before, 'inputType', { value: 'insertParagraph' });
  el.dispatchEvent(before);
  assert.equal(before.defaultPrevented, true);
  assert.equal(p.editor.getSnapshot().blocks.length, 2);
  p.destroy();
});

test('surface: clicking text starts editing at the clicked offset; clicking a chart selects it; shift/ctrl select ranges', () => {
  const p = page([b.paragraph('a', 'hello world'), b.chart('c', { kind: 'bar', title: 'C', labels: ['x'], series: [{ name: 's', values: [1] }] }), b.paragraph('z', 'last'), b.divider('d')]);
  const paragraph = p.root.querySelector('[data-block-id="a"] p')!;
  const selection = p.document.getSelection()!;
  selection.setBaseAndExtent(paragraph.firstChild!, 5, paragraph.firstChild!, 5);
  fire(p, paragraph, 'click');
  assert.deepEqual([p.interaction.getState().editing?.blockId, p.interaction.getState().editing?.caret], ['a', 5]);
  fire(p, p.root.querySelector('[data-block-id="c"]')!, 'click');
  assert.deepEqual(p.interaction.getState().selection.ids, ['c']);
  assert.equal(p.interaction.getState().editing, null);
  fire(p, p.root.querySelector('[data-block-id="d"]')!, 'click', { shiftKey: true });
  assert.deepEqual(p.interaction.getState().selection.ids, ['c', 'z', 'd']);
  fire(p, p.root.querySelector('[data-block-id="z"]')!, 'click', { ctrlKey: true });
  assert.deepEqual(p.interaction.getState().selection.ids, ['c', 'd']);
  fire(p, p.root, 'click');
  assert.deepEqual(p.interaction.getState().selection.ids, []);
  fire(p, p.root.querySelector('[data-block-id="c"]')!, 'dblclick');
  assert.equal(p.interaction.getState().chartEditor, 'c');
  // Clicking a button inside a block never starts editing.
  const button = p.document.createElement('button'); p.root.querySelector('[data-block-id="z"]')!.append(button);
  fire(p, button, 'click');
  assert.equal(p.interaction.getState().editing, null);
  p.destroy();
});

test('surface: hover tracks the block under the pointer, including the gutter strip to its left', () => {
  const p = page([b.paragraph('a', 'one'), b.paragraph('b', 'two')]);
  fire(p, p.root, 'pointermove', { clientX: 300, clientY: 10, pointerType: 'mouse' });
  assert.equal(p.interaction.getState().hover, 'a');
  fire(p, p.root, 'pointermove', { clientX: 60, clientY: 50, pointerType: 'mouse' });
  assert.equal(p.interaction.getState().hover, 'b', 'inside the 56px gutter corridor');
  fire(p, p.root, 'pointermove', { clientX: 10, clientY: 50, pointerType: 'mouse' });
  assert.equal(p.interaction.getState().hover, null);
  fire(p, p.root, 'pointermove', { clientX: 300, clientY: 10, pointerType: 'touch' });
  assert.equal(p.interaction.getState().hover, null, 'touch never hovers');
  fire(p, p.root, 'pointermove', { clientX: 300, clientY: 10, pointerType: 'mouse' });
  fire(p, p.root, 'pointerleave', { relatedTarget: null });
  assert.equal(p.interaction.getState().hover, null);
  p.destroy();
});

test('surface: dragging the handle reorders through one moveBlocks; a click on the handle opens the block menu', () => {
  const p = page([b.paragraph('a', 'one'), b.paragraph('b', 'two'), b.paragraph('c', 'three')]);
  const gutter = p.document.createElement('div'); gutter.setAttribute('data-se-gutter', '');
  const handle = p.document.createElement('button'); handle.setAttribute('data-se-drag-handle', ''); handle.setAttribute('data-se-block-id', 'a');
  gutter.append(handle); p.root.append(gutter);
  fire(p, handle, 'pointerdown', { clientX: 90, clientY: 10, pointerType: 'mouse', button: 0 });
  fire(p, p.document, 'pointermove', { clientX: 90, clientY: 11, pointerType: 'mouse' });
  assert.equal(p.interaction.getState().drag, null, 'below the movement threshold nothing starts');
  fire(p, p.document, 'pointermove', { clientX: 300, clientY: 70, pointerType: 'mouse' });
  assert.deepEqual(p.interaction.getState().drag?.ids, ['a']);
  assert.deepEqual(p.interaction.getState().drag?.placement, { parentId: null, afterId: 'b' });
  assert.equal(p.root.hasAttribute('data-se-dragging'), true);
  const before = p.editor.getSnapshot().revision;
  fire(p, p.document, 'pointerup', { clientX: 300, clientY: 70, pointerType: 'mouse' });
  assert.equal(p.editor.getSnapshot().revision, before + 1);
  assert.deepEqual(p.editor.getSnapshot().blocks.map((block) => block.id), ['b', 'a', 'c']);
  assert.equal(p.root.hasAttribute('data-se-dragging'), false);
  // A click without movement selects the block and opens its menu.
  handle.setAttribute('data-se-block-id', 'c');
  fire(p, handle, 'pointerdown', { clientX: 90, clientY: 90, pointerType: 'mouse', button: 0 });
  fire(p, p.document, 'pointerup', { clientX: 90, clientY: 90, pointerType: 'mouse' });
  assert.deepEqual(p.interaction.getState().menu, { blockIds: ['c'], anchorId: 'c', submenu: null });
  p.interaction.menu.close();
  // Escape cancels a drag in progress.
  handle.setAttribute('data-se-block-id', 'b');
  fire(p, handle, 'pointerdown', { clientX: 90, clientY: 50, pointerType: 'mouse', button: 0 });
  fire(p, p.document, 'pointermove', { clientX: 300, clientY: 110, pointerType: 'mouse' });
  assert.ok(p.interaction.getState().drag);
  const escape = new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  p.document.dispatchEvent(escape);
  assert.equal(p.interaction.getState().drag, null);
  p.destroy();
});

test('surface: touch long-press picks a block up for dragging; moving early means scrolling instead', async () => {
  const p = page([b.paragraph('a', 'one'), b.paragraph('b', 'two')]);
  const block = p.root.querySelector('[data-block-id="a"] p')!;
  fire(p, block, 'pointerdown', { clientX: 300, clientY: 10, pointerType: 'touch', button: 0 });
  fire(p, p.document, 'pointermove', { clientX: 300, clientY: 40, pointerType: 'touch' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(p.interaction.getState().drag, null, 'scrolling cancelled the long press');
  fire(p, p.document, 'pointerup', { pointerType: 'touch' });
  fire(p, block, 'pointerdown', { clientX: 300, clientY: 10, pointerType: 'touch', button: 0 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(p.interaction.getState().drag?.ids, ['a']);
  assert.equal(p.interaction.getState().drag?.pointerType, 'touch');
  fire(p, p.document, 'pointermove', { clientX: 300, clientY: 70, pointerType: 'touch' });
  fire(p, p.document, 'pointerup', { pointerType: 'touch' });
  assert.deepEqual(p.editor.getSnapshot().blocks.map((entry) => entry.id), ['b', 'a']);
  p.destroy();
});

test('surface: keyboard shortcuts are routed from the root, but not from popups or foreign inputs', () => {
  const p = page([b.paragraph('a', 'one'), b.paragraph('b', 'two')]);
  p.interaction.selection.select('a');
  const popup = p.document.createElement('div'); popup.setAttribute('data-se-popup', ''); const inner = p.document.createElement('button'); popup.append(inner); p.root.append(popup);
  assert.equal(keydown(p, inner, 'Backspace').defaultPrevented, false);
  assert.equal(p.editor.getSnapshot().blocks.length, 2);
  const input = p.document.createElement('input'); p.root.append(input);
  assert.equal(keydown(p, input, 'Backspace').defaultPrevented, false);
  assert.equal(keydown(p, p.root, 'Backspace').defaultPrevented, true);
  assert.deepEqual(p.editor.getSnapshot().blocks.map((entry) => entry.id), ['b']);
  p.destroy();
});

test('surface: copy, cut and paste of block selections go through the clipboard events', () => {
  const p = page([b.paragraph('a', 'one'), b.paragraph('b', 'two')]);
  const store = new Map<string, string>();
  const clipboardData = { getData: (type: string) => store.get(type) ?? '', setData: (type: string, value: string) => { store.set(type, value); } };
  p.interaction.selection.select('a');
  const copy = fire(p, p.root, 'copy', { clipboardData });
  assert.equal(copy.defaultPrevented, true);
  assert.equal(store.get('text/plain'), 'one');
  const paste = fire(p, p.root, 'paste', { clipboardData });
  assert.equal(paste.defaultPrevented, true);
  assert.deepEqual(p.editor.getSnapshot().blocks.map((entry) => text(p.editor, entry.id)), ['one', 'one', 'two']);
  p.interaction.selection.select('b');
  const second = [...p.editor.getSnapshot().blocks][1]!;
  p.interaction.selection.select(second.id);
  fire(p, p.root, 'cut', { clipboardData });
  assert.equal(p.editor.getSnapshot().blocks.length, 2);
  p.destroy();
});

test('surface: layout is measured lazily, cached, and refreshed after the document changes', () => {
  let measures = 0;
  const p = page([b.paragraph('a', 'one')]);
  p.surface.destroy();
  const surface = attachInteraction(p.root, p.interaction, { measure: () => { measures++; return [{ id: 'a', parentId: null, left: 0, right: 100, top: 0, bottom: 20 }]; } });
  assert.equal(measures, 0);
  surface.layout(); surface.layout();
  assert.equal(measures, 1);
  p.interaction.commands.duplicateBlocks(['a']);
  surface.layout();
  assert.equal(measures, 2);
  assert.deepEqual(surface.toContent(5, 7), { x: 5, y: 7 });
  surface.destroy();
  p.interaction.destroy();
});

test('surface: leaving the document with focus ends the editing session; moving inside it does not', async () => {
  const p = page([b.paragraph('a', 'one')]);
  p.interaction.edit.start('a');
  const inside = p.document.createElement('button'); p.root.append(inside);
  fire(p, p.root, 'focusout', { relatedTarget: inside });
  assert.ok(p.interaction.getState().editing);
  const outside = p.document.createElement('button'); p.document.body.append(outside);
  fire(p, p.root, 'focusout', { relatedTarget: outside });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(p.interaction.getState().editing, null);
  // A field replaced by the next one (Enter) reports focusout too, but the new field already has focus.
  p.interaction.edit.start('a');
  const field = p.document.createElement('p'); p.root.append(field); field.setAttribute('tabindex', '-1'); field.focus();
  fire(p, p.root, 'focusout', { relatedTarget: null });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(p.interaction.getState().editing);
  p.destroy();
});

test('interaction instances are independent and cleaned up', () => {
  const editor = seed([b.paragraph('a', 'one')]);
  const one: Interaction = createInteraction(editor, { commitDelayMs: 0 }), two: Interaction = createInteraction(editor, { commitDelayMs: 0 });
  one.selection.select('a');
  assert.deepEqual(two.getState().selection.ids, []);
  let notified = 0;
  const off = one.subscribe(() => { notified++; });
  one.selection.clear();
  off();
  one.selection.select('a');
  assert.equal(notified, 1);
  one.destroy(); two.destroy();
});
