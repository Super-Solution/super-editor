import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { b, createDocument, createEditor, toHTML, toMarkdown, toPlainText, validateTransaction } from '@supersolutions/super-editor-core';
import type { Editor } from '@supersolutions/super-editor-core';
import { mountEditor, releaseCards, renderDocument, type CardMount, type CardMountContext } from '@supersolutions/super-editor-ui';
import { ReportView } from '@supersolutions/super-editor-react';
import { actor, apply, withDom } from './helpers/dom.js';

const at = '2026-11-22T00:00:00.000Z';
const plotSpec = { spec: { marks: [{ type: 'line', x: [1, 2], y: [3, 4] }] } };

function document(): Editor {
  const editor = createEditor(createDocument({ id: 'cards', title: 'Cards' }, { now: () => at }), { now: () => at });
  apply(editor, [
    { type: 'insertBlock', block: b.card('plot', 'super.plot', plotSpec, 'Revenue rose from 3 to 4.', { title: 'Revenue' }) },
    { type: 'insertBlock', block: b.card('other', 'acme.map', {}, 'Offices in Taipei and Tokyo.') },
  ]);
  return editor;
}

/** A mount that records what the document told it, and draws a marker. */
function recorder(): { mount: CardMount; calls: { spec: unknown; context: CardMountContext }[]; updates: unknown[]; destroyed: number } {
  const state = { calls: [] as { spec: unknown; context: CardMountContext }[], updates: [] as unknown[], destroyed: 0 };
  const mount: CardMount = (container, spec, context) => {
    state.calls.push({ spec, context });
    container.append(container.ownerDocument.createElement('canvas'));
    return { update: (next) => { state.updates.push(next); }, destroy: () => { state.destroyed++; } };
  };
  return Object.assign(state, { mount });
}

test('a card block is validated as data: namespaced kind, JSON spec, required alt text', () => {
  const tx = (content: unknown) => validateTransaction({ id: 't', actor, baseRevision: 0, operations: [{ type: 'insertBlock', block: { id: 'c', parentId: null, citationIds: [], content } }] });
  assert.equal(tx({ type: 'card', kind: 'super-chart.chart', spec: { feed: { id: 'BTC' } }, alt: 'BTC price.' }).ok, true);
  const issue = (content: unknown) => { const result = tx(content); assert.equal(result.ok, false); return result.ok ? undefined : result.issues[0]; };
  assert.match(issue({ type: 'card', kind: 'plot', spec: {}, alt: 'a' })?.message ?? '', /namespaced/);
  assert.equal(issue({ type: 'card', kind: 'super.plot', spec: {}, alt: '' })?.path, 'transaction.operations[0].block.content.alt');
  assert.equal(issue({ type: 'card', kind: 'super.plot', spec: { kind: 'super-chart.chart' }, alt: 'a' })?.path, 'transaction.operations[0].block.content.spec.kind');
  assert.equal(issue({ type: 'card', kind: 'super.plot', spec: { a: [1, { b: Number.POSITIVE_INFINITY }] }, alt: 'a' })?.path, 'transaction.operations[0].block.content.spec.a[1].b');
  assert.match(issue({ type: 'card', kind: 'super.plot', spec: { a: new Date(0) }, alt: 'a' })?.message ?? '', /plain object/);
  assert.match(issue({ type: 'card', kind: 'super.plot', spec: { text: 'half \ud83d' }, alt: 'a' })?.message ?? '', /unpaired surrogate/);
});

test('exports show a card as its title and alt text, escaped', () => {
  const editor = createEditor(createDocument({ id: 'x', title: 'X' }, { now: () => at }), { now: () => at });
  apply(editor, [{ type: 'insertBlock', block: b.card('c', 'super.plot', {}, '# not *a* heading <b>', { title: 'A & B' }) }]);
  const report = editor.getSnapshot();
  assert.match(toMarkdown(report), /\*\*A & B\*\*\n\n\\# not \\\*a\\\* heading \\<b>/);
  assert.match(toHTML(report), /<figure id="c" class="card" data-kind="super\.plot"><figcaption>A &amp; B<\/figcaption><p># not \*a\* heading &lt;b&gt;<\/p><\/figure>/);
  assert.match(toPlainText(report), /A & B\n# not \*a\* heading <b>/);
});

test('DOM: a card with a mount is drawn live with placement "document"; others show their text', () => {
  const dom = new JSDOM('<!doctype html>');
  const plot = recorder();
  const view = renderDocument(document().getSnapshot(), { document: dom.window.document, theme: 'dark', locale: 'zh-TW', cardMounts: { 'super.plot': plot.mount } });
  const live = view.querySelector('[data-block-id="plot"] figure.se-card')!;
  assert.equal(live.getAttribute('data-state'), 'live');
  assert.ok(live.querySelector('.se-card-mount canvas'));
  assert.equal(live.querySelector('figcaption')?.textContent, 'Revenue');
  assert.equal(live.querySelector('.se-card-alt')?.textContent, 'Revenue rose from 3 to 4.', 'kept for print and screen readers');
  assert.deepEqual(plot.calls, [{ spec: { ...plotSpec, kind: 'super.plot' }, context: { theme: 'dark', placement: 'document', locale: 'zh-TW' } }]);
  const text = view.querySelector('[data-block-id="other"] figure.se-card')!;
  assert.equal(text.getAttribute('data-state'), 'text');
  assert.equal(text.querySelector('.se-card-mount'), null);
  assert.equal(text.textContent, 'Offices in Taipei and Tokyo.');
  releaseCards(view); releaseCards(view);
  assert.equal(plot.destroyed, 1, 'released once');
});

test('DOM: a mount that throws leaves the alt text and reports the error', () => {
  const dom = new JSDOM('<!doctype html>');
  const errors: string[] = [];
  const view = renderDocument(document().getSnapshot(), { document: dom.window.document, cardMounts: { 'super.plot': () => { throw new Error('no canvas'); } }, onRenderError: (error, block) => errors.push(`${block.id}: ${(error as Error).message}`) });
  const card = view.querySelector('[data-block-id="plot"] figure.se-card')!;
  assert.equal(card.getAttribute('data-state'), 'text');
  assert.equal(card.querySelector('.se-card-alt')?.textContent, 'Revenue rose from 3 to 4.');
  assert.doesNotMatch(card.textContent ?? '', /no canvas/);
  assert.deepEqual(errors, ['plot: no canvas']);
});

test('mountEditor destroys card mounts when it re-renders and when it is destroyed', () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>');
  const plot = recorder(), editor = document();
  const mounted = mountEditor(dom.window.document.getElementById('app')!, editor, { document: dom.window.document, cardMounts: { 'super.plot': plot.mount } });
  assert.equal(plot.calls.length, 1);
  apply(editor, [{ type: 'setTitle', title: 'Renamed' }]);
  assert.equal(plot.calls.length, 2); assert.equal(plot.destroyed, 1);
  mounted.destroy();
  assert.equal(plot.destroyed, 2);
});

test('React: a card mounts once, updates in place when its spec changes, and is destroyed on unmount', async () => {
  const plot = recorder(), editor = document();
  await withDom(async ({ render, container }) => {
    await render(<ReportView document={editor.getSnapshot()} cardMounts={{ 'super.plot': plot.mount }} theme="light" />);
    assert.equal(plot.calls.length, 1);
    assert.equal(plot.calls[0]!.context.placement, 'document');
    assert.ok(container.querySelector('[data-block-id="plot"] .se-card-mount canvas'));
    const block = editor.getSnapshot().blocks.find((entry) => entry.id === 'plot')!;
    apply(editor, [{ type: 'updateBlock', blockId: 'plot', expectedVersion: block.version, content: { type: 'card', kind: 'super.plot', spec: { spec: { marks: [] } }, alt: 'Flat.' } }]);
    await render(<ReportView document={editor.getSnapshot()} cardMounts={{ 'super.plot': plot.mount }} theme="light" />);
    assert.equal(plot.calls.length, 1, 'not remounted');
    assert.deepEqual(plot.updates, [{ spec: { marks: [] }, kind: 'super.plot' }]);
    await render(<p>gone</p>);
    assert.equal(plot.destroyed, 1);
  });
});

test('React server output matches the DOM fallback for a card without a mount', () => {
  const html = renderToStaticMarkup(<ReportView document={document().getSnapshot()} />);
  assert.match(html, /<figure class="super-editor-card se-card" data-kind="super\.plot" data-state="text"><figcaption class="se-card-title">Revenue<\/figcaption><p class="se-card-alt">Revenue rose from 3 to 4\.<\/p><\/figure>/);
});
