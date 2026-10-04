import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { b, createDocument, createEditor } from '@super-solution/editor-core';
import type { BlockInput, Editor, InlineRun } from '@super-solution/editor-core';
import { setSelectionOffsets } from '@super-solution/editor-ui';
import type { LayoutBox } from '@super-solution/editor-ui';
import {
  InteractionProvider, InteractiveSurface, ReportEditor, ReportView, interactiveBlockRenderers,
  useCommands, useCreateInteraction, useDragAndDrop, useEditor, useSelection, useShortcuts, useSlashMenu,
} from '@super-solution/editor-react';

const at = '2026-10-05T12:00:00.000Z';
let counter = 0;
function seed(blocks: BlockInput[]): Editor {
  const editor = createEditor(createDocument({ id: 'doc', title: 'Doc' }, { now: () => at }), { now: () => at });
  const result = editor.apply({ id: `react-seed-${++counter}`, actor: { id: 'h', kind: 'human' }, baseRevision: 0, operations: [{ type: 'addCitation', citation: { id: 'src', title: 'Source', url: 'https://example.com/s', accessedAt: at } }, ...blocks.map((block) => ({ type: 'insertBlock' as const, block }))] });
  assert.equal(result.ok, true, JSON.stringify(result));
  return editor;
}
const sample = (): BlockInput[] => [
  b.heading('h', 2, 'Heading'), b.paragraph('p1', 'alpha beta'), b.paragraph('p2', 'gamma'), b.list('todo', ['one', 'two'], { style: 'todo', checked: [false, true] }),
  b.toggle('tg', 'More', { open: true }), b.paragraph('inner', 'nested', { parentId: 'tg' }), b.table('t', ['A', 'B'], [['1', '2']]),
  b.chart('c', { kind: 'bar', title: 'Chart', labels: ['x', 'y'], series: [{ name: 's', values: [1, 2] }] }),
];
const text = (editor: Editor, id: string): string => { const c = editor.getSnapshot().blocks.find((block) => block.id === id)!.content; return c.type === 'paragraph' ? c.runs.map((run) => run.text).join('') : c.type === 'heading' ? c.text : ''; };

type Env = { dom: JSDOM; container: HTMLElement; doc: Document; win: JSDOM['window']; render(node: ReactNode): Promise<void>; unmount(): Promise<void> };
async function withDom(run: (env: Env) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { url: 'https://app.example.com', pretendToBeVisual: true });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    const { createRoot } = await import('react-dom/client');
    const container = dom.window.document.getElementById('app')!, root = createRoot(container);
    await run({ dom, container, doc: dom.window.document, win: dom.window, render: (node) => act(async () => root.render(node)), unmount: () => act(async () => root.unmount()) });
  } finally {
    for (const key of keys) { const descriptor = saved.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
}
const fire = (env: Env, target: EventTarget, type: string, init: Record<string, unknown> = {}): Promise<Event> => act(async () => {
  const event = new env.win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  for (const [key, value] of Object.entries(init)) if ((event as unknown as Record<string, unknown>)[key] === undefined) Object.defineProperty(event, key, { value, configurable: true });
  target.dispatchEvent(event);
  return event;
});
const press = (env: Env, target: EventTarget, key: string, init: Record<string, unknown> = {}): Promise<KeyboardEvent> => act(async () => {
  const event = new env.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
});
const typeInto = (env: Env, element: HTMLElement, value: string, caret = value.length, data: string | null = null): Promise<void> => act(async () => {
  element.textContent = value;
  setSelectionOffsets(element, caret);
  const event = new env.win.Event('input', { bubbles: true }) as Event & { data?: string | null };
  Object.defineProperty(event, 'data', { value: data });
  element.dispatchEvent(event);
});
const q = <T extends Element = HTMLElement>(env: Env, selector: string): T | null => env.container.querySelector<T>(selector);
const flush = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
/** Fake geometry: every top-level block 40px tall, so hover and drop have something to hit in a layout-less DOM. */
const measure = (editor: Editor) => (): LayoutBox[] => { let y = 0; return editor.getSnapshot().blocks.filter((block) => block.parentId === null).map((block) => { const box = { id: block.id, parentId: null, left: 100, right: 700, top: y, bottom: y + 40 }; y += 40; return box; }); };

test('ReportEditor is interactive by default and classic with interaction={false}', () => {
  const editor = seed(sample());
  const html = renderToStaticMarkup(<ReportEditor editor={editor} renderControls={false} />);
  assert.match(html, /class="se-surface"/);
  assert.match(html, /role="group"/);
  assert.doesNotMatch(html, /Edit paragraph/);
  assert.match(html, /se-todo-box/);
  const classic = renderToStaticMarkup(<ReportEditor editor={editor} renderControls={false} interaction={false} />);
  assert.match(classic, /Edit paragraph/);
  assert.doesNotMatch(classic, /se-surface/);
  assert.match(renderToStaticMarkup(<ReportEditor editor={editor} theme="dark" density="compact" renderControls={false} />), /class="super-editor se-editor"[^>]*data-se-theme="dark"[^>]*data-se-density="compact"/);
});

test('clicking text edits it in place: typing commits a guarded human update, Enter splits, the editor keeps focus', async () => {
  await withDom(async (env) => {
    const editor = seed(sample());
    await env.render(<ReportEditor editor={editor} commitDelayMs={0} renderControls={false} />);
    assert.equal(env.container.querySelectorAll('[data-se-editable]').length, 0);
    const paragraph = q(env, '[data-block-id="p1"] p')!;
    env.doc.getSelection()!.setBaseAndExtent(paragraph.firstChild!, 5, paragraph.firstChild!, 5);
    await fire(env, paragraph, 'click');
    const field = q(env, '[data-block-id="p1"] [data-se-editable]')!;
    assert.ok(field, 'the paragraph became editable');
    assert.equal(field.tagName, 'P');
    assert.equal(field.className.includes('se-paragraph'), true, 'same class as the view, so it looks the same');
    assert.equal(env.doc.activeElement, field);
    await typeInto(env, field, 'alpha! beta', 6, '!');
    assert.equal(text(editor, 'p1'), 'alpha! beta');
    assert.deepEqual(editor.getRevisions().at(-1)!.actor, { id: 'local-human', kind: 'human' });
    await press(env, field, 'Enter');
    assert.equal(text(editor, 'p1'), 'alpha!');
    const second = editor.getSnapshot().blocks.find((block) => block.id !== 'p1' && text(editor, block.id) === ' beta')!;
    assert.ok(second);
    const next = q(env, `[data-block-id="${second.id}"] [data-se-editable]`)!;
    assert.ok(next, 'editing moved to the new block');
    assert.equal(env.doc.activeElement, next);
    assert.equal(env.container.querySelectorAll('[data-se-editable]').length, 1);
    await env.unmount();
  });
});

test('the "/" menu is an ARIA listbox bound to the field, filters, runs and inserts the block', async () => {
  await withDom(async (env) => {
    const editor = seed([b.paragraph('p', '')]);
    await env.render(<ReportEditor editor={editor} commitDelayMs={0} renderControls={false} surface={{ measure: measure(editor) }} />);
    const view = q(env, '[data-block-id="p"] p')!;
    await fire(env, view, 'click');
    const field = q(env, '[data-se-editable]')!;
    assert.equal(field.getAttribute('data-empty'), 'true');
    assert.equal(field.getAttribute('data-placeholder'), "Type '/' for commands");
    await typeInto(env, field, '/', 1, '/');
    const list = q(env, '[role="listbox"]')!;
    assert.ok(list);
    assert.equal(field.getAttribute('aria-expanded'), 'true');
    assert.equal(field.getAttribute('aria-controls'), list.id);
    assert.ok(list.querySelectorAll('[role="option"]').length > 20);
    assert.equal(list.querySelector('[aria-selected="true"]')!.id, field.getAttribute('aria-activedescendant'));
    await typeInto(env, field, '/callout', 8, 't');
    assert.deepEqual([...list.querySelectorAll('.se-slash-label')].slice(0, 1).map((n) => n.textContent), ['Callout']);
    await press(env, field, 'ArrowDown');
    assert.equal(list.querySelector('[aria-selected="true"]')!.textContent!.includes('Success callout'), true);
    await press(env, field, 'Enter');
    const block = editor.getSnapshot().blocks.find((entry) => entry.id === 'p')!;
    assert.deepEqual(block.content, { type: 'callout', tone: 'success', runs: [] });
    assert.equal(q(env, '[role="listbox"]'), null);
    assert.equal(q(env, '[data-se-editable]')?.hasAttribute('aria-controls') ?? false, false, 'the combobox wiring is removed when the menu closes');
    await env.unmount();
  });
});

test('hovering shows the gutter with an add button and a drag handle; "+" opens the menu on a new block', async () => {
  await withDom(async (env) => {
    const editor = seed([b.paragraph('a', 'one'), b.paragraph('b', 'two')]);
    await env.render(<ReportEditor editor={editor} renderControls={false} surface={{ measure: measure(editor) }} />);
    assert.equal(q(env, '.se-gutter'), null);
    const surface = q(env, '.se-surface')!;
    await fire(env, surface, 'pointermove', { clientX: 300, clientY: 10, pointerType: 'mouse' });
    const gutter = q(env, '.se-gutter')!;
    assert.ok(gutter);
    assert.ok(q(env, '.se-outline'), 'hover outline');
    const add = gutter.querySelector<HTMLElement>('[data-se-add]')!, handle = gutter.querySelector<HTMLElement>('[data-se-drag-handle]')!;
    assert.equal(add.getAttribute('aria-label'), 'Add a block below');
    assert.equal(handle.getAttribute('aria-haspopup'), 'menu');
    await act(async () => { add.click(); });
    assert.equal(editor.getSnapshot().blocks.length, 3);
    assert.ok(q(env, '[role="listbox"]'));
    await env.unmount();
  });
});

test('handle click opens an accessible action menu: arrows move, Enter runs, Escape closes and focus returns', async () => {
  await withDom(async (env) => {
    const editor = seed([b.paragraph('a', 'one'), b.paragraph('b', 'two')]);
    await env.render(<ReportEditor editor={editor} renderControls={false} surface={{ measure: measure(editor) }} />);
    const surface = q(env, '.se-surface')!;
    await fire(env, surface, 'pointermove', { clientX: 300, clientY: 10, pointerType: 'mouse' });
    const handle = q(env, '[data-se-drag-handle]')!;
    await fire(env, handle, 'pointerdown', { clientX: 90, clientY: 10, pointerType: 'mouse', button: 0 });
    await fire(env, env.doc, 'pointerup', { clientX: 90, clientY: 10, pointerType: 'mouse' });
    const menu = q(env, '[role="menu"]')!;
    assert.ok(menu);
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    assert.equal(items[0]!.textContent!.includes('Turn into'), true);
    assert.equal(env.doc.activeElement, items[0], 'focus moves into the menu');
    await press(env, env.doc.activeElement!, 'ArrowDown');
    assert.equal(env.doc.activeElement!.textContent!.includes('Duplicate'), true);
    await act(async () => { (env.doc.activeElement as HTMLElement).click(); });
    assert.equal(editor.getSnapshot().blocks.length, 3);
    assert.equal(q(env, '[role="menu"]'), null);
    // Escape closes and returns focus to the document.
    await fire(env, surface, 'pointermove', { clientX: 300, clientY: 10, pointerType: 'mouse' });
    await fire(env, q(env, '[data-se-drag-handle]')!, 'pointerdown', { clientX: 90, clientY: 10, pointerType: 'mouse', button: 0 });
    await fire(env, env.doc, 'pointerup', { clientX: 90, clientY: 10, pointerType: 'mouse' });
    await press(env, env.doc.activeElement!, 'Escape');
    assert.equal(q(env, '[role="menu"]'), null);
    assert.equal(env.doc.activeElement, surface);
    await env.unmount();
  });
});

test('shortcut help opens with Mod+/ as a labelled modal dialog and closes with Escape', async () => {
  await withDom(async (env) => {
    const editor = seed(sample());
    await env.render(<ReportEditor editor={editor} renderControls={false} />);
    const surface = q(env, '.se-surface')!;
    surface.focus();
    await press(env, surface, '/', { ctrlKey: true, code: 'Slash' });
    const dialog = q(env, '[role="dialog"][aria-modal="true"]')!;
    assert.ok(dialog);
    assert.ok(env.doc.getElementById(dialog.getAttribute('aria-labelledby')!));
    const text = dialog.textContent!;
    assert.match(text, /Bold/); assert.match(text, /Ctrl/); assert.match(text, /Markdown shortcuts/);
    await press(env, dialog, 'Escape');
    assert.equal(q(env, '[role="dialog"]'), null);
    await env.unmount();
  });
});

test('checklists and toggles work without entering edit mode and persist as guarded updates', async () => {
  await withDom(async (env) => {
    const editor = seed(sample());
    await env.render(<ReportEditor editor={editor} renderControls={false} />);
    const boxes = [...env.container.querySelectorAll<HTMLInputElement>('.se-todo-box')];
    assert.equal(boxes.length, 2);
    assert.equal(boxes[0]!.disabled, false);
    await act(async () => { boxes[0]!.click(); });
    assert.deepEqual((editor.getSnapshot().blocks.find((block) => block.id === 'todo')!.content as { checked: boolean[] }).checked, [true, true]);
    const handle = q(env, '.se-toggle-handle')!;
    assert.equal(handle.getAttribute('aria-expanded'), 'true');
    await act(async () => { handle.click(); });
    assert.equal((editor.getSnapshot().blocks.find((block) => block.id === 'tg')!.content as { open: boolean }).open, false);
    assert.equal(q(env, '.se-toggle-head')!.getAttribute('data-open'), 'false');
    assert.equal(q(env, '.se-toggle-handle')!.getAttribute('aria-expanded'), 'false');
    await env.unmount();
  });
});

test('table cells edit in place; Tab walks the cells and appends a row after the last one', async () => {
  await withDom(async (env) => {
    const editor = seed([b.table('t', ['A', 'B'], [['1', '2']])]);
    await env.render(<ReportEditor editor={editor} commitDelayMs={0} renderControls={false} />);
    const cell = q(env, '[data-block-type="table"] tbody td')!;
    await fire(env, cell, 'click');
    const fields = [...env.container.querySelectorAll<HTMLElement>('.se-table-edit [data-se-editable]')];
    assert.equal(fields.length, 4);
    assert.ok(q(env, '.se-table-toolbar'));
    await typeInto(env, fields[2]!, '10');
    assert.deepEqual((editor.getSnapshot().blocks[0]!.content as { rows: string[][] }).rows, [['10', '2']]);
    await press(env, fields[2]!, 'Tab');
    assert.equal(env.doc.activeElement, fields[3]);
    await press(env, fields[3]!, 'Tab');
    assert.equal((editor.getSnapshot().blocks[0]!.content as { rows: string[][] }).rows.length, 2);
    await act(async () => { q(env, '.se-table-toolbar [aria-label="Add column"]')!.click(); });
    assert.equal((editor.getSnapshot().blocks[0]!.content as { columns: string[] }).columns.length, 3);
    await env.unmount();
  });
});

test('the formatting toolbar follows a text selection and its buttons apply marks; the link popover validates https', async () => {
  await withDom(async (env) => {
    const editor = seed([b.paragraph('p', 'hello big world')]);
    await env.render(<ReportEditor editor={editor} commitDelayMs={0} renderControls={false} />);
    await fire(env, q(env, '[data-block-id="p"] p')!, 'click');
    const field = q(env, '[data-se-editable]')!;
    await act(async () => { setSelectionOffsets(field, 6, 9); env.doc.dispatchEvent(new env.win.Event('selectionchange')); });
    const toolbar = q(env, '[role="toolbar"][aria-label="Text formatting"]')!;
    assert.ok(toolbar);
    const bold = toolbar.querySelector<HTMLElement>('[aria-label="Bold"]')!;
    assert.equal(bold.getAttribute('aria-pressed'), 'false');
    await act(async () => { bold.dispatchEvent(new env.win.MouseEvent('mousedown', { bubbles: true, cancelable: true })); bold.click(); });
    assert.equal(field.querySelector('strong')!.textContent, 'big');
    assert.equal(env.container.querySelector('[aria-label="Bold"]')!.getAttribute('aria-pressed'), 'true');
    await press(env, field, 'k', { ctrlKey: true, code: 'KeyK' });
    const dialog = q(env, '[role="dialog"][aria-label="Edit link"]')!;
    assert.ok(dialog);
    const input = dialog.querySelector('input')!;
    await act(async () => { const setter = Object.getOwnPropertyDescriptor(env.win.HTMLInputElement.prototype, 'value')!.set!; setter.call(input, 'javascript:alert(1)'); input.dispatchEvent(new env.win.Event('input', { bubbles: true })); });
    await act(async () => { dialog.querySelector('form')!.dispatchEvent(new env.win.Event('submit', { bubbles: true, cancelable: true })); });
    assert.match(q(env, '[role="dialog"] [role="alert"]')!.textContent!, /https/);
    await act(async () => { const setter = Object.getOwnPropertyDescriptor(env.win.HTMLInputElement.prototype, 'value')!.set!; setter.call(input, 'example.com/x'); input.dispatchEvent(new env.win.Event('input', { bubbles: true })); });
    await act(async () => { dialog.querySelector('form')!.dispatchEvent(new env.win.Event('submit', { bubbles: true, cancelable: true })); });
    assert.equal(q(env, '[role="dialog"][aria-label="Edit link"]'), null);
    const runs = (editor.getSnapshot().blocks[0]!.content as { runs: InlineRun[] }).runs;
    assert.equal(runs.find((run) => run.text === 'big')!.href, 'https://example.com/x');
    await env.unmount();
  });
});

test('block selection: toolbar with count and actions, Delete shows an Undo toast that restores the blocks', async () => {
  await withDom(async (env) => {
    const editor = seed([b.paragraph('a', 'one'), b.paragraph('b', 'two'), b.paragraph('c', 'three')]);
    await env.render(<ReportEditor editor={editor} renderControls={false} />);
    const surface = q(env, '.se-surface')!;
    await fire(env, q(env, '[data-block-id="a"]')!, 'click', { ctrlKey: true });
    await fire(env, q(env, '[data-block-id="b"]')!, 'click', { ctrlKey: true });
    const bar = q(env, '[role="toolbar"][aria-label="Selected blocks"]')!;
    assert.ok(bar);
    assert.equal(bar.querySelector('[role="status"]')!.textContent, '2 blocks selected');
    assert.equal(q(env, '.se-selected') !== null, true);
    await press(env, surface, 'Backspace');
    assert.deepEqual(editor.getSnapshot().blocks.map((block) => block.id), ['c']);
    const toast = q(env, '.se-toast')!;
    assert.ok(toast, 'success toast from the rendering layer');
    assert.match(toast.textContent!, /Deleted 2 blocks/);
    const undo = [...toast.querySelectorAll('button')].find((button) => button.textContent === 'Undo')!;
    await act(async () => { undo.click(); });
    assert.deepEqual(editor.getSnapshot().blocks.map((block) => block.id), ['a', 'b', 'c']);
    await env.unmount();
  });
});

test('refused edits become toasts through toastFromApplyResult; hosts that pass onFeedback own the toasts', async () => {
  await withDom(async (env) => {
    const real = seed([b.paragraph('a', 'one'), b.paragraph('b', 'two')]);
    let raced = false;
    const racing: Editor = { ...real, apply(value: unknown) {
      if (!raced) { raced = true; real.apply({ id: 'race-react', actor: { id: 'bot', kind: 'agent' }, baseRevision: real.getSnapshot().revision, operations: [{ type: 'setTitle', title: 'elsewhere' }] }); }
      return real.apply(value);
    } };
    await env.render(<ReportEditor editor={racing} renderControls={false} />);
    // Drive a command through the DOM: select a block and press Delete while another writer commits first.
    await fire(env, q(env, '[data-block-id="b"]')!, 'click', { ctrlKey: true });
    await press(env, q(env, '.se-surface')!, 'Backspace');
    const toast = q(env, '.se-toast')!;
    assert.equal(toast.getAttribute('data-tone'), 'conflict');
    assert.equal(toast.getAttribute('role'), 'alert');
    assert.equal(real.getSnapshot().blocks.length, 2, 'the refused delete changed nothing');
    await env.unmount();
  });
  await withDom(async (env) => {
    const editor = seed([b.paragraph('a', 'one')]);
    const events: string[] = [];
    await env.render(<ReportEditor editor={editor} renderControls={false} onFeedback={(event) => events.push(event.kind)} />);
    await fire(env, q(env, '[data-block-id="a"]')!, 'click', { ctrlKey: true });
    await press(env, q(env, '.se-surface')!, 'Backspace');
    assert.deepEqual(events, ['success']);
    assert.equal(q(env, '.se-toasts'), null, 'no built-in toast stack when the host handles feedback');
    await env.unmount();
  });
});

test('typing in one block does not re-render other blocks (stable renderers keep the document view memoized)', async () => {
  await withDom(async (env) => {
    const editor = seed([b.heading('h', 2, 'Heading'), b.paragraph('p1', 'one'), b.paragraph('p2', 'two')]);
    const renders: Record<string, number> = {};
    const blockRenderers = { heading: (block: { id: string }, context: { renderDefaultBlock(b: never): ReactNode }) => { renders[block.id] = (renders[block.id] ?? 0) + 1; return context.renderDefaultBlock(block as never); } };
    await env.render(<ReportEditor editor={editor} commitDelayMs={0} renderControls={false} blockRenderers={blockRenderers as never} />);
    assert.equal(renders.h, 1);
    await fire(env, q(env, '[data-block-id="p1"] p')!, 'click');
    await typeInto(env, q(env, '[data-se-editable]')!, 'one!');
    await typeInto(env, q(env, '[data-se-editable]')!, 'one!!');
    assert.equal(text(editor, 'p1'), 'one!!');
    assert.equal(renders.h, 1, 'the untouched heading was not rendered again');
    await env.unmount();
  });
});

test('opt-out props remove each part, readOnly disables editing, and parts compose on their own', async () => {
  await withDom(async (env) => {
    const editor = seed([b.paragraph('a', 'one'), b.paragraph('b', 'two')]);
    await env.render(<ReportEditor editor={editor} renderControls={false} gutter={false} hoverOutline={false} slashMenu={false} selectionToolbar={false} surface={{ measure: measure(editor) }} />);
    const surface = q(env, '.se-surface')!;
    await fire(env, surface, 'pointermove', { clientX: 300, clientY: 10, pointerType: 'mouse' });
    assert.equal(q(env, '.se-gutter'), null);
    assert.equal(q(env, '.se-outline'), null);
    await fire(env, q(env, '[data-block-id="a"]')!, 'click', { ctrlKey: true });
    assert.equal(q(env, '[aria-label="Selected blocks"]'), null);
    assert.ok(q(env, '.se-selected'));
    await env.render(<ReportEditor editor={editor} renderControls={false} readOnly />);
    assert.equal(q(env, '.se-editor')!.hasAttribute('data-se-readonly'), true);
    await fire(env, q(env, '[data-block-id="b"] p')!, 'click');
    assert.equal(q(env, '[data-se-editable]'), null, 'read-only text cannot be edited');
    await env.unmount();
  });
});

test('hooks and standalone components compose a custom surface', async () => {
  await withDom(async (env) => {
    const editor = seed([b.paragraph('a', 'one'), b.paragraph('b', 'two')]);
    const seen: { count: number; slash: boolean; shortcuts: number; dragging: boolean } = { count: -1, slash: false, shortcuts: 0, dragging: true };
    let api: { selection: ReturnType<typeof useSelection>; commands: ReturnType<typeof useCommands>; slash: ReturnType<typeof useSlashMenu> } | null = null;
    function Probe(): ReactNode {
      const selection = useSelection(), commands = useCommands(), slash = useSlashMenu(), shortcuts = useShortcuts(), drag = useDragAndDrop();
      api = { selection, commands, slash };
      seen.count = selection.count; seen.slash = slash.open; seen.shortcuts = shortcuts.groups.length; seen.dragging = drag.dragging;
      return <span data-probe>{selection.count}</span>;
    }
    function Custom(): ReactNode {
      const interaction = useCreateInteraction(editor, { commitDelayMs: 0 }), report = useEditor(editor);
      return <InteractionProvider interaction={interaction}>
        <InteractiveSurface gutter={false}>
          <ReportView document={report} blockRenderers={interactiveBlockRenderers()} />
          <Probe />
        </InteractiveSurface>
      </InteractionProvider>;
    }
    await env.render(<Custom />);
    assert.deepEqual(seen, { count: 0, slash: false, shortcuts: seen.shortcuts, dragging: false });
    assert.ok(seen.shortcuts >= 5, 'shortcut groups for a help UI');
    await act(async () => { api!.selection.select('a'); });
    assert.equal(seen.count, 1);
    await act(async () => { api!.commands.duplicateBlocks(); });
    assert.equal(editor.getSnapshot().blocks.length, 3);
    await act(async () => { api!.slash.openAfter('a'); });
    assert.equal(seen.slash, true);
    assert.ok(q(env, '[role="listbox"]'));
    await env.unmount();
  });
});

test('a conflict while typing shows the notice with both choices; keeping my version re-applies it', async () => {
  await withDom(async (env) => {
    const editor = seed([b.paragraph('p', 'start')]);
    await env.render(<ReportEditor editor={editor} commitDelayMs={10_000} renderControls={false} />);
    await fire(env, q(env, '[data-block-id="p"] p')!, 'click');
    await typeInto(env, q(env, '[data-se-editable]')!, 'my words');
    await act(async () => { editor.apply({ id: 'agent-c', actor: { id: 'bot', kind: 'agent' }, baseRevision: editor.getSnapshot().revision, operations: [{ type: 'updateBlock', blockId: 'p', expectedVersion: 1, content: { type: 'paragraph', runs: [{ text: 'agent words' }] } }] }); });
    const notice = q(env, '[data-se-conflict="p"]')!;
    assert.ok(notice);
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.equal(q(env, '[data-se-editable]')!.textContent, 'my words', 'typing is never overwritten');
    const keep = [...notice.querySelectorAll('button')].find((button) => button.textContent === 'Keep my version')!;
    await act(async () => { keep.click(); });
    assert.equal(text(editor, 'p'), 'my words');
    assert.equal(q(env, '[data-se-conflict]'), null);
    await flush();
    await env.unmount();
  });
});
