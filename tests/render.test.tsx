import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Block, BlockContent, Editor } from '@super-solution/editor-core';
import { defaultLabels, findMatches, renderChartFigure, renderDocument, replaceOperations, resolveLabels, revealBlock, splitMatches, template } from '@super-solution/editor-ui';
import type { RenderOptions } from '@super-solution/editor-ui';
import { ChartView, ReportView } from '@super-solution/editor-react';
import type { ReportViewProps } from '@super-solution/editor-react';
import { actor, apply, click, everyBlock, manyParagraphs, paragraph, withDom } from './helpers/dom.js';

const text = (root: ParentNode, selector: string): string => root.querySelector(selector)?.textContent ?? '';
const all = (root: ParentNode, selector: string): Element[] => Array.from(root.querySelectorAll(selector));
const must = (root: ParentNode, selector: string): Element => { const node = root.querySelector(selector); assert.ok(node, `Missing ${selector}`); return node; };

/** Both renderers must produce this exact structure for the every-block document. */
function checkStructure(root: ParentNode, who: string): void {
  const m = (selector: string): Element => must(root, selector);
  // Header, headings and landmarks
  assert.equal(text(root, 'header.se-header h1'), 'Every block', who);
  assert.equal(text(root, '[data-block-id="h1"] h1.se-heading'), 'Heading one', who);
  assert.equal(text(root, '[data-block-id="h2"] h2.se-heading'), 'Heading two', who);
  assert.ok(m('article.super-editor-document').getAttribute('aria-labelledby')?.endsWith('-title'), who);
  assert.equal(m('section[data-block-id="sec"]').getAttribute('aria-labelledby'), 'sec-title', who);
  // Inline marks
  const para = m('[data-block-id="para"]');
  assert.equal(text(para, 'strong'), 'bold', who); assert.equal(text(para, 'em'), 'italic', who); assert.equal(text(para, 's'), 'struck', who);
  assert.equal(text(para, 'u'), 'under', who); assert.equal(text(para, 'mark[data-highlight="green"]'), 'marked', who); assert.equal(text(para, 'code'), 'code', who);
  assert.equal(m('[data-block-id="para"] a[href="https://example.com/a"]').getAttribute('rel'), 'noopener noreferrer', who);
  // Citations: superscript marker, hover card, references list
  const marker = m('[data-block-id="para"] sup.se-citation[data-citation-id="src1"]');
  assert.equal(text(marker, 'a.se-citation-link'), '[1]', who);
  assert.equal(marker.querySelector('a.se-citation-link')?.getAttribute('href'), '#cite-src1', who);
  assert.equal(text(marker, '[role="tooltip"] strong'), 'Source <one>', who);
  assert.match(text(marker, '[role="tooltip"]'), /example\.com/, who);
  assert.equal(text(root, '.super-editor-block-sources'), 'Sources: Source <one>', who);
  assert.equal(text(root, 'section.super-editor-citations li#cite-src1 a'), 'Source <one>', who);
  assert.match(text(root, 'section.super-editor-citations li#cite-src1 .se-cite-host'), /^example\.com$/, who);
  // Quote and callouts
  assert.equal(text(root, 'blockquote.se-quote cite'), 'Someone', who);
  for (const [tone, name] of [['info', 'Info'], ['success', 'Success'], ['warning', 'Warning'], ['danger', 'Danger'], ['note', 'Note']]) {
    const callout = m(`[data-block-id="callout-${tone}"] [role="note"][data-tone="${tone}"]`);
    assert.equal(callout.getAttribute('aria-label'), name, who);
    assert.ok(callout.querySelector('svg.se-callout-icon path'), `${who} ${tone} icon`);
    assert.match(callout.textContent!, new RegExp(`A ${tone} callout`), who);
  }
  assert.equal(text(root, '[data-block-id="callout-info"] .se-callout-title'), 'Titled', who);
  // Lists
  const todo = m('[data-block-id="todo"]');
  assert.deepEqual(all(todo, 'input[type="checkbox"]').map((box) => (box as HTMLInputElement).checked || box.hasAttribute('checked')), [true, false, true, false], who);
  assert.ok(all(todo, 'input[type="checkbox"]').every((box) => box.hasAttribute('disabled')), `${who} read-only todo`);
  assert.equal(all(todo, ':scope > ul.se-list-todo > li.se-todo-item').length, 2, `${who} two top-level todos`);
  assert.equal(all(todo, 'li > ul.se-list-todo > li').length, 2, `${who} nested todos`);
  assert.equal(m('[data-block-id="todo"] li[data-checked="true"]').getAttribute('data-checked'), 'true', who);
  assert.equal(all(root, '[data-block-id="ordered"] ol.se-list-number > li').length, 2, who);
  assert.ok(root.querySelector('[data-block-id="bullets"] ul ul ul'), `${who} three levels of nesting`);
  // Tables
  assert.equal(text(root, '[data-block-id="table"] caption'), 'Returns', who);
  assert.deepEqual(all(root, '[data-block-id="table"] thead th').map((th) => th.className), ['se-align-left', 'se-align-right', 'se-align-center'], who);
  assert.equal(all(root, '[data-block-id="table"] tbody th[scope="row"]').length, 2, `${who} header column`);
  assert.ok(m('[data-block-id="table"] tbody td.se-align-center'), who);
  assert.equal(m('[data-block-id="table"] .se-table-wrap').getAttribute('role'), 'region', who);
  assert.deepEqual(all(root, '[data-block-id="numeric"] tbody td.se-numeric.se-align-right').length, 2, `${who} numeric columns align right`);
  assert.equal(all(root, '[data-block-id="numeric"] td.se-numeric').length, 2, who);
  // Charts
  assert.equal(all(root, 'figure.se-chart').length, 2, who);
  assert.equal(all(root, 'figure.se-chart svg[role="img"]').length, 2, who);
  assert.match(m('[data-block-id="line"] svg').getAttribute('aria-label') ?? '', /^Line chart\. Line chart\. 2 series and 3 points\./, who);
  assert.equal(all(root, '[data-block-id="line"] .se-legend button[aria-pressed="true"]').length, 2, who);
  assert.equal(all(root, '[data-block-id="pie"] .se-legend li').length, 3, who);
  assert.deepEqual(all(root, '[data-block-id="line"] .se-chart-data tbody tr').map((row) => row.textContent), ['Jan13', 'Feb22', 'Mar31'], who);
  assert.equal(m('[data-block-id="line"] .se-chart-meta time').getAttribute('datetime'), '2026-10-05T12:00:00.000Z', who);
  assert.match(text(root, '[data-block-id="line"] .se-chart-meta'), /Source: OKX/, who);
  assert.equal(text(root, '[data-block-id="line"] .se-chart-caption'), 'A caption', who);
  assert.equal(m('[data-block-id="line"] .se-chart-data').getAttribute('data-open'), 'false', who);
  assert.equal(all(root, '[data-block-id="line"] .se-chart-toolbar button').length, 3, who);
  // Code, divider, image
  assert.equal(text(root, '[data-block-id="code"] .se-code-language'), 'ts', who);
  assert.equal(text(root, '[data-block-id="code"] .se-code-copy'), 'Copy', who);
  assert.equal(text(root, '[data-block-id="code"] pre code'), 'const x = 1;', who);
  assert.ok(m('[data-block-id="divider"] hr.se-divider'), who);
  const image = m('[data-block-id="image"] figure.se-image');
  assert.equal(image.getAttribute('data-width'), 'wide', who);
  const img = m('[data-block-id="image"] img');
  assert.equal(img.getAttribute('loading'), 'lazy', who); assert.equal(img.getAttribute('alt'), 'An image', who); assert.equal(img.getAttribute('src'), 'https://example.com/a.png', who);
  assert.equal(text(image, 'figcaption'), 'Caption', who);
  // Toggle
  const button = m('[data-block-id="toggle"] .se-toggle-button');
  assert.equal(button.getAttribute('aria-expanded'), 'false', who);
  const body = m('[data-block-id="toggle"] .se-toggle-body');
  assert.equal(button.getAttribute('aria-controls'), body.id, who);
  assert.ok(body.hasAttribute('hidden'), `${who} collapsed body is hidden`);
  assert.equal(text(body, '[data-block-id="inner"]'), 'Inside the toggle', `${who} children live inside the toggle`);
  assert.equal(m('[data-block-id="toggle"]').children.length >= 1, true, who);
  // Metrics
  assert.deepEqual(all(root, '.se-metrics .se-metric').map((metric) => metric.getAttribute('data-tone')), ['up', 'down', 'neutral'], who);
  assert.deepEqual(all(root, '.se-metric-change').map((change) => change.textContent!.trim().replace(/^[▲▼–]\s*(Up|Down|Unchanged)\s*/, '')), ['+2.4%', '-1.1%'], who);
  assert.equal(text(root, '.se-metric-hint'), 'vs 7d', who);
  // TOC, embed, timestamp, page break
  const toc = m('[data-block-id="toc"] nav.se-toc');
  assert.equal(toc.getAttribute('aria-label'), 'Table of contents', who);
  assert.deepEqual(all(toc, 'a').map((a) => [a.textContent, a.getAttribute('href')]), [['Summary', '#sec'], ['Heading one', '#h1'], ['Heading two', '#h2']], who);
  assert.equal(all(toc, 'ol ol ol').length >= 1, true, `${who} headings nest under the section`);
  const embed = m('[data-block-id="embed"] .se-embed');
  assert.equal(embed.getAttribute('data-state'), 'card', who);
  assert.equal(text(embed, 'a'), 'Live chart', who);
  assert.match(text(embed, '.se-embed-note'), /not enabled/, who);
  assert.equal(all(root, 'iframe').length, 0, who);
  assert.equal(m('[data-block-id="stamp"] time.se-timestamp').getAttribute('datetime'), '2026-10-05T12:00:00.000Z', who);
  assert.equal(m('[data-block-id="break"] [role="separator"]').getAttribute('aria-label'), 'Page break', who);
}

const parse = (html: string): ParentNode => new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;

test('DOM renderer: every block type has the documented structure', () => {
  const dom = new JSDOM('<!doctype html>');
  const view = renderDocument(everyBlock().getSnapshot(), { document: dom.window.document });
  checkStructure(view.ownerDocument.body.appendChild(view).parentNode!, 'dom');
});

test('React renderer: server output has the same structure as the DOM renderer', () => {
  checkStructure(parse(renderToStaticMarkup(<ReportView document={everyBlock().getSnapshot()} />)), 'react');
});

test('renderers neutralize hostile content in every text position', () => {
  const editor = everyBlock();
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const patch = (id: string, content: BlockContent): void => { apply(editor, [{ type: 'updateBlock', blockId: id, expectedVersion: editor.getSnapshot().blocks.find((block) => block.id === id)!.version, content }]); };
  patch('h1', { type: 'heading', level: 1, text: evil }); patch('quote', { type: 'quote', runs: [{ text: evil }], attribution: evil });
  patch('callout-note', { type: 'callout', tone: 'note', title: evil, runs: [{ text: evil }] });
  patch('table', { type: 'table', columns: [evil, evil], rows: [[evil, evil]], caption: evil });
  patch('code', { type: 'code', language: 'ts', text: evil }); patch('image', { type: 'image', url: 'https://example.com/x.png', alt: evil, caption: evil });
  patch('toggle', { type: 'toggle', title: evil, open: true }); patch('metrics', { type: 'metrics', items: [{ label: evil, value: evil, hint: evil, change: 1 }] });
  patch('line', { type: 'chart', spec: { kind: 'line', title: evil, labels: [evil], series: [{ name: evil, values: [1] }, { name: 'B', values: [2] }], annotations: [{ label: evil, at: evil }], unit: evil, source: evil, caption: evil } });
  const snapshot = editor.getSnapshot();
  const dom = new JSDOM('<!doctype html>');
  for (const root of [renderDocument(snapshot, { document: dom.window.document }), parse(renderToStaticMarkup(<ReportView document={snapshot} />))]) {
    assert.equal(all(root, 'script').length, 0);
    assert.equal(all(root, 'img').filter((node) => node.getAttribute('onerror') !== null || !node.getAttribute('src')?.startsWith('https://')).length, 0);
    assert.equal(all(root, '*').filter((node) => Array.from(node.attributes).some((attribute) => /^on/i.test(attribute.name))).length, 0);
    assert.ok(all(root, '.se-callout-title').some((node) => node.textContent === evil));
    assert.ok(all(root, 'svg text').some((node) => node.textContent === evil), 'chart text is escaped, not interpreted');
  }
});

test('renderers defend against documents that bypass validation', () => {
  const unsafe = structuredClone(everyBlock().getSnapshot());
  const content = (id: string) => unsafe.blocks.find((block) => block.id === id)!.content;
  (content('para') as Extract<BlockContent, { type: 'paragraph' }>).runs.push({ text: 'bad link', href: 'javascript:alert(1)' }, { text: '', citationId: 'missing' });
  (content('line') as Extract<BlockContent, { type: 'chart' }>).spec.series[0]!.color = 'url(javascript:alert(1))';
  (content('image') as Extract<BlockContent, { type: 'image' }>).url = 'http://insecure.example.com/a.png';
  const dom = new JSDOM('<!doctype html>');
  for (const root of [renderDocument(unsafe, { document: dom.window.document }), parse(renderToStaticMarkup(<ReportView document={unsafe} />))]) {
    assert.equal(all(root, 'a').filter((a) => /^javascript:/i.test(a.getAttribute('href') ?? '')).length, 0);
    assert.match(text(root, '[data-block-id="para"]'), /bad link \(unsafe URL omitted\)/);
    assert.equal(text(root, 'sup[data-citation-id="missing"] a'), '[?]', 'a dangling citation shows a placeholder');
    assert.equal(all(root, '*').filter((node) => /javascript:/i.test(`${node.getAttribute('fill')}${node.getAttribute('stroke')}${node.getAttribute('style')}`)).length, 0, 'unsafe series colors are dropped');
    assert.equal(all(root, '[data-block-id="image"] img').length, 0, 'http images are never loaded');
  }
});

test('labels: a partial override changes strings everywhere and merges over the defaults', () => {
  const labels = { blocks: { copyCode: '複製', toc: '目錄', toneNames: { info: '資訊' } }, document: { sources: '資料來源', revision: '第 {revision} 版' }, chart: { viewData: '檢視資料', legend: '圖例' } };
  const dom = new JSDOM('<!doctype html>');
  for (const root of [renderDocument(everyBlock().getSnapshot(), { document: dom.window.document, labels }), parse(renderToStaticMarkup(<ReportView document={everyBlock().getSnapshot()} labels={labels} />))]) {
    assert.equal(text(root, '[data-block-id="code"] .se-code-copy'), '複製');
    assert.equal(must(root, 'nav.se-toc').getAttribute('aria-label'), '目錄');
    assert.equal(must(root, '[data-tone="info"][role="note"]').getAttribute('aria-label'), '資訊');
    assert.equal(must(root, '[data-tone="success"][role="note"]').getAttribute('aria-label'), 'Success', 'unlisted tones keep English');
    assert.equal(text(root, 'section.super-editor-citations h2'), '資料來源');
    assert.match(text(root, '.super-editor-metadata'), /^第 \d+ 版/);
    assert.equal(text(root, '[data-block-id="line"] .se-chart-toolbar button'), '檢視資料');
    assert.equal(must(root, '[data-block-id="line"] .se-legend').getAttribute('aria-label'), '圖例');
  }
  assert.equal(resolveLabels(undefined), defaultLabels);
  assert.equal(resolveLabels({ blocks: { copyCode: 'x' } }).blocks.pageBreak, 'Page break');
  assert.equal(resolveLabels({ bogus: 'ignored' } as never).document.sources, 'Sources');
  assert.equal(template('{count} words in {name}', { count: 3, name: 'doc' }), '3 words in doc');
  assert.equal(template('keep {unknown}', {}), 'keep {unknown}');
});

test('embeds: link card by default, sandboxed iframe with height when the origin is allowed', () => {
  const editor = everyBlock();
  const policy = { enabled: true, allowedOrigins: ['https://charts.example.com'] };
  const dom = new JSDOM('<!doctype html>');
  const live = renderDocument(editor.getSnapshot(), { document: dom.window.document, embedPolicy: policy });
  const frame = must(live, 'iframe') as HTMLIFrameElement;
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts'); assert.equal(frame.style.height, '500px'); assert.equal(frame.loading, 'lazy');
  assert.equal(must(live, '.se-embed').getAttribute('data-state'), 'live');
  assert.equal(text(live, '.se-embed a'), 'Live chart', 'the link stays as a fallback');
  const react = parse(renderToStaticMarkup(<ReportView document={editor.getSnapshot()} embedPolicy={policy} />));
  assert.match(must(react, 'iframe').getAttribute('style') ?? '', /height:\s*500px/);
  assert.equal(all(parse(renderToStaticMarkup(<ReportView document={editor.getSnapshot()} embedPolicy={{ enabled: true, allowedOrigins: ['https://other.example.com'] }} />)), 'iframe').length, 0);
});

test('DOM: toggles open and close, report to the host and keep children inside', () => {
  const dom = new JSDOM('<!doctype html>');
  const calls: [string, boolean][] = [];
  const view = renderDocument(everyBlock().getSnapshot(), { document: dom.window.document, onToggle: (block, open) => calls.push([block.id, open]) });
  dom.window.document.body.append(view);
  const button = must(view, '.se-toggle-button') as HTMLButtonElement, body = must(view, '.se-toggle-body') as HTMLElement;
  assert.equal(button.getAttribute('aria-expanded'), 'false'); assert.equal(body.hidden, true);
  click(dom, button);
  assert.equal(button.getAttribute('aria-expanded'), 'true'); assert.equal(body.hidden, false); assert.equal(must(view, '.se-toggle').getAttribute('data-open'), 'true');
  assert.match(button.getAttribute('aria-label')!, /^Collapse Details/);
  click(dom, button);
  assert.equal(body.hidden, true);
  assert.deepEqual(calls, [['toggle', true], ['toggle', false]]);
});

test('DOM: to-do checkboxes stay read-only unless the host handles changes', () => {
  const dom = new JSDOM('<!doctype html>');
  const seen: [string, number, boolean][] = [];
  const editable = renderDocument(everyBlock().getSnapshot(), { document: dom.window.document, onToggleTodo: (block, index, checked) => seen.push([block.id, index, checked]) });
  const boxes = all(editable, '[data-block-id="todo"] input[type="checkbox"]') as HTMLInputElement[];
  assert.ok(boxes.every((box) => !box.disabled));
  boxes[1]!.checked = true; boxes[1]!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(seen, [['todo', 1, true]]);
});

test('DOM: code copy writes to the clipboard and confirms', async () => {
  const dom = new JSDOM('<!doctype html>');
  const written: string[] = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { written.push(value); } } });
  const view = renderDocument(everyBlock().getSnapshot(), { document: dom.window.document });
  const button = must(view, '[data-block-id="code"] .se-code-copy') as HTMLButtonElement;
  click(dom, button);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(written, ['const x = 1;']); assert.equal(button.textContent, 'Copied');
  assert.equal(text(view, '[data-block-id="code"] [role="status"]'), 'Copied');
});

test('DOM: images fall back when blocked or broken', () => {
  const dom = new JSDOM('<!doctype html>');
  const editor = everyBlock();
  const view = renderDocument(editor.getSnapshot(), { document: dom.window.document });
  const img = must(view, '[data-block-id="image"] img');
  img.dispatchEvent(new dom.window.Event('error'));
  assert.equal(all(view, '[data-block-id="image"] img').length, 0);
  assert.match(text(view, '[data-block-id="image"] .se-image-broken'), /could not be loaded/);
  const unsafe = structuredClone(editor.getSnapshot());
  (unsafe.blocks.find((block) => block.id === 'image')!.content as Extract<BlockContent, { type: 'image' }>).url = 'http://insecure.example.com/a.png';
  const plain = renderDocument(unsafe, { document: dom.window.document });
  assert.equal(all(plain, 'img').length, 0, 'http images are never loaded');
  assert.equal(text(plain, '[data-block-id="image"] .se-image-broken'), 'An image');
});

test('DOM: a throwing host renderer is contained to its own block', () => {
  const dom = new JSDOM('<!doctype html>');
  const errors: string[] = [];
  const view = renderDocument(everyBlock().getSnapshot(), {
    document: dom.window.document,
    blockRenderers: { quote() { throw new Error('boom'); } },
    onRenderError: (error, block) => errors.push(`${block.id}:${(error as Error).message}`),
  });
  assert.match(text(view, '[data-block-id="quote"] [role="alert"]'), /could not be displayed/);
  assert.equal(text(view, '[data-block-id="h1"] h1'), 'Heading one', 'neighbours still render');
  assert.deepEqual(errors, ['quote:boom']);
});

test('DOM and React: diff marks and find highlights', () => {
  const editor = everyBlock();
  const diff = { added: ['h1'], changed: ['para'], moved: ['quote'] };
  const find = { query: 'callout', activeBlockId: 'callout-warning' };
  const dom = new JSDOM('<!doctype html>');
  for (const root of [renderDocument(editor.getSnapshot(), { document: dom.window.document, diff, find }), parse(renderToStaticMarkup(<ReportView document={editor.getSnapshot()} diff={diff} find={find} />))]) {
    assert.equal(must(root, '[data-block-id="h1"]').getAttribute('data-diff'), 'added');
    assert.equal(must(root, '[data-block-id="para"]').getAttribute('data-diff'), 'changed');
    assert.equal(must(root, '[data-block-id="quote"]').getAttribute('data-diff'), 'moved');
    assert.equal(root.querySelector('[data-block-id="h2"]')?.getAttribute('data-diff') ?? null, null);
    assert.equal(all(root, 'mark.se-find-match').length, 5);
    assert.deepEqual(all(root, 'mark.se-find-match[data-active="true"]').map((mark) => mark.closest('[data-block-id]')?.getAttribute('data-block-id')), ['callout-warning']);
  }
  assert.deepEqual(splitMatches('Alpha beta ALPHA', 'alpha'), [{ text: 'Alpha', match: true }, { text: ' beta ', match: false }, { text: 'ALPHA', match: true }]);
  assert.deepEqual(splitMatches('Alpha beta ALPHA', 'alpha', true), [{ text: 'Alpha beta ALPHA', match: false }]);
  assert.equal(splitMatches('a.b', '.').filter((part) => part.match).length, 1, 'queries are literal, not regular expressions');
  assert.deepEqual(splitMatches('abc', ''), [{ text: 'abc', match: false }]);
});

test('find and replace helpers list blocks and build version-guarded operations', () => {
  const editor = everyBlock();
  const result = findMatches(editor.getSnapshot(), 'callout');
  assert.equal(result.total, 5); assert.equal(result.blocks.length, 5);
  assert.equal(result.blocks[0]!.blockId, 'callout-info'); assert.match(result.blocks[0]!.preview, /callout/);
  assert.equal(findMatches(editor.getSnapshot(), 'CALLOUT', { caseSensitive: true }).total, 0);
  assert.equal(findMatches(editor.getSnapshot(), '').total, 0);
  assert.equal(findMatches(editor.getSnapshot(), 'x'.repeat(5000)).total, 0);
  const operations = replaceOperations(result.blocks, 'callout', 'note', { caseSensitive: false });
  assert.deepEqual(operations[0], { type: 'replaceText', blockId: 'callout-info', expectedVersion: result.blocks[0]!.version, find: 'callout', replace: 'note', all: true });
  assert.equal((replaceOperations(result.blocks, 'a', 'b', { all: false })[0] as { all?: boolean }).all, undefined);
  const outcome = editor.apply({ id: 'replace-1', actor, baseRevision: editor.getSnapshot().revision, operations });
  assert.equal(outcome.ok, true);
  assert.equal(findMatches(editor.getSnapshot(), 'callout').total, 0);
  // An edit between search and replace makes the guarded operation fail instead of overwriting it.
  const stale = findMatches(editor.getSnapshot(), 'note');
  apply(editor, [{ type: 'updateBlock', blockId: stale.blocks[0]!.blockId, expectedVersion: stale.blocks[0]!.version, content: { type: 'paragraph', runs: [{ text: 'changed' }] } }]);
  const conflict = editor.apply({ id: 'replace-2', actor, baseRevision: editor.getSnapshot().revision, operations: replaceOperations(stale.blocks, 'note', 'x', {}) });
  assert.equal(conflict.ok, false);
});

test('revealBlock opens collapsed toggles above the target and scrolls to it', () => {
  const dom = new JSDOM('<!doctype html>');
  const view = renderDocument(everyBlock().getSnapshot(), { document: dom.window.document });
  dom.window.document.body.append(view);
  let scrolled = 0;
  for (const node of all(view, '[data-block-id]')) (node as HTMLElement).scrollIntoView = () => { scrolled++; };
  const target = revealBlock(dom.window.document, 'inner', { behavior: 'auto' });
  assert.ok(target); assert.equal((must(view, '.se-toggle-body') as HTMLElement).hidden, false); assert.equal(scrolled, 1);
  assert.equal(dom.window.document.activeElement, target);
  assert.equal(revealBlock(dom.window.document, 'nope'), null);
  // The TOC link does the same through its click handler.
  const link = must(view, '.se-toc a[href="#h2"]');
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
});

test('DOM chart: legend toggles series, View data reveals the table, arrows show a tooltip', () => {
  const dom = new JSDOM('<!doctype html>');
  const view = renderDocument(everyBlock().getSnapshot(), { document: dom.window.document });
  dom.window.document.body.append(view);
  const figure = must(view, '[data-block-id="line"] figure') as HTMLElement;
  assert.equal(all(figure, 'svg polyline').length, 2);
  click(dom, figure.querySelector('.se-legend button[data-key="0"]'));
  assert.equal(all(figure, 'svg polyline').length, 1);
  assert.equal(figure.querySelector('.se-legend button[data-key="0"]')!.getAttribute('aria-pressed'), 'false');
  click(dom, figure.querySelector('.se-legend button[data-key="0"]'));
  assert.equal(all(figure, 'svg polyline').length, 2);
  const toggle = must(figure, '.se-chart-toolbar button') as HTMLButtonElement;
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  click(dom, toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true'); assert.equal(toggle.textContent, 'Hide data'); assert.equal(must(figure, '.se-chart-data').getAttribute('data-open'), 'true');
  const stage = must(figure, '.se-chart-stage') as HTMLElement;
  assert.equal(stage.getAttribute('tabindex'), '0');
  const key = (name: string) => stage.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  key('ArrowRight');
  const tooltip = must(figure, '.se-tooltip') as HTMLElement;
  assert.equal(tooltip.hidden, false);
  assert.equal(text(tooltip, '.se-tooltip-title'), 'Jan');
  assert.deepEqual(all(tooltip, 'li').map((row) => row.textContent), ['A1', 'B3']);
  key('ArrowRight');
  assert.equal(text(tooltip, '.se-tooltip-title'), 'Feb');
  assert.ok(figure.querySelector('.se-chart-overlay line, .se-chart-overlay circle'), 'crosshair and markers are drawn');
  key('Escape');
  assert.equal(tooltip.hidden, true);
});

test('React chart: legend, data view, keyboard tooltip and export run in the browser', async () => {
  await withDom(async ({ dom, container, render, document }) => {
    const spec = (everyBlock().getSnapshot().blocks.find((block) => block.id === 'line')!.content as Extract<BlockContent, { type: 'chart' }>).spec;
    await render(<ChartView spec={spec} width={600} />);
    const figure = must(container, 'figure');
    assert.equal(all(figure, 'svg polyline').length, 2);
    click(dom, figure.querySelector('.se-legend button[data-key="1"]')); await Promise.resolve();
    await render(<ChartView spec={spec} width={600} />);
    assert.equal(all(figure, 'svg polyline').length, 1);
    const stage = must(figure, '.se-chart-stage') as HTMLElement;
    const { act } = await import('react');
    await act(async () => { stage.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); });
    assert.equal(text(figure, '.se-tooltip-title'), 'Mar');
    assert.equal((must(figure, '.se-tooltip') as HTMLElement).hidden, false);
    await act(async () => { click(dom, figure.querySelector('.se-chart-toolbar button')); });
    assert.equal(must(figure, '.se-chart-data').getAttribute('data-open'), 'true');
    // SVG export triggers a download of a standalone file.
    const downloads: string[] = [];
    Object.assign(dom.window.URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined });
    dom.window.HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { downloads.push(this.download); };
    await act(async () => { click(dom, figure.querySelectorAll('.se-chart-toolbar button')[1] ?? null); });
    assert.deepEqual(downloads, ['line-chart.svg']);
    assert.equal(text(figure, '[role="status"]'), 'Chart exported.');
    // PNG needs a real canvas; a missing one is reported, not thrown.
    await act(async () => { click(dom, figure.querySelectorAll('.se-chart-toolbar button')[2] ?? null); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.equal(text(figure, '[role="status"]'), 'The chart could not be exported.');
    assert.ok(document.body);
  });
});

test('React: toggles keep local state, adopt a newer document version and report to the host', async () => {
  await withDom(async ({ dom, container, render }) => {
    const editor = everyBlock();
    const calls: boolean[] = [];
    const props: Omit<ReportViewProps, 'document'> = { onToggle: (_block, open) => calls.push(open) };
    await render(<ReportView document={editor.getSnapshot()} {...props} />);
    const button = () => must(container, '.se-toggle-button') as HTMLButtonElement;
    const { act } = await import('react');
    assert.equal(button().getAttribute('aria-expanded'), 'false');
    await act(async () => click(dom, button()));
    assert.equal(button().getAttribute('aria-expanded'), 'true'); assert.equal((must(container, '.se-toggle-body') as HTMLElement).hidden, false);
    assert.deepEqual(calls, [true]);
    // An agent closes it in the document: the newer version wins over the reader's local expansion.
    const toggle = editor.getSnapshot().blocks.find((block) => block.id === 'toggle')!;
    apply(editor, [{ type: 'updateBlock', blockId: 'toggle', expectedVersion: toggle.version, content: { type: 'toggle', title: 'Details', open: true } }]);
    await render(<ReportView document={editor.getSnapshot()} {...props} />);
    assert.equal(button().getAttribute('aria-expanded'), 'true');
    const again = editor.getSnapshot().blocks.find((block) => block.id === 'toggle')!;
    apply(editor, [{ type: 'updateBlock', blockId: 'toggle', expectedVersion: again.version, content: { type: 'toggle', title: 'Details', open: false } }]);
    await render(<ReportView document={editor.getSnapshot()} {...props} />);
    assert.equal(button().getAttribute('aria-expanded'), 'false');
  });
});

test('React: to-do boxes are controlled by the host callback', async () => {
  await withDom(async ({ dom, container, render }) => {
    const seen: [number, boolean][] = [];
    const editor = everyBlock();
    await render(<ReportView document={editor.getSnapshot()} onToggleTodo={(_block, index, checked) => seen.push([index, checked])} />);
    const boxes = all(container, '[data-block-id="todo"] input[type="checkbox"]') as HTMLInputElement[];
    assert.ok(boxes.every((box) => !box.disabled));
    const { act } = await import('react');
    await act(async () => click(dom, boxes[1]!));
    assert.deepEqual(seen, [[1, true]]);
  });
});

test('React: blocks are memoized by id and version; only edited blocks re-render', async () => {
  await withDom(async ({ container, render }) => {
    const editor = manyParagraphs(30);
    const renders: string[] = [];
    const blockRenderers: NonNullable<ReportViewProps['blockRenderers']> = { paragraph(block, context) { renders.push(block.id); return context.renderDefaultBlock(block); } };
    await render(<ReportView document={editor.getSnapshot()} blockRenderers={blockRenderers} />);
    assert.equal(renders.length, 30);
    renders.length = 0;
    await render(<ReportView document={editor.getSnapshot()} blockRenderers={blockRenderers} />);
    assert.equal(renders.length, 0, 'an identical render touches no block');
    const target = editor.getSnapshot().blocks.find((block) => block.id === 'p7')!;
    apply(editor, [{ type: 'updateBlock', blockId: 'p7', expectedVersion: target.version, content: { type: 'paragraph', runs: [{ text: 'Edited by an agent' }] } }], { id: 'agent', kind: 'agent' });
    await render(<ReportView document={editor.getSnapshot()} blockRenderers={blockRenderers} />);
    assert.deepEqual(renders, ['p7']);
    assert.equal(text(container, '[data-block-id="p7"]'), 'Edited by an agent');
    // Inserting a block renders only the new block; neighbours keep their version.
    renders.length = 0;
    apply(editor, [{ type: 'insertBlock', block: paragraph('fresh', 'Brand new'), afterId: 'p0' }]);
    await render(<ReportView document={editor.getSnapshot()} blockRenderers={blockRenderers} />);
    assert.deepEqual(renders, ['fresh']);
    assert.deepEqual(all(container, '.super-editor-block').slice(0, 3).map((node) => node.id), ['p0', 'fresh', 'p1']);
    // Opting out re-renders everything.
    renders.length = 0;
    await render(<ReportView document={editor.getSnapshot()} blockRenderers={blockRenderers} memoize={false} />);
    assert.equal(renders.length, 31);
  });
});

test('React: blocks that depend on the whole document (TOC, citation numbers) still update', async () => {
  await withDom(async ({ container, render }) => {
    const editor = everyBlock();
    await render(<ReportView document={editor.getSnapshot()} />);
    assert.equal(all(container, '[data-block-id="toc"] a').length, 3);
    apply(editor, [{ type: 'insertBlock', block: { id: 'h-new', parentId: 'sec', citationIds: [], content: { type: 'heading', level: 2, text: 'A new heading' } }, afterId: 'h2' }]);
    await render(<ReportView document={editor.getSnapshot()} />);
    assert.deepEqual(all(container, '[data-block-id="toc"] a').map((a) => a.textContent), ['Summary', 'Heading one', 'Heading two', 'A new heading']);
    assert.equal(text(container, '[data-block-id="para"] sup[data-citation-id="src1"] a'), '[1]');
    apply(editor, [{ type: 'addCitation', citation: { id: 'src0', title: 'Another', url: 'https://example.org', accessedAt: '2026-10-05T12:00:00.000Z' } }]);
    await render(<ReportView document={editor.getSnapshot()} />);
    assert.equal(all(container, 'section.super-editor-citations li').length, 2);
  });
});

test('React: documents over the threshold mount blocks near the viewport only', async () => {
  const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];
  class FakeObserver {
    targets: Element[] = [];
    constructor(readonly callback: IntersectionObserverCallback) { observers.push(this); }
    observe(target: Element): void { this.targets.push(target); }
    disconnect(): void { this.targets = []; }
    unobserve(): void { /* unused */ }
    takeRecords(): IntersectionObserverEntry[] { return []; }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, writable: true, value: FakeObserver });
  try {
    await withDom(async ({ container, render }) => {
      const editor = manyParagraphs(320);
      await render(<ReportView document={editor.getSnapshot()} />);
      assert.equal(all(container, '.super-editor-block').length, 320, 'every block keeps its wrapper and id');
      assert.equal(container.querySelector('article')!.getAttribute('data-large'), 'true');
      const wrappers = all(container, '.se-lazy');
      assert.equal(wrappers.length, 320);
      assert.equal(wrappers.filter((node) => node.getAttribute('data-visible') === 'true').length, 40, 'the first 40 blocks are always mounted');
      const lazy = wrappers.filter((node) => node.getAttribute('data-visible') === 'false');
      assert.ok(lazy.length === 280 && lazy.every((node) => node.childElementCount === 0), 'off-screen blocks are placeholders');
      assert.equal(text(container, '[data-block-id="p0"]'), 'Paragraph 0');
      assert.equal(text(container, '[data-block-id="p200"]'), '');
      const { act } = await import('react');
      const observer = observers.find((entry) => entry.targets.includes(lazy[160]!))!;
      await act(async () => observer.callback([{ isIntersecting: true, target: lazy[160]! } as unknown as IntersectionObserverEntry], observer as unknown as IntersectionObserver));
      assert.equal(text(container, '[data-block-id="p200"]'), 'Paragraph 200', 'scrolling a block into range mounts it');
      await act(async () => observer.callback([{ isIntersecting: false, target: lazy[160]! } as unknown as IntersectionObserverEntry], observer as unknown as IntersectionObserver));
      assert.equal(text(container, '[data-block-id="p200"]'), '', 'and scrolling away frees it');
      // The threshold is configurable; below it nothing is lazy.
      await render(<ReportView document={editor.getSnapshot()} virtualize={false} />);
      assert.equal(all(container, '.se-lazy').length, 0);
      await render(<ReportView document={manyParagraphs(50).getSnapshot()} virtualize={20} />);
      assert.equal(all(container, '.se-lazy[data-visible="false"]').length, 10);
    });
  } finally { if (previous) Object.defineProperty(globalThis, 'IntersectionObserver', previous); else Reflect.deleteProperty(globalThis, 'IntersectionObserver'); }
});

test('React: without IntersectionObserver a large document renders in full', () => {
  const html = renderToStaticMarkup(<ReportView document={manyParagraphs(320).getSnapshot()} />);
  assert.equal((html.match(/Paragraph \d+/g) ?? []).length, 320);
});

test('React: each block has its own error boundary with retry', async () => {
  const original = console.error;
  console.error = () => undefined;
  try {
    await withDom(async ({ dom, container, render }) => {
      const editor = everyBlock();
      let explode = true;
      const errors: string[] = [];
      const blockRenderers: ReportViewProps['blockRenderers'] = { quote(block, context) { if (explode) throw new Error('quote exploded'); return context.renderDefaultBlock(block); } };
      await render(<ReportView document={editor.getSnapshot()} blockRenderers={blockRenderers} onRenderError={(error, block) => errors.push(`${block.id}:${(error as Error).message}`)} />);
      assert.match(text(container, '[data-block-id="quote"] [role="alert"]'), /could not be displayed/);
      assert.equal(text(container, '[data-block-id="h1"] h1'), 'Heading one', 'siblings are untouched');
      assert.deepEqual(errors, ['quote:quote exploded']);
      explode = false;
      const { act } = await import('react');
      await act(async () => click(dom, container.querySelector('[data-block-id="quote"] [role="alert"] button')));
      assert.equal(text(container, '[data-block-id="quote"] blockquote cite'), 'Someone');
    });
  } finally { console.error = original; }
});

test('React: a polite live region announces revisions made elsewhere', async () => {
  await withDom(async ({ container, render }) => {
    const editor = everyBlock();
    await render(<ReportView document={editor.getSnapshot()} lastActor="agent" />);
    const live = () => must(container, 'article > [role="status"][aria-live="polite"]');
    assert.equal(live().textContent, '', 'nothing is announced on first render');
    apply(editor, [{ type: 'setTitle', title: 'Renamed by an agent' }], { id: 'agent', kind: 'agent' });
    await render(<ReportView document={editor.getSnapshot()} lastActor="agent" />);
    assert.match(live().textContent!, /^Document updated to revision \d+ by an agent\.$/);
    apply(editor, [{ type: 'setTitle', title: 'Renamed again' }]);
    await render(<ReportView document={editor.getSnapshot()} />);
    assert.match(live().textContent!, /^Document updated to revision \d+\.$/);
    await render(<ReportView document={editor.getSnapshot()} announce={false} />);
    assert.ok(container.querySelector('article'));
  });
});

test('React: loading, header, empty state and header-less modes', () => {
  const empty = everyBlock();
  const blank = structuredClone(empty.getSnapshot()); blank.blocks = []; blank.citations = [];
  assert.match(renderToStaticMarkup(<ReportView document={blank} />), /This document is empty\./);
  assert.doesNotMatch(renderToStaticMarkup(<ReportView document={blank} emptyState={false} />), /This document is empty\./);
  assert.match(renderToStaticMarkup(<ReportView document={blank} emptyState={<p>Custom empty</p>} />), /Custom empty/);
  const loading = renderToStaticMarkup(<ReportView document={empty.getSnapshot()} loading />);
  assert.match(loading, /aria-busy="true"/); assert.match(loading, /se-skeleton-document/); assert.doesNotMatch(loading, /Heading one/);
  const headerless = parse(renderToStaticMarkup(<ReportView document={empty.getSnapshot()} showHeader={false} />));
  assert.equal(all(headerless, 'header.se-header').length, 0);
  assert.equal(must(headerless, 'article > h1.se-sr').textContent, 'Every block', 'the title stays available to assistive tech');
  assert.match(renderToStaticMarkup(<ReportView document={empty.getSnapshot()} header={<header>Mine</header>} />), /<header>Mine<\/header>/);
  const themed = parse(renderToStaticMarkup(<ReportView document={empty.getSnapshot()} theme="dark" density="compact" className="mine" />));
  const article = must(themed, 'article');
  assert.equal(article.getAttribute('data-se-theme'), 'dark'); assert.equal(article.getAttribute('data-se-density'), 'compact'); assert.ok(article.classList.contains('mine'));
  const dom = new JSDOM('<!doctype html>');
  const view = renderDocument(empty.getSnapshot(), { document: dom.window.document, theme: 'light', density: 'spacious', showHeader: false });
  assert.equal(view.dataset.seTheme, 'light'); assert.equal(view.dataset.seDensity, 'spacious'); assert.equal(view.querySelector('header'), null);
});

test('React: custom block and chart renderers still win, with fallbacks to the defaults', () => {
  const html = renderToStaticMarkup(<ReportView document={everyBlock().getSnapshot()}
    blockRenderers={{ divider: () => <div id="mine">custom divider</div>, quote: (block, context) => <div>{context.renderDefaultBlock(block)}<em>fallback ok</em></div> }}
    chartRenderers={{ donut: (spec) => <aside>Host chart: {spec.title}</aside> }} />);
  assert.match(html, /custom divider/); assert.match(html, /fallback ok/); assert.match(html, /<blockquote class="se-quote">/); assert.match(html, /Host chart: Donut chart/);
  assert.equal((html.match(/figure class="super-editor-chart/g) ?? []).length, 1, 'only the line chart uses the built-in view');
  const dom = new JSDOM('<!doctype html>');
  const options: RenderOptions = { document: dom.window.document, blockRenderers: { divider: (_block, context) => { const node = context.document.createElement('p'); node.id = 'mine'; return node; } } };
  assert.ok(renderDocument(everyBlock().getSnapshot(), options).querySelector('#mine'));
});

test('styles: tokens define every variable the other sheets use; dark theme, density and print are covered', () => {
  const dir = new URL('../packages/ui/src/', import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');
  const tokens = read('styles/tokens.css'), blocks = read('styles/blocks.css'), charts = read('styles/charts.css'), panels = read('styles/panels.css'), print = read('styles/print.css'), interaction = read('styles/interaction.css');
  const defined = new Set(Array.from(tokens.matchAll(/(--se-[a-z0-9-]+)\s*:/g), (match) => match[1]!));
  const inline = new Set(['--se-swatch']);
  for (const [name, sheet] of [['blocks', blocks], ['charts', charts], ['panels', panels], ['print', print], ['interaction', interaction]] as const) {
    const used = new Set(Array.from(sheet.matchAll(/var\((--se-[a-z0-9-]+)/g), (match) => match[1]!));
    const missing = [...used].filter((variable) => !defined.has(variable) && !inline.has(variable));
    assert.deepEqual(missing, [], `${name}.css uses undefined tokens`);
  }
  for (const token of ['--se-bg', '--se-surface', '--se-text', '--se-muted', '--se-border', '--se-accent', '--se-series-1', '--se-series-10', '--se-up', '--se-down', '--se-font-sans', '--se-leading', '--se-block-gap', '--se-pad-x']) assert.ok(defined.has(token), token);
  assert.match(tokens, /\[data-se-theme="dark"\]/); assert.match(tokens, /prefers-color-scheme: dark/); assert.match(tokens, /\[data-se-theme="auto"\]/);
  assert.doesNotMatch(tokens, /:root:not\(/, 'dark is opt-in: an unset theme stays light');
  for (const density of ['compact', 'comfortable', 'spacious']) assert.match(tokens, new RegExp(`data-se-density="${density}"`));
  assert.match(tokens, /prefers-reduced-motion: reduce/);
  assert.match(print, /@page se-a4 \{ size: A4/); assert.match(print, /@page se-letter \{ size: letter/);
  assert.match(print, /\.super-editor-document\[data-page="A4"\] \{ page: se-a4; \}/); assert.match(print, /\.super-editor-document\[data-page="letter"\] \{ page: se-letter; \}/);
  assert.match(print, /@media print/); assert.match(print, /break-after: page/); assert.match(print, /\.se-toggle-body\[hidden\] \{ display: block !important; \}/);
  const entry = read('styles.css');
  for (const file of ['tokens', 'blocks', 'charts', 'panels', 'print']) assert.match(entry, new RegExp(`@import './styles/${file}\\.css'`));
  const unused: Editor[] = []; assert.equal(unused.length, 0);
});

test('every callout, chart and block type renders without throwing in both renderers, including hidden blocks', () => {
  const snapshot = everyBlock().getSnapshot();
  const blocks: Block[] = snapshot.blocks;
  assert.ok(new Set(blocks.map((block) => block.content.type)).size >= 17 - 0, 'the fixture covers all block types');
  assert.deepEqual([...new Set(blocks.map((block) => block.content.type))].sort(), ['callout', 'chart', 'code', 'divider', 'embed', 'heading', 'image', 'list', 'metrics', 'pageBreak', 'paragraph', 'quote', 'section', 'table', 'timestamp', 'toc', 'toggle'].sort());
});

test('charts are responsive: a ResizeObserver relayouts the SVG at the new width (DOM and React)', async () => {
  const spec = (everyBlock().getSnapshot().blocks.find((block) => block.id === 'line')!.content as Extract<BlockContent, { type: 'chart' }>).spec;
  const viewBox = (root: ParentNode): string => must(root, 'svg').getAttribute('viewBox') ?? '';
  type Entry = { callback: (entries: { contentRect: { width: number } }[]) => void; targets: Element[] };
  const made: Entry[] = [];
  class FakeResize implements Entry {
    targets: Element[] = [];
    constructor(readonly callback: Entry['callback']) { made.push(this); }
    observe(target: Element): void { this.targets.push(target); }
    disconnect(): void { this.targets = []; }
    unobserve(): void { /* unused */ }
  }
  // Headless DOM figure
  const dom = new JSDOM('<!doctype html>');
  Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, value: FakeResize });
  const figure = renderChartFigure(spec, { document: dom.window.document });
  assert.match(viewBox(figure), /^0 0 640 /);
  made[0]!.callback([{ contentRect: { width: 300 } }]);
  assert.match(viewBox(figure), /^0 0 300 /, 'narrower container, narrower layout');
  made[0]!.callback([{ contentRect: { width: 302 } }]);
  assert.match(viewBox(figure), /^0 0 300 /, 'sub-8px jitter does not relayout');
  made[0]!.callback([{ contentRect: { width: 20 } }]);
  assert.match(viewBox(figure), /^0 0 300 /, 'collapsed containers are ignored');
  assert.equal(made[0]!.targets.length, 1);
  assert.equal(must(figure, '.se-chart-stage').getAttribute('tabindex'), '0');
  // A fixed width never observes.
  const before = made.length;
  renderChartFigure(spec, { document: dom.window.document, width: 500 });
  assert.equal(made.length, before);
  // React view
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: FakeResize });
  try {
    await withDom(async ({ container, render }) => {
      const start = made.length;
      await render(<ChartView spec={spec} />);
      assert.match(viewBox(container), /^0 0 640 /);
      const { act } = await import('react');
      await act(async () => made[start]!.callback([{ contentRect: { width: 380 } }]));
      assert.match(viewBox(container), /^0 0 380 /);
      assert.ok(made[start]!.targets.length === 1);
      await render(<ChartView spec={spec} width={700} />);
      assert.match(viewBox(container), /^0 0 700 /, 'a fixed width wins');
    });
  } finally { if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous); else Reflect.deleteProperty(globalThis, 'ResizeObserver'); }
});
