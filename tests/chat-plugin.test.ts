// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createDocument, createEditor } from '@supersolutions/super-editor-core';
import { createEditorChatPlugin } from '@supersolutions/super-editor-chat-plugin';
import { EDITOR_CARD_KIND, validateChatPlugin, type CardMountContext } from '@supersolutions/super-protocol';

const at = '2026-10-05T12:00:00.000Z';
function report(text: string) {
  const editor = createEditor(createDocument({ id: 'doc', title: 'Doc' }, { now: () => at }), { now: () => at });
  const result = editor.apply({ id: 'seed', actor: { id: 'h', kind: 'human' }, baseRevision: 0, operations: [{ type: 'insertBlock', block: { id: 'p1', parentId: null, citationIds: [], content: { type: 'paragraph', runs: [{ text }] } } }] });
  assert.equal(result.ok, true);
  return editor.getSnapshot();
}
const ctx = (over: Partial<CardMountContext> = {}): CardMountContext => ({ theme: 'light', ...over });
const tick = () => new Promise((r) => setTimeout(r, 0));
function host() {
  const dom = new JSDOM('<!doctype html><body><div id="c"></div></body>', { pretendToBeVisual: true });
  return { dom, container: dom.window.document.getElementById('c') as HTMLElement };
}
const mountOf = (plugin = createEditorChatPlugin()) => plugin.mounts![EDITOR_CARD_KIND]!;

test('the plugin is a valid, fully implemented ChatPlugin under the GPL manifest', () => {
  const plugin = createEditorChatPlugin();
  assert.deepEqual(validateChatPlugin(plugin), []);
  assert.equal(plugin.manifest.license, 'GPL-3.0-or-later');
});

test('an inline document renders read-only by default and follows the theme', () => {
  const { container, dom } = host();
  const handle = mountOf()(container, { kind: EDITOR_CARD_KIND, document: report('In chat') }, ctx({ theme: 'dark' }));
  assert.match(container.textContent ?? '', /In chat/);
  assert.equal(container.querySelector('button'), null);
  assert.ok(container.querySelector('[data-se-theme="dark"]'));
  handle.destroy();
  assert.equal(container.childElementCount, 0);
  dom.window.close();
});

test('edit mode reports user edits through onChange', () => {
  const { container, dom } = host();
  const seen: number[] = [];
  const plugin = createEditorChatPlugin({ onChange: (doc) => seen.push(doc.revision) });
  const spec = { kind: EDITOR_CARD_KIND, mode: 'edit', document: report('Editable') };
  const handle = mountOf(plugin)(container, spec, ctx());
  const add = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add block') as HTMLButtonElement | undefined;
  assert.ok(add);
  add.click();
  assert.deepEqual(seen, [2]);
  handle.destroy();
  dom.window.close();
});

test('update re-renders only when the spec or theme changes, and partial specs show a placeholder', () => {
  const { container, dom } = host();
  const spec = { kind: EDITOR_CARD_KIND, document: report('One') };
  const handle = mountOf()(container, spec, ctx());
  const first = container.firstElementChild;
  handle.update({ ...spec }, ctx());
  assert.equal(container.firstElementChild, first, 'identical content keeps the DOM');
  handle.update({ kind: EDITOR_CARD_KIND, document: report('Two') }, ctx());
  assert.match(container.textContent ?? '', /Two/);
  handle.update(spec, ctx({ partial: true }));
  assert.match(container.textContent ?? '', /still being written/);
  handle.destroy();
  dom.window.close();
});

test('an invalid spec or document is reported inline instead of throwing', () => {
  const { container, dom } = host();
  const handle = mountOf()(container, { kind: EDITOR_CARD_KIND }, ctx());
  assert.equal(container.querySelector('[role="alert"]')?.textContent?.includes('exactly one'), true);
  handle.update({ kind: EDITOR_CARD_KIND, document: { schemaVersion: 1, id: 'x', title: 'x', blocks: [{ nonsense: true }] } }, ctx());
  assert.ok(container.querySelector('[role="alert"]'));
  handle.destroy();
  dom.window.close();
});

test('a service reference is fetched with the host headers, shown read-only, and errors are reported', async () => {
  const { container, dom } = host();
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const doc = report('From service');
  const plugin = createEditorChatPlugin({
    headers: () => ({ authorization: 'Bearer t' }),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return url.includes('missing') ? new Response('nope', { status: 404 }) : Response.json(doc);
    }) as typeof fetch,
  });
  const mount = mountOf(plugin);
  const handle = mount(container, { kind: EDITOR_CARD_KIND, service: { baseUrl: 'https://e.example.com/', documentId: 'doc 1' } }, ctx());
  assert.match(container.textContent ?? '', /Loading/);
  await tick(); await tick();
  assert.equal(calls[0]?.url, 'https://e.example.com/documents/doc%201/document');
  assert.equal(calls[0]?.headers.authorization, 'Bearer t');
  assert.match(container.textContent ?? '', /From service/);
  assert.equal(container.querySelector('button'), null);

  handle.update({ kind: EDITOR_CARD_KIND, service: { baseUrl: 'https://e.example.com', documentId: 'missing' } }, ctx());
  await tick(); await tick();
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /404/);
  handle.destroy();
  dom.window.close();
});

test('a superseded or destroyed service load never touches the DOM', async () => {
  const { container, dom } = host();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const plugin = createEditorChatPlugin({
    fetch: (async (_url: string, init: RequestInit) => {
      await gate;
      if ((init.signal as AbortSignal).aborted) throw new Error('aborted');
      return Response.json(report('Late'));
    }) as typeof fetch,
  });
  const handle = mountOf(plugin)(container, { kind: EDITOR_CARD_KIND, service: { baseUrl: 'https://e.example.com', documentId: 'd' } }, ctx());
  handle.destroy();
  release();
  await tick(); await tick();
  assert.equal(container.childElementCount, 0);
  dom.window.close();
});
