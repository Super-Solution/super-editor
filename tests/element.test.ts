// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createDocument, createEditor } from '@supersolutions/super-editor-core';
import { defineSuperEditor, type SuperEditorElement } from '@supersolutions/super-editor-element';

const at = '2026-10-05T12:00:00.000Z';
function report(text: string) {
  const editor = createEditor(createDocument({ id: 'doc', title: 'Doc' }, { now: () => at }), { now: () => at });
  const result = editor.apply({ id: 'seed', actor: { id: 'h', kind: 'human' }, baseRevision: 0, operations: [{ type: 'insertBlock', block: { id: 'p1', parentId: null, citationIds: [], content: { type: 'paragraph', runs: [{ text }] } } }] });
  assert.equal(result.ok, true);
  return editor.getSnapshot();
}
function page() {
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  const { window } = dom;
  defineSuperEditor({ registry: window.customElements, base: window.HTMLElement as unknown as typeof HTMLElement, warn: false });
  const el = window.document.createElement('super-editor') as unknown as SuperEditorElement;
  window.document.body.append(el);
  return { window, el, close: () => window.close() };
}

test('defineSuperEditor registers once and returns the same class', () => {
  const { window, close } = page();
  const again = defineSuperEditor({ registry: window.customElements, base: window.HTMLElement as unknown as typeof HTMLElement });
  assert.equal(window.customElements.get('super-editor'), again);
  close();
});

test('load renders the document in view mode and rejects an invalid one without losing the current document', () => {
  const { el, close } = page();
  const errors: string[] = [];
  el.addEventListener('error', (e) => errors.push((e as unknown as CustomEvent<{ message: string }>).detail.message));
  assert.equal(el.editor, null);
  assert.equal(el.load(report('Hello element')), true);
  assert.match(el.textContent ?? '', /Hello element/);
  assert.equal(el.querySelector('button'), null, 'view mode has no controls');
  assert.equal(el.load({ schemaVersion: 1, nonsense: true }), false);
  assert.equal(errors.length, 1);
  assert.match(el.textContent ?? '', /Hello element/);
  assert.equal(el.document?.revision, 1);
  close();
});

test('edit mode shows controls and a change reaches the host as an event; view mode re-renders on external edits', () => {
  const { el, close } = page();
  const changes: number[] = [];
  el.addEventListener('change', (e) => changes.push((e as CustomEvent<{ revision: number }>).detail.revision));
  el.load(report('First'));
  el.mode = 'edit';
  const add = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Add block');
  assert.ok(add, 'edit mode renders the default controls');
  (add as HTMLButtonElement).click();
  assert.deepEqual(changes, [2]);
  assert.equal(el.document?.revision, 2);

  el.mode = 'view';
  const editor = el.editor!;
  const outcome = editor.apply({ id: 'ext', actor: { id: 'a', kind: 'agent' }, baseRevision: 2, operations: [{ type: 'updateBlock', blockId: 'p1', expectedVersion: 1, content: { type: 'paragraph', runs: [{ text: 'Changed by agent' }] } }] });
  assert.equal(outcome.ok, true);
  assert.match(el.textContent ?? '', /Changed by agent/);
  assert.deepEqual(changes, [2, 3]);
  close();
});

test('mode only accepts view or edit, and disconnecting tears the view down', () => {
  const { window, el, close } = page();
  assert.throws(() => { el.mode = 'write' as never; }, RangeError);
  el.load(report('Bye'));
  assert.ok(el.childElementCount > 0);
  el.remove();
  assert.equal(el.childElementCount, 0);
  window.document.body.append(el);
  assert.match(el.textContent ?? '', /Bye/, 'reconnecting renders again');
  close();
});

test('theme attribute reaches the rendered document', () => {
  const { el, close } = page();
  el.setAttribute('theme', 'dark');
  el.load(report('Dark'));
  assert.ok(el.querySelector('[data-se-theme="dark"]'));
  close();
});

test('src loads a document, readonly forces view, and locale, time-zone, density, actor and labels reach the renderer', async () => {
  const { window, close } = page();
  const original = globalThis.fetch;
  const body = report('From src');
  const requested: string[] = [];
  globalThis.fetch = (async (url: string) => { requested.push(String(url)); return new Response(JSON.stringify(body), { status: 200 }); }) as typeof fetch;
  try {
    const el = window.document.createElement('super-editor') as unknown as SuperEditorElement;
    el.setAttribute('mode', 'edit');
    el.setAttribute('density', 'compact');
    el.setAttribute('locale', 'en-US');
    el.setAttribute('time-zone', 'UTC');
    el.setAttribute('actor', 'ana');
    el.setAttribute('src', 'https://docs.example.com/d.json');
    el.labels = { classic: { addBlock: 'Add a block' } } as never;
    const loaded = new Promise((resolve) => el.addEventListener('load', resolve));
    window.document.body.append(el);
    await loaded;
    assert.deepEqual(requested, ['https://docs.example.com/d.json']);
    assert.match(el.textContent ?? '', /From src/);
    assert.match(el.textContent ?? '', /Updated: Oct 5, 2026/);
    assert.ok([...el.querySelectorAll('button')].some((button) => button.textContent === 'Add a block'));
    assert.ok(el.querySelector('[data-se-density="compact"]'));
    el.setAttribute('readonly', '');
    assert.equal(el.mode, 'view');
    assert.equal(el.querySelector('button'), null);

    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const failures: string[] = [];
    el.addEventListener('error', (event) => failures.push((event as unknown as CustomEvent<{ message: string }>).detail.message));
    assert.equal(await el.reload(), false);
    assert.match(failures[0] ?? '', /500/);
    assert.match(el.textContent ?? '', /From src/, 'the previous document stays');
  } finally { globalThis.fetch = original; close(); }
});

test('mode="edit" says it is the basic editor: a data-editor attribute, and one console warning per page unless silenced', () => {
  const { el, close } = page();
  el.load(report('Basic'));
  assert.equal(el.getAttribute('data-editor'), null, 'view mode has no editor attribute');
  el.mode = 'edit';
  assert.equal(el.getAttribute('data-editor'), 'basic');
  el.mode = 'view';
  assert.equal(el.getAttribute('data-editor'), null, 'leaving edit mode removes it');
  close();

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
    defineSuperEditor({ tag: 'loud-editor', registry: dom.window.customElements, base: dom.window.HTMLElement as unknown as typeof HTMLElement });
    for (let index = 0; index < 2; index += 1) {
      const loud = dom.window.document.createElement('loud-editor') as unknown as SuperEditorElement;
      dom.window.document.body.append(loud);
      loud.load(report('Loud')); loud.mode = 'edit'; loud.mode = 'view'; loud.mode = 'edit';
    }
    assert.equal(warnings.length, 1, 'once per page, however many elements and renders');
    assert.match(warnings[0]!, /basic editor/); assert.match(warnings[0]!, /ReportEditor/); assert.match(warnings[0]!, /warn: false/);
    dom.window.close();
  } finally { console.warn = original; }
});
