import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDocument, createEditor, diffDocuments } from '@super-solution/editor-core';
import type { ApplyResult, Citation, Editor } from '@super-solution/editor-core';
import type { FindHighlight } from '@super-solution/editor-ui';
import {
  CitationHoverCard, DocumentHeader, DocumentSkeleton, EmptyDocumentState, EmptyState, FindReplace, LabelsProvider, Outline, ReportView, RevisionHistory, SaveIndicator, Skeleton,
  StatusBar, ToastProvider, diffMarks, documentCounts, relativeTime, revisionEntries, toastFromApplyResult, useToasts,
} from '@super-solution/editor-react';
import type { SaveState, ToastApi } from '@super-solution/editor-react';
import { defaultLabels } from '@super-solution/editor-ui';
import { actor, apply, at, click, everyBlock, manyParagraphs, paragraph, withDom } from './helpers/dom.js';
import type { DomHarness } from './helpers/dom.js';

const all = (root: ParentNode, selector: string): Element[] => Array.from(root.querySelectorAll(selector));
const must = <T extends Element = Element>(root: ParentNode, selector: string): T => { const node = root.querySelector<T>(selector); assert.ok(node, `Missing ${selector}`); return node; };
const text = (root: ParentNode, selector: string): string => root.querySelector(selector)?.textContent ?? '';
const keydown = (h: DomHarness, target: EventTarget, init: KeyboardEventInit) => act(async () => { target.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

test('Outline lists sections and headings with depth, follows the scroll position and navigates', async () => {
  await withDom(async (h) => {
    const editor = everyBlock();
    const navigated: string[] = [];
    await h.render(<><Outline document={editor.getSnapshot()} onNavigate={(id) => navigated.push(id)} /><ReportView document={editor.getSnapshot()} /></>);
    const links = all(h.container, '.se-outline a');
    assert.deepEqual(links.map((a) => a.textContent), ['Summary', 'Heading one', 'Heading two']);
    assert.deepEqual(all(h.container, '.se-outline-item').map((item) => item.getAttribute('data-depth')), ['0', '1', '2']);
    assert.equal(must(h.container, 'nav.se-outline').getAttribute('aria-label'), 'Document outline');
    assert.equal(must(h.container, '.se-outline-item[data-active] a').getAttribute('aria-current'), 'location', 'the first entry is current before any scrolling');
    // Pretend the page has scrolled so the second heading's top is above the offset and the third is below it.
    const tops: Record<string, number> = { sec: -400, h1: 20, h2: 600 };
    for (const [id, top] of Object.entries(tops)) must<HTMLElement>(h.container, `[data-block-id="${id}"]`).getBoundingClientRect = () => ({ top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON: () => ({}) });
    await act(async () => { h.dom.window.dispatchEvent(new h.dom.window.Event('scroll')); await new Promise((resolve) => setTimeout(resolve, 40)); });
    assert.equal(text(h.container, '.se-outline-item[data-active] a'), 'Heading one');
    // Clicking scrolls (opening nothing here), prevents the hash jump and tells the host.
    let scrolled = 0;
    must<HTMLElement>(h.container, '[data-block-id="h2"]').scrollIntoView = () => { scrolled++; };
    const event = new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { links[2]!.dispatchEvent(event); });
    assert.equal(event.defaultPrevented, true); assert.equal(scrolled, 1); assert.deepEqual(navigated, ['h2']);
    // Controlled mode and depth limit.
    await h.render(<Outline document={editor.getSnapshot()} activeId="h2" maxDepth={2} />);
    assert.deepEqual(all(h.container, '.se-outline a').map((a) => a.textContent), ['Summary', 'Heading one']);
    await h.render(<Outline document={editor.getSnapshot()} activeId="sec" />);
    assert.equal(text(h.container, '.se-outline-item[data-active] a'), 'Summary');
    const blank = structuredClone(editor.getSnapshot()); blank.blocks = [];
    await h.render(<Outline document={blank} />);
    assert.match(text(h.container, '.se-panel-empty'), /Add a heading/);
  });
});

test('FindReplace: Mod+F opens, searches per block, steps through matches and highlights through onFindChange', async () => {
  await withDom(async (h) => {
    const editor = everyBlock();
    const finds: (FindHighlight | null)[] = [];
    const navigated: string[] = [];
    await h.render(<FindReplace editor={editor} onFindChange={(find) => finds.push(find)} onNavigate={(id) => navigated.push(id)} />);
    assert.equal(h.container.querySelector('.se-find'), null, 'closed until asked');
    await keydown(h, h.document, { key: 'f', ctrlKey: true });
    const panel = must(h.container, 'section.se-find');
    assert.equal(panel.getAttribute('role'), 'search');
    const input = must<HTMLInputElement>(panel, 'input[type="search"]');
    assert.equal(h.document.activeElement, input);
    await h.type(input, 'callout');
    assert.equal(text(panel, '.se-find-status span'), '5 matches in 5 blocks');
    assert.equal(text(panel, '.se-find-position'), 'Block 1 of 5');
    assert.deepEqual(finds.at(-1), { query: 'callout', caseSensitive: false, activeBlockId: 'callout-info' });
    assert.equal(navigated.at(-1), 'callout-info');
    await act(async () => click(h.dom, panel.querySelector('button[aria-label="Next match"]')));
    assert.equal(text(panel, '.se-find-position'), 'Block 2 of 5'); assert.equal(finds.at(-1)?.activeBlockId, 'callout-success');
    await act(async () => click(h.dom, panel.querySelector('button[aria-label="Previous match"]')));
    await act(async () => click(h.dom, panel.querySelector('button[aria-label="Previous match"]')));
    assert.equal(text(panel, '.se-find-position'), 'Block 5 of 5', 'stepping back from the first wraps around');
    // Enter and Shift+Enter move too.
    await keydown(h, input, { key: 'Enter' }); assert.equal(text(panel, '.se-find-position'), 'Block 1 of 5');
    await keydown(h, input, { key: 'Enter', shiftKey: true }); assert.equal(text(panel, '.se-find-position'), 'Block 5 of 5');
    await h.type(input, 'zzzz');
    assert.equal(text(panel, '.se-find-status span'), 'No matches');
    assert.equal(all(panel, 'button[aria-label="Next match"]').every((button) => (button as HTMLButtonElement).disabled), true);
    await h.type(input, 'ordered'); assert.equal(text(panel, '.se-find-status span'), 'No matches', 'list items are searchable only by their own words');
    await h.type(input, 'First'); assert.equal(text(panel, '.se-find-status span'), '1 match in 1 block');
    await keydown(h, panel, { key: 'Escape' });
    assert.equal(h.container.querySelector('.se-find'), null); assert.equal(finds.at(-1), null);
  });
});

test('FindReplace: replace changes the current block, replace all changes every block, both through guarded replaceText', async () => {
  await withDom(async (h) => {
    const editor = everyBlock();
    const outcomes: [boolean, number][] = [];
    await h.render(<FindReplace editor={editor} defaultOpen onResult={(result, info) => outcomes.push([result.ok, info.replaced])} shortcuts={false} />);
    const panel = must(h.container, 'section.se-find');
    await act(async () => click(h.dom, panel.querySelector('button[aria-label="Show replace"]')));
    const [find, replace] = [must<HTMLInputElement>(panel, 'input[type="search"]'), must<HTMLInputElement>(panel, 'input[aria-label="Replace with"]')];
    await h.type(find, 'callout'); await h.type(replace, 'box');
    const before = editor.getRevisions().length;
    await act(async () => click(h.dom, [...panel.querySelectorAll('button')].find((button) => button.textContent === 'Replace')!));
    assert.equal(editor.getRevisions().length, before + 1);
    const ops = editor.getRevisions().at(-1)!.operations;
    assert.deepEqual(ops.map((op) => op.type), ['replaceText']);
    assert.equal((ops[0] as { all?: boolean }).all, undefined, 'replace is first-occurrence only');
    assert.match(text(h.container, '.se-find-status span'), /Replaced 1 occurrence/);
    assert.deepEqual(outcomes, [[true, 1]]);
    assert.equal(editor.getSnapshot().blocks.find((block) => block.id === 'callout-info')!.content.type, 'callout');
    await act(async () => click(h.dom, [...panel.querySelectorAll('button')].find((button) => button.textContent === 'Replace all')!));
    assert.match(text(h.container, '.se-find-status span'), /Replaced 4 occurrences/);
    assert.equal(editor.getRevisions().at(-1)!.operations.length, 4, 'one transaction for all blocks');
    assert.equal(editor.getRevisions().at(-1)!.actor.id, 'local-human');
    assert.match(JSON.stringify(editor.getSnapshot().blocks.filter((block) => block.id.startsWith('callout-'))), /A info box/);
    assert.equal(text(panel, '.se-find-status span'), 'Replaced 4 occurrences.');
    // A concurrent edit by an agent is a conflict, not an overwrite.
    await h.type(find, 'Inside'); await h.type(replace, 'Outside');
    const inner = editor.getSnapshot().blocks.find((block) => block.id === 'inner')!;
    // Re-search renders the same version; make the document move on between the search and the click.
    const stale = editor.apply.bind(editor);
    let injected = false;
    (editor as { apply: Editor['apply'] }).apply = (transaction) => {
      if (!injected) { injected = true; stale({ id: 'agent-edit', actor: { id: 'agent', kind: 'agent' }, baseRevision: editor.getSnapshot().revision, operations: [{ type: 'updateBlock', blockId: 'inner', expectedVersion: inner.version, content: { type: 'paragraph', runs: [{ text: 'Inside, edited by an agent' }] } }] }); }
      return stale(transaction);
    };
    await act(async () => click(h.dom, [...panel.querySelectorAll('button')].find((button) => button.textContent === 'Replace')!));
    assert.match(text(panel, '.se-find-status span'), /document changed while replacing|Revision|conflict|version/i);
    assert.equal(outcomes.at(-1)![0], false);
    assert.match(JSON.stringify(editor.getSnapshot().blocks.find((block) => block.id === 'inner')), /edited by an agent/, 'the agent edit survives');
  });
});

test('FindReplace: Mod+H shows replace, read-only hides it, controlled open is respected', async () => {
  await withDom(async (h) => {
    const editor = everyBlock();
    const openStates: boolean[] = [];
    await h.render(<FindReplace editor={editor} onOpenChange={(open) => openStates.push(open)} />);
    await keydown(h, h.document, { key: 'h', metaKey: true });
    assert.ok(h.container.querySelector('input[aria-label="Replace with"]'));
    assert.deepEqual(openStates, [true]);
    await keydown(h, h.document, { key: 'g', ctrlKey: true });
    assert.equal(openStates.length, 1, 'other keys are ignored');
    await h.render(<FindReplace editor={editor} open={false} />);
    assert.equal(h.container.querySelector('.se-find'), null);
    await h.render(<FindReplace editor={editor} open readOnly shortcuts={false} />);
    assert.equal(h.container.querySelector('input[aria-label="Replace with"]'), null);
    assert.match(text(h.container, '.se-find'), /read-only/i);
    await h.render(<FindReplace editor={editor} open defaultReplace shortcuts={false} labels={{ find: { find: '尋找', replaceAll: '全部取代' } }} />);
    assert.equal(must(h.container, 'input[type="search"]').getAttribute('aria-label'), '尋找');
    assert.ok([...h.container.querySelectorAll('button')].some((button) => button.textContent === '全部取代'));
  });
});

test('StatusBar shows words, reading time, blocks, charts and revision; SaveIndicator reports every state', async () => {
  const editor = everyBlock();
  const counts = documentCounts(editor.getSnapshot(), defaultLabels);
  assert.match(counts.words, /^\d+ words$/); assert.match(counts.reading, /^[1-9]\d* min read$/); assert.equal(counts.blocks, `${editor.getSnapshot().blocks.length} blocks`); assert.equal(counts.charts, '2 charts'); assert.match(counts.revision, /^Revision \d+$/);
  const one = createEditor(createDocument({ id: 'one', title: 'One' }, { now: () => at }), { now: () => at });
  apply(one, [{ type: 'insertBlock', block: paragraph('p', 'Hello') }]);
  const small = documentCounts(one.getSnapshot(), defaultLabels);
  assert.equal(small.words, '1 word'); assert.equal(small.blocks, '1 block'); assert.equal(small.charts, '');
  const empty = documentCounts(createDocument({ id: 'e', title: 'E' }), defaultLabels);
  assert.equal(empty.reading, ''); assert.equal(empty.words, '0 words');
  const cjk = createEditor(createDocument({ id: 'cjk', title: 'CJK' }, { now: () => at }), { now: () => at });
  apply(cjk, [{ type: 'insertBlock', block: paragraph('p', '這是一份中文研究報告') }]);
  assert.equal(documentCounts(cjk.getSnapshot(), defaultLabels).words, '10 words', 'each CJK character counts as a word');
  await withDom(async (h) => {
    await h.render(<StatusBar document={editor.getSnapshot()} save={{ state: 'saved', savedAt: new Date(Date.now() - 5 * 60_000).toISOString() }}><span>3 selected</span></StatusBar>);
    const bar = must(h.container, '.se-status-bar');
    assert.equal(bar.getAttribute('role'), 'group'); assert.equal(bar.getAttribute('aria-label'), 'Document status');
    assert.ok(all(bar, '.se-status-items li').length >= 4);
    assert.match(text(bar, '.se-save'), /^Saved 5 minutes ago$/);
    assert.match(bar.textContent!, /3 selected/);
    const states: [SaveState, RegExp][] = [['saving', /^Saving…$/], ['unsaved', /^Unsaved changes$/], ['error', /^Save failed/], ['offline', /^Offline/], ['conflict', /^Conflict$/], ['saved', /^Saved$/]];
    for (const [state, pattern] of states) {
      await h.render(<SaveIndicator state={state} />);
      const indicator = must(h.container, '.se-save');
      assert.match(indicator.textContent!, pattern, state);
      assert.equal(indicator.getAttribute('data-state'), state); assert.equal(indicator.getAttribute('role'), 'status'); assert.equal(indicator.getAttribute('aria-live'), 'polite');
    }
    let retried = 0;
    await h.render(<SaveIndicator state="error" onRetry={() => retried++} />);
    await act(async () => click(h.dom, h.container.querySelector('button')));
    assert.equal(retried, 1);
    await h.render(<SaveIndicator state="saved" onRetry={() => retried++} />);
    assert.equal(h.container.querySelector('button'), null, 'a saved document has nothing to retry');
    await h.render(<SaveIndicator state="saved" savedAt={Date.parse('2026-10-05T12:00:00Z')} now={Date.parse('2026-10-05T12:00:20Z')} />);
    assert.equal(text(h.container, '.se-save'), 'Saved just now');
  });
  assert.equal(relativeTime('2026-10-05T10:00:00Z', Date.parse('2026-10-05T12:00:00Z'), 'now', 'en-US'), '2 hours ago');
  assert.equal(relativeTime('nonsense', 0, 'now'), '');
  assert.equal(relativeTime(Date.parse('2026-10-06T12:00:00Z'), Date.parse('2026-10-05T12:00:00Z'), 'now', 'en-US'), 'tomorrow');
  const html = renderToStaticMarkup(<StatusBar document={editor.getSnapshot()} labels={{ status: { words: '{count} 字' } }} />);
  assert.match(html, /\d+ 字/);
});

test('Toasts: tones, roles, auto-dismiss, sticky errors, keys, limits and the conflict toast', async () => {
  await withDom(async (h) => {
    let api!: ToastApi;
    const Grab = (): ReactNode => { api = useToasts(); return null; };
    let reloads = 0;
    await h.render(<ToastProvider duration={40} max={3}><Grab /></ToastProvider>);
    await act(async () => { api.success('Saved the report'); api.info('Heads up'); });
    const region = must(h.container, 'section.se-toasts');
    assert.equal(region.getAttribute('role'), 'region'); assert.equal(region.getAttribute('aria-label'), 'Notifications');
    assert.deepEqual(all(region, '.se-toast').map((toast) => [toast.getAttribute('data-tone'), toast.getAttribute('role')]), [['success', 'status'], ['info', 'status']]);
    await wait(120);
    assert.equal(all(region, '.se-toast').length, 0, 'success and info dismiss themselves');
    await act(async () => { api.error('The network is down', { title: 'Could not save' }); });
    assert.equal(must(region, '.se-toast').getAttribute('role'), 'alert');
    await wait(120);
    assert.equal(all(region, '.se-toast').length, 1, 'errors stay until dismissed');
    await act(async () => click(h.dom, region.querySelector('.se-toast-close')));
    assert.equal(all(region, '.se-toast').length, 0);
    // Conflict toast replaces itself by key and offers Reload.
    await act(async () => { api.conflict({ onReload: () => reloads++ }); api.conflict({ onReload: () => reloads++ }); });
    assert.equal(all(region, '.se-toast[data-tone="conflict"]').length, 1);
    assert.match(region.textContent!, /This document changed/);
    await act(async () => click(h.dom, [...region.querySelectorAll('button')].find((button) => button.textContent === 'Reload')!));
    assert.equal(reloads, 1); assert.equal(all(region, '.se-toast').length, 0, 'acting on a toast dismisses it');
    // Only `max` toasts are kept.
    await act(async () => { for (const label of ['a', 'b', 'c', 'd']) api.warning(label, { duration: 10_000 }); });
    assert.deepEqual(all(region, '.se-toast-message').map((node) => node.textContent), ['b', 'c', 'd']);
    // Escape on a focused toast dismisses it.
    await keydown(h, region.querySelector('.se-toast')!, { key: 'Escape' });
    assert.equal(all(region, '.se-toast').length, 2);
    await act(async () => api.clear());
    assert.equal(all(region, '.se-toast').length, 0);
    // notifyApplyResult maps failures to the right toast.
    const editor = everyBlock();
    const stale = editor.apply({ id: 'stale', actor, baseRevision: 0, operations: [{ type: 'setTitle', title: 'x' }] });
    await act(async () => { api.notifyApplyResult(stale, { onReload: () => reloads++ }); });
    assert.equal(all(region, '.se-toast[data-tone="conflict"]').length, 1);
    await act(async () => api.clear());
    const invalid = editor.apply({ id: 'invalid', actor, baseRevision: editor.getSnapshot().revision, operations: [{ type: 'setTitle', title: 5 as unknown as string }] });
    await act(async () => { api.notifyApplyResult(invalid); });
    assert.equal(must(region, '.se-toast').getAttribute('data-tone'), 'error');
    await act(async () => api.clear());
    const ok = editor.apply({ id: 'ok', actor, baseRevision: editor.getSnapshot().revision, operations: [{ type: 'setTitle', title: 'fine' }] });
    assert.equal(api.notifyApplyResult(ok), null);
    await act(async () => { api.notifyApplyResult(ok, { successMessage: 'Title saved' }); });
    assert.equal(text(region, '.se-toast-message'), 'Title saved');
  });
  const outside = renderToStaticMarkup(<Probe />);
  assert.equal(outside, 'ok', 'useToasts outside a provider is a harmless no-op');
  function Probe(): ReactNode { const toasts = useToasts(); toasts.error('ignored'); return 'ok'; }
  const failure: ApplyResult = { ok: false, currentRevision: 3, issues: [{ code: 'validation', message: 'Bad title.', hint: 'Use a shorter title.' }] };
  assert.deepEqual(toastFromApplyResult(failure), { tone: 'error', title: 'Error', message: 'Bad title. Use a shorter title.' });
  assert.equal(toastFromApplyResult({ ok: false, currentRevision: 1, issues: [{ code: 'conflict', message: 'x' }] })?.tone, 'conflict');
  assert.equal(toastFromApplyResult({ ok: false, currentRevision: 1, issues: [] })?.message, 'Error');
});

test('RevisionHistory lists newest first with summaries, selection, keyboard focus, restore and compare', async () => {
  await withDom(async (h) => {
    const editor = createEditor(createDocument({ id: 'h', title: 'History' }, { now: () => at }), { now: () => at });
    apply(editor, [{ type: 'insertBlocks', blocks: [paragraph('a', 'One'), paragraph('b', 'Two'), paragraph('c', 'Three')] }]);
    const first = editor.getSnapshot();
    apply(editor, [{ type: 'updateBlock', blockId: 'a', expectedVersion: first.blocks[0]!.version, content: { type: 'paragraph', runs: [{ text: 'One, revised' }] } }], { id: 'research-agent', kind: 'agent' });
    apply(editor, [{ type: 'setTitle', title: 'Renamed' }]);
    const entries = revisionEntries(editor.getRevisions());
    assert.deepEqual(entries.map((entry) => entry.revision), [3, 2, 1]);
    assert.match(entries[1]!.summary, /^Agent research-agent edited 1 block\.$/);
    const selected: number[] = [], restored: number[] = [], compared: number[] = [];
    const current = editor.getSnapshot();
    const diff = diffDocuments(first, current);
    await h.render(<RevisionHistory revisions={editor.getRevisions()} currentRevision={current.revision} selected={2} now={Date.parse(at) + 3 * 3_600_000}
      onSelect={(entry) => selected.push(entry.revision)} onRestore={(entry) => restored.push(entry.revision)} onCompare={(entry) => compared.push(entry.revision)} diff={diff} />);
    const items = all(h.container, 'button.se-history-item');
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((item) => text(item, '.se-history-revision')), ['Revision 3', 'Revision 2', 'Revision 1']);
    assert.equal(items[0]!.getAttribute('aria-current'), 'true'); assert.match(items[0]!.textContent!, /Current/);
    assert.equal(items[1]!.getAttribute('data-selected'), 'true'); assert.equal(items[1]!.getAttribute('aria-pressed'), 'true');
    assert.equal(text(items[1]!, '.se-badge'), 'Agent'); assert.equal(text(items[2]!, '.se-history-time'), '3 hours ago');
    assert.equal(items[2]!.querySelector('time')!.getAttribute('datetime'), at);
    await act(async () => click(h.dom, items[2]!));
    assert.deepEqual(selected, [1]);
    await keydown(h, items[0]!, { key: 'ArrowDown' });
    assert.equal(h.document.activeElement, items[1]); // jsdom focus follows the roving handler
    await keydown(h, items[1]!, { key: 'End' }); assert.equal(h.document.activeElement, items[2]);
    await keydown(h, items[2]!, { key: 'Home' }); assert.equal(h.document.activeElement, items[0]);
    await act(async () => click(h.dom, [...h.container.querySelectorAll('button.se-button')].find((button) => button.textContent === 'Restore this version')!));
    assert.deepEqual(restored, [2]);
    await act(async () => click(h.dom, [...h.container.querySelectorAll('button.se-button')].find((button) => button.textContent === 'Compare with current')!));
    assert.deepEqual(compared, [2]);
    assert.match(text(h.container, '.se-history-diff'), /^0 added, 1 changed, 0 removed, 0 moved$/);
    await h.render(<RevisionHistory revisions={entries} currentRevision={3} selected={3} onRestore={() => undefined} />);
    assert.equal(must<HTMLButtonElement>(h.container, 'button.se-button[data-primary]').disabled, true, 'the current revision cannot be restored');
    await h.render(<RevisionHistory revisions={[]} />);
    assert.equal(text(h.container, '.se-panel-empty'), 'No revisions yet.');
    // API-shaped entries work as well.
    await h.render(<RevisionHistory revisions={[{ revision: 9, at, actorKind: 'system', summary: 'Restored revision 4' }]} now={Date.parse(at)} />);
    assert.equal(text(h.container, '.se-history-summary'), 'Restored revision 4'); assert.equal(text(h.container, '.se-badge'), 'System');
    assert.deepEqual(diffMarks(null), undefined);
    assert.deepEqual(diffMarks(diff), { added: diff.added, changed: diff.changed, moved: diff.moved });
    // Diff marks highlight exactly the blocks an agent touched.
    await h.render(<ReportView document={current} diff={diffMarks(diff)} />);
    assert.deepEqual(all(h.container, '[data-diff]').map((node) => `${node.id}:${node.getAttribute('data-diff')}`), ['a:changed']);
  });
});

test('EmptyDocumentState and EmptyState offer next steps; Skeleton is accessible', async () => {
  await withDom(async (h) => {
    const picked: string[] = [];
    let templated = 0;
    await h.render(<EmptyDocumentState onInsert={(kind) => picked.push(kind)} onTemplate={() => templated++} />);
    const buttons = all(h.container, 'button');
    assert.deepEqual(buttons.map((button) => button.textContent), ['Heading', 'Paragraph', 'List', 'Table', 'Chart', 'Callout', 'Use a template']);
    assert.notEqual(buttons[0]!.getAttribute('data-primary'), null); assert.equal(buttons[1]!.getAttribute('data-primary'), null);
    await act(async () => { click(h.dom, buttons[4]!); click(h.dom, buttons[6]!); });
    assert.deepEqual(picked, ['chart']); assert.equal(templated, 1);
    assert.equal(text(h.container, 'h2'), 'Start your report');
    await h.render(<EmptyDocumentState onInsert={() => undefined} kinds={['paragraph', 'table']} labels={{ empty: { title: '開始撰寫', table: '表格' } }} />);
    assert.deepEqual(all(h.container, 'button').map((button) => button.textContent), ['Paragraph', '表格']); assert.equal(text(h.container, 'h2'), '開始撰寫');
    await h.render(<EmptyState title="No reports" description="Ask the agent to draft one." actions={[{ label: 'Ask the agent', onClick: () => picked.push('ask'), primary: true }]} icon="✦" />);
    await act(async () => click(h.dom, h.container.querySelector('button')));
    assert.equal(picked.at(-1), 'ask'); assert.equal(must(h.container, '.se-empty-icon').getAttribute('aria-hidden'), 'true');
    await h.render(<DocumentSkeleton />);
    const status = must(h.container, '[role="status"]');
    assert.equal(status.getAttribute('aria-busy'), 'true'); assert.equal(text(status, '.se-sr'), 'Loading…');
    assert.ok(all(status, '.se-skeleton').length >= 6);
    assert.ok(all(status, '.se-skeleton').every((node) => node.closest('[aria-hidden="true"]') !== null), 'shimmer shapes are hidden from assistive tech');
    assert.equal(renderToStaticMarkup(<Skeleton shape="circle" width={32} height={32} />).includes('data-shape="circle"'), true);
    assert.equal((renderToStaticMarkup(<Skeleton lines={4} />).match(/class="se-skeleton"/g) ?? []).length, 4);
  });
});

test('DocumentHeader edits the title through setTitle, reverts on Escape and stays read-only when asked', async () => {
  await withDom(async (h) => {
    const editor = everyBlock();
    const results: boolean[] = [], titles: string[] = [];
    const Header = (props: Partial<Parameters<typeof DocumentHeader>[0]> = {}): ReactNode => <DocumentHeader document={editor.getSnapshot()} editor={editor} onResult={(result) => results.push(result.ok)} onTitleChange={(title) => titles.push(title)} now={Date.parse(at) + 120_000} {...props} />;
    await h.render(<Header />);
    const input = must<HTMLInputElement>(h.container, 'h1 input');
    assert.equal(input.value, 'Every block'); assert.equal(input.getAttribute('aria-label'), 'Document title'); assert.equal(input.maxLength, 1000);
    assert.match(text(h.container, '.se-doc-meta'), /Revision \d+.*Updated 2 minutes ago.*\d+ words/);
    await act(async () => { input.focus(); });
    await h.type(input, 'A better title');
    await keydown(h, input, { key: 'Enter' });
    assert.equal(editor.getSnapshot().title, 'A better title');
    assert.deepEqual(results, [true]); assert.deepEqual(titles, ['A better title']);
    const revision = editor.getRevisions().at(-1)!;
    assert.deepEqual(revision.operations, [{ type: 'setTitle', title: 'A better title' }]); assert.equal(revision.actor.kind, 'human');
    await h.render(<Header />);
    assert.equal(must<HTMLInputElement>(h.container, 'h1 input').value, 'A better title', 'follows the document');
    // Escape reverts the draft.
    const again = must<HTMLInputElement>(h.container, 'h1 input');
    await act(async () => { again.focus(); });
    await h.type(again, 'Throwaway');
    await keydown(h, again, { key: 'Escape' });
    assert.equal(must<HTMLInputElement>(h.container, 'h1 input').value, 'A better title'); assert.equal(editor.getSnapshot().title, 'A better title');
    // An empty or unchanged title is ignored.
    await act(async () => { again.focus(); });
    await h.type(again, '   '); await act(async () => { again.blur(); });
    assert.equal(editor.getSnapshot().title, 'A better title'); assert.equal(must<HTMLInputElement>(h.container, 'h1 input').value, 'A better title');
    // Read-only renders a plain heading.
    await h.render(<Header editable={false} meta={<span className="extra">Equity</span>} actions={<button type="button">Export</button>} />);
    assert.equal(h.container.querySelector('input'), null); assert.equal(text(h.container, 'h1'), 'A better title');
    assert.equal(text(h.container, '.extra'), 'Equity'); assert.equal(text(h.container, '.se-doc-actions button'), 'Export');
    // Without an editor the host decides what to do.
    await h.render(<DocumentHeader document={editor.getSnapshot()} onTitleChange={(title) => titles.push(title)} />);
    const loose = must<HTMLInputElement>(h.container, 'h1 input');
    await act(async () => { loose.focus(); }); await h.type(loose, 'Host saved'); await act(async () => { loose.blur(); });
    assert.equal(titles.at(-1), 'Host saved'); assert.equal(editor.getSnapshot().title, 'A better title');
    await h.render(<DocumentHeader document={editor.getSnapshot()} />);
    assert.equal(h.container.querySelector('input'), null, 'no editor and no callback means read-only');
  });
});

test('CitationHoverCard shows the source on hover and focus, dismisses on Escape, and only links safe URLs', async () => {
  await withDom(async (h) => {
    const citation: Citation = { id: 's', title: 'Source <b>', url: 'https://www.example.com/a', accessedAt: at, publishedAt: at };
    await h.render(<CitationHoverCard citationId="s" number={3} citation={citation} />);
    const marker = must(h.container, 'sup.se-citation');
    assert.equal(text(marker, 'a.se-citation-link'), '[3]'); assert.equal(marker.querySelector('a.se-citation-link')!.getAttribute('href'), '#cite-s');
    assert.equal(marker.querySelector('a.se-citation-link')!.getAttribute('aria-label'), 'Source 3');
    const card = must<HTMLElement>(marker, '[role="tooltip"]');
    assert.equal(marker.querySelector('a.se-citation-link')!.getAttribute('aria-describedby'), card.id);
    assert.equal(text(card, 'strong'), 'Source <b>'); assert.equal(text(card, '.se-citation-card-host'), 'example.com');
    assert.equal(all(card, 'time').length, 2); assert.equal(card.querySelector('a')!.getAttribute('href'), 'https://www.example.com/a');
    await keydown(h, marker, { key: 'Escape' });
    assert.equal(card.style.display, 'none');
    await act(async () => { marker.dispatchEvent(new h.dom.window.MouseEvent('mouseover', { bubbles: true })); marker.dispatchEvent(new h.dom.window.FocusEvent('focusin', { bubbles: true })); });
    assert.notEqual(card.style.display, 'none', 'focus brings it back');
    await h.render(<CitationHoverCard citationId="s" number={1} citation={{ ...citation, url: 'javascript:alert(1)' }} />);
    assert.equal(all(h.container, '[role="tooltip"] a').length, 0, 'unsafe URLs get no link');
    await h.render(<CitationHoverCard citationId="gone" number={0} citation={undefined} />);
    assert.equal(text(h.container, 'a.se-citation-link'), '[?]'); assert.equal(h.container.querySelector('[role="tooltip"]'), null);
    await h.render(<CitationHoverCard citationId="s" number={2} citation={citation}>†</CitationHoverCard>);
    assert.equal(text(h.container, 'a.se-citation-link'), '†');
  });
});

test('LabelsProvider gives every panel one set of strings', async () => {
  await withDom(async (h) => {
    await h.render(<LabelsProvider labels={{ outline: { title: '大綱' }, save: { saving: '儲存中…' }, history: { title: '版本紀錄' }, skeleton: { loading: '載入中' } }}>
      <Outline document={everyBlock().getSnapshot()} /><SaveIndicator state="saving" /><RevisionHistory revisions={[]} /><DocumentSkeleton />
    </LabelsProvider>);
    assert.equal(text(h.container, '.se-outline .se-panel-title'), '大綱'); assert.equal(text(h.container, '.se-save'), '儲存中…');
    assert.equal(text(h.container, '.se-history .se-panel-title'), '版本紀錄'); assert.equal(text(h.container, '.se-skeleton-document .se-sr'), '載入中');
    await h.render(<LabelsProvider labels={{ save: { saving: 'A' } }}><SaveIndicator state="saving" labels={{ save: { saving: 'B' } }} /></LabelsProvider>);
    assert.equal(text(h.container, '.se-save'), 'B', 'a component-level override beats the provider');
  });
});

test('panels render on the server without a DOM', () => {
  const editor = everyBlock();
  const html = renderToStaticMarkup(<>
    <Outline document={editor.getSnapshot()} /><StatusBar document={editor.getSnapshot()} save={{ state: 'saved' }} /><DocumentHeader document={editor.getSnapshot()} editor={editor} />
    <RevisionHistory revisions={editor.getRevisions()} now={Date.parse(at)} /><DocumentSkeleton /><EmptyDocumentState onInsert={() => undefined} />
  </>);
  for (const marker of ['se-outline', 'se-status-bar', 'se-doc-header', 'se-history', 'se-skeleton-document', 'se-empty-state']) assert.ok(html.includes(marker), marker);
  assert.equal(manyParagraphs(2).getSnapshot().blocks.length, 2);
});
