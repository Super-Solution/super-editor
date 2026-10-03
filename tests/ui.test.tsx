import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDocument, createEditor } from '@super-editor/core';
import type { BlockContent, ChartSpec, Editor, Operation } from '@super-editor/core';
import { allowedEmbedUrl, getChartModel, mountEditor, renderDocument } from '@super-editor/ui';
import type { RenderContext } from '@super-editor/ui';
import { ReportEditor, ReportView } from '@super-editor/react';

const at = '2026-10-03T12:00:00.000Z';
let transactionNumber = 0;
const actor = { id: 'test-human', kind: 'human' as const };
function apply(editor: Editor, operations: Operation[]) {
  const result = editor.apply({ id: `test-${++transactionNumber}`, actor, baseRevision: editor.getSnapshot().revision, operations });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  return result;
}
function fixture(): Editor {
  const editor = createEditor(createDocument({ id: 'sample-report', title: '<script>alert(1)</script> Research' }, { now: () => at }), { now: () => at });
  const blocks: { id: string; parentId: string | null; content: BlockContent; citationIds: string[] }[] = [
    { id: 'section', parentId: null, content: { type: 'section', title: 'Macro section' }, citationIds: [] },
    { id: 'heading', parentId: 'section', content: { type: 'heading', level: 3, text: 'H3 view' }, citationIds: [] },
    { id: 'summary', parentId: 'section', content: { type: 'paragraph', runs: [{ text: '<img src=x onerror=alert(1)>', bold: true, italic: true, href: 'https://example.com/research' }] }, citationIds: ['source'] },
    { id: 'pie', parentId: 'section', content: { type: 'chart', spec: { kind: 'pie', title: 'Portfolio allocation', labels: ['Equity', 'Cash'], series: [{ name: 'Weight', values: [60, 40] }], unit: '%', asOf: at } }, citationIds: [] },
    { id: 'bar', parentId: null, content: { type: 'chart', spec: { kind: 'bar', title: 'Returns', labels: ['A', 'B'], series: [{ name: 'Return', values: [-2, 4] }] } }, citationIds: [] },
    { id: 'trend', parentId: null, content: { type: 'chart', spec: { kind: 'trend', title: 'Rates', labels: ['Q1', 'Q2'], series: [{ name: 'Rate', values: [3, 4] }] } }, citationIds: [] },
    { id: 'custom', parentId: null, content: { type: 'chart', spec: { kind: 'constructor', title: 'Extension', labels: ['A'], series: [{ name: 'Value', values: [1] }] } }, citationIds: [] },
    { id: 'embed', parentId: null, content: { type: 'embed', provider: 'superchart', title: 'SuperChart report', url: 'https://charts.example.com/report/1' }, citationIds: [] },
    { id: 'stamp', parentId: null, content: { type: 'timestamp', at, label: 'Data checked' }, citationIds: [] },
  ];
  apply(editor, [{ type: 'addCitation', citation: { id: 'source', title: '<b>Source</b>', url: 'https://example.com/source', accessedAt: at, publishedAt: at } }, ...blocks.map((block): Operation => ({ type: 'insertBlock', block }))]);
  return editor;
}

test('DOM view preserves section hierarchy, formatting, literal text, sources and accessible chart data', () => {
  const dom = new JSDOM('<!doctype html>');
  const view = renderDocument(fixture().getSnapshot(), { document: dom.window.document, chartRenderers: {} });
  assert.equal(view.querySelectorAll('script,img').length, 0);
  assert.match(view.querySelector('h1')!.textContent!, /<script>alert\(1\)<\/script>/);
  assert.equal(view.querySelector('[data-block-id="summary"] strong em')!.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(view.querySelector('[data-block-id="section"] [data-block-id="heading"] h3')!.textContent, 'H3 view');
  assert.equal(view.querySelector('#section')!.getAttribute('data-block-type'), 'section');
  assert.equal(view.querySelectorAll('svg[role="img"]').length, 3);
  assert.match(view.querySelector('[data-block-id="pie"] table')!.textContent!, /Equity60Cash40/);
  assert.match(view.querySelector('[data-block-id="custom"]')!.textContent!, /No renderer registered/);
  assert.equal(view.querySelectorAll('iframe').length, 0);
  assert.equal(view.querySelector('[data-citation-id="source"] a')!.textContent, '<b>Source</b>');
  assert.equal(view.querySelector('[data-citation-id="source"] time')!.getAttribute('datetime'), at);
  assert.equal(view.dataset.page, 'screen');
});

test('embeds require explicit HTTPS exact-origin permission and retain restricted iframe attributes', () => {
  assert.equal(allowedEmbedUrl('https://charts.example.com/report/1'), null);
  const policy = { enabled: true, allowedOrigins: ['https://charts.example.com'] };
  assert.equal(allowedEmbedUrl('https://charts.example.com.evil.test/report/1', policy), null);
  assert.equal(allowedEmbedUrl('https://charts.example.com:444/report/1', policy), null);
  assert.equal(allowedEmbedUrl('http://charts.example.com/report/1', policy), null);
  assert.equal(allowedEmbedUrl('https://user:password@charts.example.com/report/1', policy), null);
  assert.equal(allowedEmbedUrl('https://charts.example.com/report/1', { enabled: true, allowedOrigins: ['https://charts.example.com/path'] }), null);
  const dom = new JSDOM('<!doctype html>');
  const view = renderDocument(fixture().getSnapshot(), { document: dom.window.document, embedPolicy: policy });
  const iframe = view.querySelector('iframe')!;
  assert.equal(iframe.src, 'https://charts.example.com/report/1');
  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(iframe.referrerPolicy, 'no-referrer');
  assert.equal(iframe.loading, 'lazy');
});

test('view defends dangerous links even when a host bypasses core validation', () => {
  const report = structuredClone(fixture().getSnapshot());
  const paragraph = report.blocks.find((block) => block.id === 'summary')!;
  paragraph.content = { type: 'paragraph', runs: [{ text: 'Dangerous', href: 'javascript:alert(1)' }] };
  report.citations[0]!.url = 'data:text/html,<script>alert(1)</script>';
  const dom = new JSDOM('<!doctype html>');
  const view = renderDocument(report, { document: dom.window.document });
  assert.equal(view.querySelector('[data-block-id="summary"] a'), null);
  assert.equal(view.querySelector('[data-citation-id="source"] a'), null);
  const html = renderToStaticMarkup(<ReportView document={report} />);
  assert.doesNotMatch(html, /href="(?:javascript|data):/);
  assert.match(html, /unsafe URL omitted/);
});

test('block and chart registries replace selected renderers without inherited lookup', () => {
  const dom = new JSDOM('<!doctype html>');
  let charts = 0;
  const view = renderDocument(fixture().getSnapshot(), {
    document: dom.window.document,
    blockRenderers: { heading(block, context) { const node = context.document.createElement('aside'); node.textContent = block.id; return node; } },
    chartRenderers: { constructor(spec: ChartSpec, context: RenderContext) { charts++; const node = context.document.createElement('div'); node.textContent = `Custom ${spec.title}`; return node; } },
  });
  assert.equal(charts, 1);
  assert.equal(view.querySelector('[data-block-id="heading"] aside')!.textContent, 'heading');
  assert.equal(view.querySelector('[data-block-id="custom"]')!.textContent, 'Custom Extension');
  const html = renderToStaticMarkup(<ReportView document={fixture().getSnapshot()} chartRenderers={{}} blockRenderers={{ heading: (block) => <aside>{block.id}</aside> }} />);
  assert.match(html, /<aside>heading<\/aside>/);
  assert.match(html, /No renderer registered/);
});

test('chart geometry keeps extreme finite values finite and unsupported kinds keep data fallback', () => {
  for (const kind of ['bar', 'trend']) {
    const model = getChartModel({ kind, title: 'Extremes', labels: ['Low', 'High'], series: [{ name: 'Value', values: [-Number.MAX_VALUE, Number.MAX_VALUE] }] });
    assert.ok(model.shapes.length);
    assert.doesNotMatch(JSON.stringify(model.shapes), /NaN|Infinity/);
  }
  assert.match(getChartModel({ kind: 'pie', title: 'Overflow', labels: ['A', 'B'], series: [{ name: 'Value', values: [Number.MAX_VALUE, Number.MAX_VALUE] }] }).message!, /finite/);
  const dom = new JSDOM('<!doctype html>');
  const report = structuredClone(fixture().getSnapshot());
  (report.blocks.find((block) => block.id === 'custom')!.content as Extract<BlockContent, { type: 'chart' }>).spec.kind = 'toString';
  assert.match(renderDocument(report, { document: dom.window.document, chartRenderers: {} }).textContent!, /toString/);
});

function click(document: Document, scope: Element, label: string): void {
  const button = Array.from(scope.querySelectorAll('button')).find((node) => node.textContent === label);
  assert.ok(button, `Missing button ${label}`);
  button.dispatchEvent(new document.defaultView!.MouseEvent('click', { bubbles: true }));
}

test('DOM editor saves through guarded transactions, supports history and preserves conflicted/deleted drafts', () => {
  const dom = new JSDOM('<!doctype html><main></main>');
  const editor = fixture(), container = dom.window.document.querySelector('main')!;
  const mounted = mountEditor(container, editor);
  click(dom.window.document, container.querySelector('#summary')!, 'Edit paragraph');
  let textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit block summary"]')!;
  textarea.value = 'Local unsaved proposal';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  apply(editor, [{ type: 'updateBlock', blockId: 'summary', expectedVersion: editor.getSnapshot().blocks.find((block) => block.id === 'summary')!.version, content: { type: 'paragraph', runs: [{ text: 'Human changed current content' }] } }]);
  click(dom.window.document, container.querySelector('#summary')!, 'Save block');
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /changed|revision/i);
  assert.equal(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit block summary"]')!.value, 'Local unsaved proposal');
  assert.equal((editor.getSnapshot().blocks.find((block) => block.id === 'summary')!.content as Extract<BlockContent, { type: 'paragraph' }>).runs[0]!.text, 'Human changed current content');
  click(dom.window.document, container.querySelector('#summary')!, 'Discard draft');
  click(dom.window.document, container.querySelector('#summary')!, 'Edit paragraph');
  textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit block summary"]')!;
  textarea.value = 'Saved change'; textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  click(dom.window.document, container.querySelector('#summary')!, 'Save block');
  assert.equal(container.querySelectorAll('textarea').length, 0);
  const afterSave = editor.getSnapshot().revision;
  click(dom.window.document, container, 'Undo');
  assert.equal(editor.getSnapshot().revision, afterSave + 1);
  assert.match(container.querySelector('#summary')!.textContent!, /Human changed current content/);
  click(dom.window.document, container, 'Redo');
  assert.match(container.querySelector('#summary')!.textContent!, /Saved change/);
  click(dom.window.document, container.querySelector('#summary')!, 'Edit paragraph');
  textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit block summary"]')!;
  textarea.value = 'Keep after delete'; textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  apply(editor, [{ type: 'deleteBlock', blockId: 'summary', expectedVersion: editor.getSnapshot().blocks.find((block) => block.id === 'summary')!.version }]);
  assert.equal(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Deleted block draft summary"]')!.value, 'Keep after delete');
  mounted.destroy(); assert.equal(container.childElementCount, 0);
  apply(editor, [{ type: 'setTitle', title: 'After unmount' }]); assert.equal(container.childElementCount, 0);
});

test('DOM editor keeps a draft visible when an agent changes its block type', () => {
  const dom = new JSDOM('<!doctype html><main></main>'), editor = fixture();
  const container = dom.window.document.querySelector('main')!, mounted = mountEditor(container, editor);
  click(dom.window.document, container.querySelector('#summary')!, 'Edit paragraph');
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit block summary"]')!;
  textarea.value = 'Unsaved before type change'; textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  apply(editor, [{ type: 'updateBlock', blockId: 'summary', expectedVersion: editor.getSnapshot().blocks.find((block) => block.id === 'summary')!.version, content: { type: 'table', columns: ['Current'], rows: [['Agent replaced content']] } }]);
  assert.equal(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit block summary"]')!.value, 'Unsaved before type change');
  assert.match(container.querySelector('#summary')!.textContent!, /Agent replaced content/);
  click(dom.window.document, container.querySelector('#summary')!, 'Save block');
  assert.ok(container.querySelector('[role="alert"]'));
  assert.equal(editor.getSnapshot().blocks.find((block) => block.id === 'summary')!.content.type, 'table');
  mounted.destroy();
});

test('DOM editor adds H2/H3/sections and applies document format using core operations', () => {
  const dom = new JSDOM('<!doctype html><main></main>'), editor = fixture();
  const container = dom.window.document.querySelector('main')!, mounted = mountEditor(container, editor);
  for (const choice of ['heading2', 'heading3', 'section']) {
    const type = container.querySelector<HTMLSelectElement>('select[aria-label="New block type"]')!;
    type.value = choice; click(dom.window.document, container, 'Add block');
  }
  assert.ok(editor.getSnapshot().blocks.some((block) => block.content.type === 'heading' && block.content.level === 2));
  assert.ok(editor.getSnapshot().blocks.filter((block) => block.content.type === 'heading' && block.content.level === 3).length > 1);
  assert.equal(editor.getSnapshot().blocks.filter((block) => block.content.type === 'section').length, 2);
  const font = container.querySelector<HTMLSelectElement>('select[aria-label="Document font"]')!;
  font.value = 'serif'; font.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(editor.getSnapshot().format.font, 'serif');
  assert.equal(container.querySelector('article')!.getAttribute('data-font'), 'serif');
  mounted.destroy();
});

test('React view supports SSR with literal content, accessible charts, replaceable renderers and secure embeds', () => {
  const report = fixture().getSnapshot();
  const html = renderToStaticMarkup(<ReportView document={report} />);
  assert.doesNotMatch(html, /<script|<img|<iframe/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<svg[^>]+role="img"/);
  assert.match(html, /scope="row"/);
  assert.match(html, /id="section"/);
  const enabled = renderToStaticMarkup(<ReportView document={report} embedPolicy={{ enabled: true, allowedOrigins: ['https://charts.example.com'] }} chartRenderers={{ constructor: (spec: ChartSpec) => <aside>{spec.title}</aside> }} />);
  assert.match(enabled, /sandbox="allow-scripts"/);
  assert.match(enabled, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(enabled, /allow-same-origin/);
  assert.match(enabled, /<aside>Extension<\/aside>/);
  assert.match(renderToStaticMarkup(<ReportEditor editor={fixture()} renderControls={false} />), /Edit paragraph/);
});

test('React editor subscribes, preserves conflicting drafts and releases its subscription', async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://app.example.com' });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    const { createRoot } = await import('react-dom/client');
    const actual = fixture(); let activeSubscriptions = 0;
    const editor: Editor = { ...actual, subscribe(listener) { activeSubscriptions++; const unsubscribe = actual.subscribe(listener); return () => { activeSubscriptions--; unsubscribe(); }; } };
    const container = dom.window.document.getElementById('app')!, root = createRoot(container);
    await act(async () => root.render(<ReportEditor editor={editor} />));
    assert.equal(activeSubscriptions, 1);
    await act(async () => click(dom.window.document, container.querySelector('#summary')!, 'Edit paragraph'));
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit block summary"]')!;
    // Use the native setter so React observes the same value change as a browser user.
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(textarea, 'React local draft'); textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await act(async () => apply(editor, [{ type: 'updateBlock', blockId: 'summary', expectedVersion: editor.getSnapshot().blocks.find((block) => block.id === 'summary')!.version, content: { type: 'paragraph', runs: [{ text: 'External human change' }] } }]));
    await act(async () => click(dom.window.document, container.querySelector('#summary')!, 'Save block'));
    assert.ok(container.querySelector('[role="alert"]'));
    assert.equal(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit block summary"]')!.value, 'React local draft');
    assert.match(container.querySelector('#summary')!.textContent!, /External human change/);
    await act(async () => apply(editor, [{ type: 'updateBlock', blockId: 'summary', expectedVersion: editor.getSnapshot().blocks.find((block) => block.id === 'summary')!.version, content: { type: 'table', columns: ['Current'], rows: [['React agent replaced content']] } }]));
    assert.equal(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit block summary"]')!.value, 'React local draft');
    assert.match(container.querySelector('#summary')!.textContent!, /React agent replaced content/);

    const editorA = fixture();
    await act(async () => root.render(<ReportEditor editor={editorA} />));
    assert.equal(activeSubscriptions, 0);
    await act(async () => click(dom.window.document, container.querySelector('#summary')!, 'Edit paragraph'));
    const editorATextarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit block summary"]')!;
    await act(async () => { setter.call(editorATextarea, 'Editor A unsaved draft'); editorATextarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    const documentB = structuredClone(editorA.getSnapshot());
    documentB.blocks.find((block) => block.id === 'summary')!.content = { type: 'paragraph', runs: [{ text: 'Editor B original' }] };
    const editorB = createEditor(documentB, { now: () => at });
    await act(async () => root.render(<ReportEditor editor={editorB} />));
    assert.equal(container.querySelectorAll('textarea').length, 0, 'Drafts must be reset on editor identity change, even with matching revision/version/IDs.');
    assert.equal((editorB.getSnapshot().blocks.find((block) => block.id === 'summary')!.content as Extract<BlockContent, { type: 'paragraph' }>).runs[0]!.text, 'Editor B original');
    assert.match(container.querySelector('#summary')!.textContent!, /Editor B original/);
    await act(async () => root.unmount());
    assert.equal(activeSubscriptions, 0); assert.equal(container.childElementCount, 0);
  } finally {
    for (const key of keys) { const descriptor = descriptors.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
});
