// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { AGENT_ACTIONS, LIMITS, createDocument, createEditor, createReportService } from '@supersolutions/super-editor-core';
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
function host(url?: string) {
  const dom = new JSDOM('<!doctype html><body><div id="c"></div></body>', { pretendToBeVisual: true, ...(url ? { url } : {}) });
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

test('a service reference on the page\'s own origin is fetched with the host headers, shown read-only, and errors are reported', async () => {
  const { container, dom } = host('https://e.example.com/app');
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

test('with no configuration a card cannot make the page send credentials anywhere but its own origin, or reach a private network', async () => {
  const { container, dom } = host('https://app.example.com/chat');
  const calls: { url: string; init: RequestInit }[] = [];
  const plugin = createEditorChatPlugin({ headers: () => ({ authorization: 'Bearer secret' }), fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json(report('Fine')); }) as typeof fetch });
  const handle = mountOf(plugin)(container, { kind: EDITOR_CARD_KIND, service: { baseUrl: 'https://app.example.com/api', documentId: 'd' } }, ctx());
  const show = async (baseUrl: string): Promise<string> => { handle.update({ kind: EDITOR_CARD_KIND, service: { baseUrl, documentId: 'd' } }, ctx()); await tick(); await tick(); return container.querySelector('[role="alert"]')?.textContent ?? ''; };
  await tick(); await tick();
  // The host's own origin gets the credential: it is the host's own server.
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, 'Bearer secret');
  assert.equal(calls[0]?.url, 'https://app.example.com/api/documents/d/document');
  assert.equal(await show('https://app.example.com/other'), '');
  assert.equal((calls[1]?.init.headers as Record<string, string>).authorization, 'Bearer secret');
  // Another public https host is read, but anonymously: no credential, no cookies, no referrer, no redirect.
  assert.equal(await show('https://docs.example.net'), '');
  const anonymous = calls[2]!;
  assert.equal((anonymous.init.headers as Record<string, string>).authorization, undefined);
  assert.equal(anonymous.init.credentials, 'omit');
  assert.equal(anonymous.init.referrerPolicy, 'no-referrer');
  assert.equal(anonymous.init.redirect, 'error');
  // Everything that could be an internal target is refused before any request is made.
  const before = calls.length;
  for (const baseUrl of [
    'http://docs.example.net', 'https://user:pw@docs.example.net', 'https://localhost:8080', 'https://app.localhost', 'http://127.0.0.1', 'https://127.0.0.1', 'https://[::1]', 'https://10.0.0.5', 'https://172.16.0.1', 'https://192.168.1.1',
    'https://169.254.169.254', 'https://100.100.100.200', 'https://0.0.0.0', 'https://2130706433', 'https://0x7f.1', 'https://[::ffff:7f00:1]', 'https://[fd00:ec2::254]', 'https://[fe80::1]',
    'https://metadata.google.internal', 'https://intranet', 'https://printer.local', 'ftp://docs.example.net', 'javascript:alert(1)', 'https://[2002:7f00:1::1]',
  ]) {
    const refused = await show(baseUrl);
    assert.notEqual(refused, '', `${baseUrl} must be refused with a visible message`);
    assert.match(refused, /editor service address|http\(s\) baseUrl/);
  }
  assert.equal(calls.length, before, 'no request was made for any refused address');
  // Public addresses written in unusual but valid forms stay supported.
  for (const baseUrl of ['https://docs.example.net:8443/base/', 'https://xn--fiq228c.example.net', 'https://[2606:4700::1111]', 'https://8.8.8.8']) assert.equal(await show(baseUrl), '', baseUrl);
  handle.destroy();
  dom.window.close();
});

test('allowedServiceOrigins is optional and only widens the rules for exactly the origins it names', async () => {
  const { container, dom } = host('https://app.example.com/chat');
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const plugin = createEditorChatPlugin({
    headers: () => ({ authorization: 'Bearer secret' }),
    allowedServiceOrigins: ['https://editor.example.com', 'http://localhost:8080/ignored-path'],
    fetch: (async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string> }); return Response.json(report('Fine')); }) as typeof fetch,
  });
  const handle = mountOf(plugin)(container, { kind: EDITOR_CARD_KIND, service: { baseUrl: 'https://editor.example.com', documentId: 'd' } }, ctx());
  const show = async (baseUrl: string): Promise<string> => { handle.update({ kind: EDITOR_CARD_KIND, service: { baseUrl, documentId: 'd' } }, ctx()); await tick(); await tick(); return container.querySelector('[role="alert"]')?.textContent ?? ''; };
  await tick(); await tick();
  assert.equal(calls[0]?.headers.authorization, 'Bearer secret', 'a listed origin gets the credential');
  assert.equal(await show('http://localhost:8080'), '', 'a listed development or internal origin may be plain http or private');
  assert.equal(calls[1]?.headers.authorization, 'Bearer secret');
  assert.notEqual(await show('http://localhost:9090'), '', 'a different port is a different origin');
  assert.equal(await show('https://editor.example.com.evil.net/'), '');
  assert.equal(calls[2]?.headers.authorization, undefined, 'a look-alike host is not listed, so it stays anonymous');
  assert.equal(await show('https://other.example.net'), '');
  assert.equal(calls[3]?.headers.authorization, undefined, 'an unlisted public origin stays anonymous');
  handle.destroy();
  dom.window.close();
  assert.throws(() => createEditorChatPlugin({ allowedServiceOrigins: ['editor.example.com'] }), /not an origin/, 'a typo is reported, not ignored');
});

test('a URL the host builds with resolveServiceUrl is the host\'s decision and gets the credential; oversized and non-JSON answers are refused', async () => {
  const { container, dom } = host('https://app.example.com/chat');
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let answer = (): Response => Response.json(report('Fine'));
  const own = createEditorChatPlugin({ headers: () => ({ authorization: 'Bearer own' }), resolveServiceUrl: (service) => `https://internal.example.com/${service.documentId}`, fetch: (async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string> }); return answer(); }) as typeof fetch });
  const handle = mountOf(own)(container, { kind: EDITOR_CARD_KIND, service: { baseUrl: 'https://attacker.example.net', documentId: 'mine' } }, ctx());
  await tick(); await tick();
  assert.equal(calls[0]?.url, 'https://internal.example.com/mine');
  assert.equal(calls[0]?.headers.authorization, 'Bearer own');
  answer = () => new Response('x'.repeat(LIMITS.json + 1), { status: 200 });
  handle.update({ kind: EDITOR_CARD_KIND, service: { baseUrl: 'https://attacker.example.net', documentId: 'big' } }, ctx());
  await tick(); await tick();
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /too large/);
  answer = () => new Response('<html>', { status: 200 });
  handle.update({ kind: EDITOR_CARD_KIND, service: { baseUrl: 'https://attacker.example.net', documentId: 'html' } }, ctx());
  await tick(); await tick();
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /JSON/);
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

test('every tool that asks first words its approval for the person, with no internals', () => {
  type Wording = { title: string; description: string; summary?: { label: string; value: string }[]; confirmLabel: string; danger?: boolean };
  const tools = toolsOf(createEditorChatPlugin()) as Map<string, Tool & { approval?: (input: unknown) => Wording | undefined }>;
  const asking = [...tools.values()].filter((tool) => tool.confirm === true);
  assert.ok(asking.length >= 9);
  const inputs: Record<string, unknown> = {
    editor_set_title: { documentId: 'launch-report', title: 'Launch readiness report' },
    editor_update_block_text: { blockId: 'p1', expectedVersion: 3, text: 'Revenue grew 12%.' },
    editor_update_block: { blockId: 'tbl-2', expectedVersion: 1, content: { type: 'paragraph', runs: [] } },
    editor_replace_text: { find: 'Q3', replace: 'third quarter' },
    editor_delete_blocks: { blocks: [{ blockId: 'p1', expectedVersion: 2 }, { blockId: 'p2', expectedVersion: 1 }] },
    editor_import_markdown: { markdown: '# New', mode: 'replace', setTitle: true },
    editor_apply_transaction: { transaction: { operations: [{ type: 'setTitle', title: 'A' }, { type: 'setTitle', title: 'B' }] } },
    editor_undo: { expectedRevision: 4 },
    editor_redo: { expectedRevision: 5 },
  };
  for (const tool of asking) {
    const wording = tool.approval?.(inputs[tool.name] ?? {});
    assert.ok(wording, `${tool.name} words its approval`);
    assert.match(wording.title, /\?$/, tool.name);
    assert.match(wording.description, /\.$/, tool.name);
    const shown = [wording.title, wording.description, wording.confirmLabel, ...(wording.summary ?? []).flatMap((row) => [row.label, row.value])].join('\n');
    assert.doesNotMatch(shown, /editor_|super-editor|documentId|blockId|expectedVersion|expectedRevision|launch-report|tbl-2|p1|[{}]/, tool.name);
  }
  assert.deepEqual(tools.get('editor_set_title')!.approval!(inputs.editor_set_title), {
    title: 'Rename the document?',
    description: 'This document will be titled “Launch readiness report”. The new title shows in the header, in exports, and in the revision history.',
    confirmLabel: 'Rename',
  });
  assert.equal(tools.get('editor_delete_blocks')!.approval!(inputs.editor_delete_blocks)!.title, 'Delete these 2 parts?');
  assert.equal(tools.get('editor_delete_blocks')!.approval!(inputs.editor_delete_blocks)!.danger, true);
  assert.equal(tools.get('editor_replace_text')!.approval!({ find: 'draft', replace: '' })!.confirmLabel, 'Remove');
  // Tools that do not ask first carry no approval wording.
  assert.equal(tools.get('editor_insert_blocks')!.approval, undefined);
  // Wording never throws on input the model got wrong.
  for (const tool of asking) for (const bad of [null, 'x', 3, [], { blocks: 'x', transaction: 1, title: 4 }]) tool.approval!(bad);
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

test('a document in the chat draws its card blocks with the host\'s card mounts, and releases them with the card', () => {
  const editor = createEditor(createDocument({ id: 'doc', title: 'Doc' }, { now: () => at }), { now: () => at });
  assert.equal(editor.apply({ id: 'seed', actor: { id: 'h', kind: 'human' }, baseRevision: 0, operations: [{ type: 'insertBlock', block: { id: 'k', parentId: null, citationIds: [], content: { type: 'card', kind: 'super.plot', spec: { spec: {} }, alt: 'Flat.' } } }] }).ok, true);
  const seen: CardMountContext[] = [];
  let destroyed = 0;
  const plugin = createEditorChatPlugin({ cardMounts: { 'super.plot': (_node, _spec, context) => { seen.push(context); return { update() {}, destroy() { destroyed++; } }; } } });
  assert.ok(plugin.manifest.capabilities.some((capability) => capability.surface === 'panel' && capability.cardKind === EDITOR_CARD_KIND), 'documents may open in a side panel');
  const { container, dom } = host();
  const handle = mountOf(plugin)(container, { kind: EDITOR_CARD_KIND, document: editor.getSnapshot() }, ctx());
  assert.deepEqual(seen.map((context) => (context as { placement?: string }).placement), ['document']);
  assert.equal(container.querySelector('.se-card')?.getAttribute('data-state'), 'live');
  handle.destroy();
  assert.equal(destroyed, 1);
  dom.window.close();
});
