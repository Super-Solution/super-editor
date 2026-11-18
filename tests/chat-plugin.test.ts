// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { AGENT_ACTIONS, createDocument, createEditor, createReportService } from '@supersolutions/super-editor-core';
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

test('feeding the saved document back does not remount the editor; a newer document does', () => {
  const { container, dom } = host();
  const saved: ReturnType<typeof report>[] = [];
  const plugin = createEditorChatPlugin({ onChange: (doc) => saved.push(doc) });
  const initial = report('Echo');
  const handle = mountOf(plugin)(container, { kind: EDITOR_CARD_KIND, mode: 'edit', document: initial }, ctx());
  const before = container.firstElementChild;
  (([...container.querySelectorAll('button')].find((b) => b.textContent === 'Add block')) as HTMLButtonElement).click();
  assert.equal(saved.length, 1);
  handle.update({ kind: EDITOR_CARD_KIND, mode: 'edit', document: saved[0] }, ctx());
  assert.equal(container.firstElementChild, before, 'the echo keeps the same editor');
  handle.update({ kind: EDITOR_CARD_KIND, mode: 'edit', document: { ...saved[0]!, revision: 99, title: 'Changed elsewhere' } }, ctx());
  assert.notEqual(container.firstElementChild, before, 'a newer revision replaces it');
  handle.destroy();
  dom.window.close();
});

test('debounceMs delays onChange and a pending call is flushed on destroy; actor and messages are configurable', async () => {
  const { container, dom } = host();
  const seen: number[] = [];
  const plugin = createEditorChatPlugin({ onChange: (doc) => seen.push(doc.revision), debounceMs: 20, actor: { id: 'ana' }, messages: { writing: 'Escribiendo…' } });
  const partial = mountOf(plugin)(container, { kind: EDITOR_CARD_KIND, document: report('x') }, ctx({ partial: true }));
  assert.equal(container.textContent, 'Escribiendo…');
  partial.destroy();
  const handle = mountOf(plugin)(container, { kind: EDITOR_CARD_KIND, mode: 'edit', document: report('Slow') }, ctx());
  const add = () => (([...container.querySelectorAll('button')].find((b) => b.textContent === 'Add block')) as HTMLButtonElement).click();
  add(); add();
  assert.deepEqual(seen, []);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(seen, [3]);
  add();
  handle.destroy();
  assert.deepEqual(seen, [3, 4]);
  dom.window.close();
});

// ---- agent tools ---------------------------------------------------------------------------------------------
type Tool = NonNullable<ReturnType<typeof createEditorChatPlugin>['tools']>[number] & { authority?: string; confirm?: boolean };
const toolsOf = (plugin: ReturnType<typeof createEditorChatPlugin>) => new Map((plugin.tools as Tool[]).map((t) => [t.name, t]));
function open(mode: 'edit' | 'view' = 'edit', options: Parameters<typeof createEditorChatPlugin>[0] = {}) {
  const { container, dom } = host();
  const plugin = createEditorChatPlugin(options);
  const handle = plugin.mounts![EDITOR_CARD_KIND]!(container, { kind: EDITOR_CARD_KIND, mode, document: report('Original') }, ctx());
  const call = (name: string, input: unknown = {}, context: { confirmed?: boolean; signal?: AbortSignal } = {}) => toolsOf(plugin).get(name)!.run(input, context) as Promise<any>;
  return { container, dom, plugin, handle, call, close() { handle.destroy(); dom.window.close(); } };
}

test('every tool declares its authority, and every destructive action asks first', () => {
  const plugin = createEditorChatPlugin();
  assert.deepEqual(validateChatPlugin(plugin), []);
  const tools = toolsOf(plugin);
  for (const tool of tools.values()) assert.ok(['read', 'draft', 'act'].includes(tool.authority ?? ''), tool.name);
  for (const action of AGENT_ACTIONS) {
    const tool = tools.get(`editor_${action.name}`);
    assert.ok(tool, action.name);
    assert.equal(tool.authority, action.access === 'read' ? 'read' : action.destructive ? 'act' : 'draft', action.name);
    assert.equal(tool.confirm === true, action.destructive && action.access === 'write', action.name);
  }
  for (const name of ['editor_apply_transaction', 'editor_undo', 'editor_redo']) {
    assert.equal(tools.get(name)?.authority, 'act');
    assert.equal(tools.get(name)?.confirm, true);
  }
  assert.equal(tools.get('editor_read_document')?.authority, 'read');
});

test('the agent reads a card, and its addition shows in the card with agent provenance', async () => {
  const c = open();
  const listed = await c.call('editor_list_documents');
  assert.deepEqual(listed.documents, [{ documentId: 'doc', title: 'Doc', revision: 1, writable: true }]);
  const added = await c.call('editor_insert_blocks', { markdown: 'Added by the agent', expectedRevision: 1 });
  assert.equal(added.ok, true);
  assert.match(c.container.textContent ?? '', /Added by the agent/);
  const revisions = await c.call('editor_list_revisions');
  assert.equal(revisions.revisions.at(-1).actor.id, 'chat-agent');
  assert.equal(revisions.revisions.at(-1).actor.kind, 'agent');
  c.close();
});

test('a stale edit is refused and changes nothing', async () => {
  const c = open();
  const block = (await c.call('editor_get_block', { blockId: 'p1' })).block;
  const first = await c.call('editor_update_block_text', { blockId: 'p1', expectedVersion: block.version, text: 'New' }, { confirmed: true });
  assert.equal(first.ok, true);
  const stale = await c.call('editor_update_block_text', { blockId: 'p1', expectedVersion: block.version, text: 'Overwrite' }, { confirmed: true });
  assert.equal(stale.ok, false);
  assert.equal(stale.issues[0].code, 'conflict');
  assert.match(c.container.textContent ?? '', /New/);
  assert.doesNotMatch(c.container.textContent ?? '', /Overwrite/);
  c.close();
});

test('a destructive tool refuses to run unless the host confirmed it', async () => {
  const c = open();
  const block = (await c.call('editor_get_block', { blockId: 'p1' })).block;
  const input = { blocks: [{ blockId: 'p1', expectedVersion: block.version }] };
  for (const context of [{}, { confirmed: false }]) {
    const refused = await c.call('editor_delete_blocks', input, context);
    assert.equal(refused.ok, false);
    assert.equal(refused.confirmationRequired, true);
  }
  assert.match(c.container.textContent ?? '', /Original/);
  assert.equal((await c.call('editor_delete_blocks', input, { confirmed: true })).ok, true);
  assert.doesNotMatch(c.container.textContent ?? '', /Original/);
  c.close();
});

test('apply_transaction records the host actor, not the one the model names', async () => {
  const c = open();
  const result = await c.call('editor_apply_transaction', { transaction: { id: 't1', actor: { id: 'the-owner', kind: 'human' }, baseRevision: 1, operations: [{ type: 'setTitle', title: 'Renamed' }] } }, { confirmed: true });
  assert.equal(result.ok, true);
  const last = (await c.call('editor_list_revisions')).revisions.at(-1);
  assert.deepEqual(last.actor, { id: 'chat-agent', kind: 'agent' });
  c.close();
});

test('a view card can be read but not changed', async () => {
  const c = open('view');
  assert.equal((await c.call('editor_get_outline')).ok, true);
  const refused = await c.call('editor_insert_blocks', { markdown: 'No' });
  assert.equal(refused.ok, false);
  assert.match(refused.issues[0].message, /read-only/);
  c.close();
});

test('tools fail with a usable message when there is no such document', async () => {
  const plugin = createEditorChatPlugin();
  const tools = toolsOf(plugin);
  const none = await tools.get('editor_get_outline')!.run({}, {}) as any;
  assert.equal(none.ok, false);
  assert.match(none.issues[0].message, /No document is on screen/);
  const unknown = await tools.get('editor_get_outline')!.run({ documentId: 'nope' }, {}) as any;
  assert.match(unknown.issues[0].message, /Unknown document "nope"/);
  const bad = await tools.get('editor_get_outline')!.run({ documentId: 7 }, {}) as any;
  assert.equal(bad.ok, false);
  const notObject = await tools.get('editor_get_outline')!.run('x', {}) as any;
  assert.equal(notObject.ok, false);
});

test('a removed card is no longer a tool target, and an aborted call does not run', async () => {
  const c = open();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => c.call('editor_get_outline', {}, { signal: abort.signal }));
  const tools = toolsOf(c.plugin);
  c.close();
  const gone = await tools.get('editor_get_outline')!.run({}, {}) as any;
  assert.equal(gone.ok, false);
});

test('resolveDocument reaches a document that is not on screen', async () => {
  const editor = createEditor(report('Stored'));
  const plugin = createEditorChatPlugin({ resolveDocument: (id) => id === 'stored' ? createReportService(editor) : undefined });
  const outline = await toolsOf(plugin).get('editor_get_outline')!.run({ documentId: 'stored' }, {}) as any;
  assert.equal(outline.ok, true);
});

// ---- host theme ----------------------------------------------------------------------------------------------
const hostTheme = { mode: 'dark', tokens: { background: '#101010', text: '#eeeeee', accent: '#3366ff', border: 'red; position: fixed' } };

test('a host theme reaches the document through the card container', () => {
  const { container, dom } = host();
  const handle = mountOf()(container, { kind: EDITOR_CARD_KIND, document: report('Themed') }, { ...ctx({ theme: 'dark' }), hostTheme } as CardMountContext);
  assert.equal(container.dataset.seTheme, 'dark');
  assert.equal(container.style.getPropertyValue('--se-bg'), '#101010');
  assert.equal(container.style.getPropertyValue('--se-link'), '#3366ff');
  assert.equal(container.style.getPropertyValue('--se-border'), '', 'an unsafe value is dropped');
  assert.equal(container.querySelector('[data-se-theme]'), null, 'nothing inside overrides what the container sets');
  handle.destroy();
  assert.equal(container.style.getPropertyValue('--se-bg'), '');
  assert.equal(container.dataset.seTheme, undefined);
  dom.window.close();
});

test('changing the host theme keeps the document and the agent\'s edits', async () => {
  const { container, dom } = host();
  const plugin = createEditorChatPlugin();
  const spec = { kind: EDITOR_CARD_KIND, mode: 'edit', document: report('Keep') };
  const handle = plugin.mounts![EDITOR_CARD_KIND]!(container, spec, { ...ctx({ theme: 'dark' }), hostTheme } as CardMountContext);
  await toolsOf(plugin).get('editor_insert_blocks')!.run({ markdown: 'Agent line' }, {});
  const before = container.firstElementChild;
  handle.update(spec, { ...ctx({ theme: 'light' }), hostTheme: { mode: 'light', tokens: { background: '#ffffff' } } } as CardMountContext);
  assert.equal(container.firstElementChild, before);
  assert.equal(container.style.getPropertyValue('--se-bg'), '#ffffff');
  assert.match(container.textContent ?? '', /Agent line/);
  handle.destroy();
  dom.window.close();
});

test('switching light and dark without a host theme keeps the agent\'s edits', async () => {
  const { container, dom } = host();
  const plugin = createEditorChatPlugin();
  const spec = { kind: EDITOR_CARD_KIND, mode: 'edit', document: report('Keep') };
  const handle = plugin.mounts![EDITOR_CARD_KIND]!(container, spec, ctx());
  await toolsOf(plugin).get('editor_insert_blocks')!.run({ markdown: 'Agent line' }, {});
  handle.update(spec, ctx({ theme: 'dark' }));
  assert.ok(container.querySelector('[data-se-theme="dark"]'));
  assert.match(container.textContent ?? '', /Agent line/);
  handle.destroy();
  dom.window.close();
});

test('a card the host remounts keeps what the agent wrote', async () => {
  const { container, dom } = host();
  const plugin = createEditorChatPlugin();
  const mount = plugin.mounts![EDITOR_CARD_KIND]!;
  const spec = { kind: EDITOR_CARD_KIND, mode: 'edit', document: report('Keep') };
  const first = mount(container, spec, ctx());
  await toolsOf(plugin).get('editor_insert_blocks')!.run({ markdown: 'Agent line' }, {});
  first.destroy();
  const second = mount(container, JSON.parse(JSON.stringify(spec)), ctx());
  assert.match(container.textContent ?? '', /Agent line/);
  const outline = await toolsOf(plugin).get('editor_get_outline')!.run({}, {}) as any;
  assert.equal(outline.revision, 2);
  second.destroy();
  dom.window.close();
});

test('a card with a different document does not inherit earlier edits', async () => {
  const { container, dom } = host();
  const plugin = createEditorChatPlugin();
  const mount = plugin.mounts![EDITOR_CARD_KIND]!;
  const first = mount(container, { kind: EDITOR_CARD_KIND, mode: 'edit', document: report('One') }, ctx());
  await toolsOf(plugin).get('editor_insert_blocks')!.run({ markdown: 'Agent line' }, {});
  first.destroy();
  const second = mount(container, { kind: EDITOR_CARD_KIND, mode: 'edit', document: report('Two') }, ctx());
  assert.doesNotMatch(container.textContent ?? '', /Agent line/);
  assert.match(container.textContent ?? '', /Two/);
  second.destroy();
  dom.window.close();
});
