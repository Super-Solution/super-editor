/*
 * Regressions a real host app hit when it adopted the editor: a stylesheet collision, unreadable heat-map labels, overlays trapped by an
 * ancestor's containment, and a CSS reset that stripped the document's own styles.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { b, createDocument, createEditor } from '@super-solution/editor-core';
import type { BlockInput, ChartSpec, Editor, Operation } from '@super-solution/editor-core';
import { renderChartFigure, renderDocument, setSelectionOffsets } from '@super-solution/editor-ui';
import { OverlayPortal, ReportEditor, ReportView, ToastProvider, useToasts } from '@super-solution/editor-react';
import type { ToastApi } from '@super-solution/editor-react';
import { withDom } from './helpers/dom.js';

const at = '2026-10-05T12:00:00.000Z';
const stylesDir = new URL('../packages/ui/src/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, stylesDir), 'utf8');
/** The published stylesheet is these imports inlined into one file (scripts/package-build.mjs); do the same here, so the test needs no build. */
function inlineCss(name: string): string {
  return read(name).replace(/@import\s+['"](\.[^'"]+\.css)['"]\s*;/g, (_all, path: string) => inlineCss(new URL(path, new URL(name, stylesDir)).href.slice(stylesDir.href.length)));
}
let counter = 0;
function seed(blocks: BlockInput[], before: Operation[] = []): Editor {
  const editor = createEditor(createDocument({ id: 'doc', title: 'Doc' }, { now: () => at }), { now: () => at });
  const result = editor.apply({ id: `host-seed-${++counter}`, actor: { id: 'h', kind: 'human' }, baseRevision: 0, operations: [...before, ...blocks.map((block) => ({ type: 'insertBlock' as const, block }))] });
  assert.equal(result.ok, true, JSON.stringify(result));
  return editor;
}
const line: ChartSpec = { kind: 'line', title: 'Line', labels: ['a', 'b', 'c'], series: [{ name: 'One', values: [1, 2, 3] }, { name: 'Two', values: [3, 2, 1] }] };
const heat: ChartSpec = {
  kind: 'heatmap', title: 'Heat', labels: ['a'], series: [{ name: 'a', values: [1] }],
  matrix: { rows: ['r1', 'r2'], columns: ['c1', 'c2', 'c3', 'c4'], values: [[-1, -.5, 0, .5], [1, .2, -.2, 0]] },
};

// ---- 1. Swatches --------------------------------------------------------------------------------------------------------------------

/** Style rules at the top level of a flat stylesheet (at-rules are skipped whole), as selector lists and declaration text. */
function topLevelRules(css: string): { selectors: string[]; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: { selectors: string[]; body: string }[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open < 0) break;
    const prelude = text.slice(index, open).trim();
    let depth = 1, end = open + 1;
    while (end < text.length && depth) { if (text[end] === '{') depth++; else if (text[end] === '}') depth--; end++; }
    if (!prelude.startsWith('@')) rules.push({ selectors: splitTopLevel(prelude), body: text.slice(open + 1, end - 1) });
    index = end;
  }
  return rules;
}
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(' || list[i] === '[') depth++;
    else if (list[i] === ')' || list[i] === ']') depth--;
    else if (list[i] === ',' && depth === 0) { parts.push(list.slice(from, i).trim()); from = i + 1; }
  }
  parts.push(list.slice(from).trim());
  return parts.filter(Boolean);
}
const classesOf = (css: string): Set<string> => new Set(Array.from(css.matchAll(/\.(se-[a-z0-9-]+)/g), (match) => match[1]!));

test('toolbar highlight swatches have their own classes: the chart legend and tooltip swatches share none with them', async () => {
  const interaction = read('styles/interaction.css'), charts = read('styles/charts.css');
  const toolbarClasses = new Set([...classesOf(interaction)].filter((name) => name.includes('swatch')));
  const chartClasses = new Set([...classesOf(charts)].filter((name) => name.includes('swatch')));
  assert.ok(toolbarClasses.size > 0 && chartClasses.size > 0);
  assert.deepEqual([...toolbarClasses].filter((name) => chartClasses.has(name)), [], 'no swatch class is styled by both the interaction layer and the charts');
  assert.deepEqual([...chartClasses], ['se-swatch']);

  // The same in the DOM the editor really produces: open the highlight palette, and put a chart with a legend and a tooltip next to it.
  await withDom(async ({ dom, document, container, render }) => {
    const editor = seed([b.paragraph('p', 'hello big world'), b.chart('c', line)]);
    await render(<ReportEditor editor={editor} commitDelayMs={0} renderControls={false} />);
    await act(async () => { container.querySelector('[data-block-id="p"] p')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    const field = container.querySelector<HTMLElement>('[data-se-editable]')!;
    await act(async () => { setSelectionOffsets(field, 6, 9); document.dispatchEvent(new dom.window.Event('selectionchange')); });
    await act(async () => { container.querySelector<HTMLElement>('[role="toolbar"] [aria-label="Highlight"]')!.click(); });
    const picked = [...container.querySelectorAll('.se-highlight-swatches button')];
    assert.equal(picked.length, 6, 'five highlight colors and "remove"');
    const stage = container.querySelector('.se-chart-stage')!;
    await act(async () => { stage.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true })); });
    const chartSwatches = [...container.querySelectorAll('.super-editor-chart .se-swatch')];
    assert.ok(chartSwatches.length >= 3, 'legend entries and the tooltip rows');
    const used = (nodes: Element[]): Set<string> => new Set(nodes.flatMap((node) => [...node.classList]));
    assert.deepEqual([...used(picked)].filter((name) => used(chartSwatches).has(name)), []);
    assert.ok(picked.every((node) => !node.classList.contains('se-swatch')));
    assert.ok(chartSwatches.every((node) => !node.classList.contains('se-highlight-swatch')));
  });
});

test('no interaction rule can match anything inside a chart (legend, tooltip, toolbar, data table), except the ones meant for every descendant', () => {
  const dom = new JSDOM('<!doctype html><div class="super-editor se-editor"><div class="se-surface"></div></div>');
  const surface = dom.window.document.querySelector('.se-surface')!;
  const editor = seed([b.paragraph('p', 'text'), b.chart('c', line), b.chart('h', heat)]);
  surface.append(renderDocument(editor.getSnapshot(), { document: dom.window.document }));
  for (const stage of surface.querySelectorAll('.se-chart-stage')) stage.dispatchEvent(new dom.window.Event('focus'));
  const charts = [...surface.querySelectorAll('.super-editor-chart')];
  assert.equal(charts.length, 2);
  const inside = charts.flatMap((chart) => [...chart.querySelectorAll('*')]);
  assert.ok(inside.some((node) => node.classList.contains('se-swatch')) && inside.some((node) => node.classList.contains('se-tooltip-rows')), 'the fixture has swatches in the legend and the tooltip');
  const unsupported: string[] = [], reaching: string[] = [];
  for (const rule of topLevelRules(read('styles/interaction.css'))) {
    for (const selector of rule.selectors) {
      // `.se-surface *` style rules are written for every descendant (drag cursor); everything else must name its own parts.
      if (/\*(?:::[a-z-]+)?$/.test(selector)) continue;
      try { if (inside.some((node) => node.matches(selector))) reaching.push(selector); } catch { unsupported.push(selector); }
    }
  }
  assert.deepEqual(reaching, [], 'interaction.css selectors that reach into a chart');
  assert.ok(unsupported.every((selector) => /:has\(/.test(selector)), `selectors the DOM could not evaluate: ${unsupported.join(' | ')}`);
});

// ---- 2. Heat-map labels --------------------------------------------------------------------------------------------------------------
// (the engine tests are in charts.test.ts; these are the page-level ones)

const tokenSheet = (dom: JSDOM, rules: string): void => { const style = dom.window.document.createElement('style'); style.textContent = rules; dom.window.document.head.append(style); };
/** The value label drawn on each heat cell: the cell's fill is the rect just before it in the scene. */
const heatLabels = (root: ParentNode): { fill: string | null; ink: string | null }[] => [...root.querySelectorAll('svg text[text-anchor="middle"]')]
  .filter((node) => node.previousElementSibling?.tagName.toLowerCase() === 'rect')
  .map((node) => ({ fill: node.previousElementSibling!.getAttribute('fill'), ink: node.getAttribute('fill') }));

test('a heat map on a dark page labels its cells from the colors the page really uses, and again after the theme changes', async () => {
  const dom = new JSDOM('<!doctype html><div id="app" data-se-theme="light"></div>', { pretendToBeVisual: true });
  type Entry = { callback: (entries: { contentRect: { width: number } }[]) => void };
  const observers: Entry[] = [];
  class FakeResize implements Entry { constructor(readonly callback: Entry['callback']) { observers.push(this); } observe(): void { /* driven by hand */ } disconnect(): void { /* unused */ } unobserve(): void { /* unused */ } }
  Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, value: FakeResize });
  // jsdom reads a custom property from the element's own rules, so the tokens are declared on the chart stage; a browser inherits them from any ancestor.
  tokenSheet(dom, '#app[data-se-theme="light"] .se-chart-stage { --se-heat-mid: #f8fafc; --se-heat-high: #2563eb; --se-heat-low: #ea580c; }');
  const figure = renderChartFigure(heat, { document: dom.window.document });
  const app = dom.window.document.getElementById('app')!;
  const labelsOf = (): string[] => heatLabels(figure).map((pair) => pair.ink ?? '');
  const middle = (): string => heatLabels(figure)[2]!.ink!;  // the 0 cell: the neutral color
  assert.match(middle(), /--se-chart-ink-dark/, 'detached, the built-in light palette: dark ink on the pale zero cell');
  app.append(figure);
  observers[0]!.callback([{ contentRect: { width: 640 } }]);
  assert.match(middle(), /--se-chart-ink-dark/, 'a light page keeps the dark ink');
  // The page goes dark: the zero cell is now the dark --se-heat-mid, so its label must turn light.
  tokenSheet(dom, '#app[data-se-theme="dark"] .se-chart-stage { --se-heat-mid: #1c2026; --se-heat-high: #60a5fa; --se-heat-low: #fb923c; }');
  app.setAttribute('data-se-theme', 'dark');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(middle(), /--se-chart-ink-light/, 'after the theme change the label is light on the dark cell, with no resize and no re-render by the host');
  assert.ok(labelsOf().some((ink) => /ink-dark/.test(ink)) && labelsOf().some((ink) => /ink-light/.test(ink)), 'some cells are bright enough for dark ink even on a dark page');
});

test('React: the heat map reads the page tokens once mounted and follows a theme change', async () => {
  await withDom(async ({ dom, document, container, render }) => {
    tokenSheet(dom, '#shell[data-se-theme="light"] .se-chart-stage { --se-heat-mid: #f8fafc; --se-heat-high: #2563eb; --se-heat-low: #ea580c; } #shell[data-se-theme="dark"] .se-chart-stage { --se-heat-mid: #1c2026; --se-heat-high: #60a5fa; --se-heat-low: #fb923c; }');
    await render(<div id="shell" data-se-theme="dark"><ReportView document={seed([b.chart('h', heat)]).getSnapshot()} /></div>);
    const zero = (): string => heatLabels(container)[2]!.ink!;
    assert.match(zero(), /--se-chart-ink-light/, 'a dark page: the label of the neutral cell is light from the first paint on');
    await act(async () => { document.getElementById('shell')!.setAttribute('data-se-theme', 'light'); await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.match(zero(), /--se-chart-ink-dark/, 'and dark again when the page goes light');
  });
});

// ---- 3. Overlays under an ancestor with containment ---------------------------------------------------------------------------------

const press = (target: EventTarget, window: JSDOM['window'], key: string, init: KeyboardEventInit = {}): Promise<void> => act(async () => { target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
const trapping = { transform: 'translateZ(0)', filter: 'blur(0px)', contain: 'layout paint', willChange: 'transform' } as const;

test('the shortcut dialog is mounted under body, outside an ancestor that would trap position: fixed, and keeps the theme and density', async () => {
  await withDom(async ({ dom, document, container, render }) => {
    const editor = seed([b.paragraph('p', 'one')]);
    await render(<div id="shell" style={trapping}><ReportEditor editor={editor} theme="dark" density="compact" renderControls={false} /></div>);
    const surface = container.querySelector<HTMLElement>('.se-surface')!;
    surface.focus();
    await press(surface, dom.window, '/', { ctrlKey: true, code: 'Slash' });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
    assert.ok(dialog);
    const shell = document.getElementById('shell')!;
    assert.equal(shell.contains(dialog), false, 'not inside the trapping ancestor');
    assert.equal(container.contains(dialog), false);
    const layer = dialog.closest<HTMLElement>('.se-portal')!;
    assert.equal(layer.parentElement, document.body, 'its DOM parent is the portal container, document.body by default');
    assert.ok(layer.classList.contains('super-editor'), 'carries the editor class, so the --se-* tokens and base rules apply');
    assert.equal(layer.getAttribute('data-se-theme'), 'dark');
    assert.equal(layer.getAttribute('data-se-density'), 'compact');
    assert.ok(dialog.closest('.se-dialog-backdrop'));
    // Focus moves into the dialog, Tab stays inside it, Escape closes it and gives focus back.
    const close = dialog.querySelector<HTMLElement>('.se-dialog-header button')!;
    assert.equal(document.activeElement, close, 'focus moves to the close button');
    await press(close, dom.window, 'Tab');
    assert.equal(document.activeElement, close, 'a lone control keeps Tab inside the dialog');
    await press(close, dom.window, 'Escape');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.querySelector('.se-portal [role="dialog"]'), null);
    assert.equal(document.activeElement, surface, 'focus returns to where it was');
  });
});

test('the dialog layer takes the theme from an ancestor when the editor sets none, and follows changes to it', async () => {
  await withDom(async ({ dom, document, container, render }) => {
    const editor = seed([b.paragraph('p', 'one')]);
    await render(<div id="shell" data-se-theme="dark" data-se-density="spacious" dir="rtl" lang="ar" style={trapping}><ReportEditor editor={editor} renderControls={false} /></div>);
    const surface = container.querySelector<HTMLElement>('.se-surface')!;
    surface.focus();
    await press(surface, dom.window, '/', { ctrlKey: true, code: 'Slash' });
    const layer = document.querySelector<HTMLElement>('.se-portal')!;
    assert.equal(layer.getAttribute('data-se-theme'), 'dark');
    assert.equal(layer.getAttribute('data-se-density'), 'spacious');
    assert.equal(layer.getAttribute('dir'), 'rtl');
    assert.equal(layer.getAttribute('lang'), 'ar');
    await act(async () => { document.getElementById('shell')!.setAttribute('data-se-theme', 'light'); await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.equal(document.querySelector('.se-portal')!.getAttribute('data-se-theme'), 'light', 'a theme switch while the dialog is open reaches it');
  });
});

test('portalContainer: an element, a function, or false to keep the dialog in place', async () => {
  await withDom(async ({ dom, document, container, render }) => {
    const editor = seed([b.paragraph('p', 'one')]);
    const root = document.createElement('div'); root.id = 'overlay-root'; document.body.append(root);
    const open = async (): Promise<HTMLElement> => {
      const surface = container.querySelector<HTMLElement>('.se-surface')!;
      surface.focus();
      await press(surface, dom.window, '/', { ctrlKey: true, code: 'Slash' });
      return document.querySelector<HTMLElement>('[role="dialog"]')!;
    };
    const close = async (): Promise<void> => { await press(document.querySelector('[role="dialog"] button')!, dom.window, 'Escape'); };
    await render(<ReportEditor editor={editor} portalContainer={root} renderControls={false} />);
    assert.equal((await open()).closest('.se-portal')!.parentElement, root, 'an element');
    await close();
    await render(<ReportEditor editor={editor} portalContainer={() => root} renderControls={false} />);
    assert.equal((await open()).closest('.se-portal')!.parentElement, root, 'a function');
    await close();
    await render(<ReportEditor editor={editor} portalContainer={false} renderControls={false} />);
    const inPlace = await open();
    assert.ok(container.querySelector('.se-surface')!.contains(inPlace), 'false: rendered inside the surface, as before');
    assert.equal(document.querySelector('.se-portal'), null);
  });
});

test('toasts leave the editor box too: under body with the theme, or where portalContainer says; a stand-alone provider stays where it is', async () => {
  await withDom(async ({ document, container, render }) => {
    let api!: ToastApi;
    const Grab = (): null => { api = useToasts(); return null; };
    const editor = seed([b.paragraph('p', 'one')]);
    await render(<div style={trapping}><ReportEditor editor={editor} theme="dark" renderControls={false} /></div>);
    // The editor's own toasts (Undo after a delete) are covered in interaction-react.test.tsx; here, the stack itself.
    const stack = document.querySelector<HTMLElement>('.se-toasts')!;
    assert.ok(stack, 'the stack is mounted');
    assert.equal(container.contains(stack), false);
    assert.equal(stack.closest('.se-portal')!.parentElement, document.body);
    assert.equal(stack.closest('.se-portal')!.getAttribute('data-se-theme'), 'dark');
    // Stand-alone: in place unless asked.
    await render(<ToastProvider><Grab /></ToastProvider>);
    assert.ok(container.querySelector('.se-toasts'), 'unchanged for a provider outside the editor');
    assert.equal(document.querySelector('.se-portal'), null);
    const root = document.createElement('div'); document.body.append(root);
    await render(<ToastProvider portalContainer={root}><Grab /></ToastProvider>);
    await act(async () => { api.success('Saved'); });
    assert.equal(root.querySelector('.se-portal .se-toasts .se-toast')!.textContent!.includes('Saved'), true);
    assert.equal(container.querySelector('.se-toasts'), null);
  });
});

test('opening the dialog while typing does not end the editing session (focus in the portal is still focus in the editor)', async () => {
  await withDom(async ({ dom, document, container, render }) => {
    const editor = seed([b.paragraph('p', 'hello')]);
    await render(<ReportEditor editor={editor} commitDelayMs={0} renderControls={false} />);
    await act(async () => { container.querySelector('[data-block-id="p"] p')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    const field = container.querySelector<HTMLElement>('[data-se-editable]')!;
    field.focus();
    await press(field, dom.window, '/', { ctrlKey: true, code: 'Slash' });
    assert.ok(document.querySelector('[role="dialog"]'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(container.querySelector('[data-se-editable]'), 'still editing');
    await press(document.querySelector('[role="dialog"] button')!, dom.window, 'Escape');
    assert.ok(container.querySelector('[data-se-editable]'), 'and still editing after the dialog closes');
  });
});

test('server rendering never touches document: portals render nothing until the client takes over', () => {
  assert.equal(typeof document, 'undefined', 'this test runs without a DOM');
  assert.equal(renderToStaticMarkup(<OverlayPortal><p>layer</p></OverlayPortal>), '');
  assert.equal(renderToStaticMarkup(<OverlayPortal container={false}><p>layer</p></OverlayPortal>), '<p>layer</p>', 'false means in place, which needs no document');
  const editor = seed([b.paragraph('p', 'one')]);
  const html = renderToStaticMarkup(<ReportEditor editor={editor} renderControls={false} />);
  assert.doesNotMatch(html, /se-toasts|se-dialog|se-portal/);
  assert.match(renderToStaticMarkup(<ReportEditor editor={editor} renderControls={false} portalContainer={false} />), /se-toasts/, 'in place, the stack is part of the server markup');
});

test('hydrating server markup is quiet, and the toast stack moves under body once the client has taken over', async () => {
  const html = renderToStaticMarkup(<div id="host"><ReportEditor editor={seed([b.paragraph('p', 'one')])} theme="dark" renderControls={false} /></div>);
  assert.doesNotMatch(html, /se-toasts/, 'the server renders no portal');
  const { renderToString } = await import('react-dom/server');
  const server = renderToString(<ReportEditor editor={seed([b.paragraph('p', 'one')])} theme="dark" renderControls={false} />);
  await withDom(async ({ document, container }) => {
    const { hydrateRoot } = await import('react-dom/client');
    container.innerHTML = server;
    const problems: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { problems.push(args.map(String).join(' ')); };
    try {
      let root!: ReturnType<typeof hydrateRoot>;
      await act(async () => { root = hydrateRoot(container, <ReportEditor editor={seed([b.paragraph('p', 'one')])} theme="dark" renderControls={false} />); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      const stack = document.querySelector('.se-toasts');
      assert.ok(stack, 'after hydration the stack is mounted');
      assert.equal(stack.closest('.se-portal')!.parentElement, document.body);
      assert.equal(stack.closest('.se-portal')!.getAttribute('data-se-theme'), 'dark');
      await act(async () => { root.unmount(); });
    } finally { console.error = original; }
    assert.deepEqual(problems.filter((message) => /portal|toast|se-portal|hydrat/i.test(message)), [], `hydration warnings: ${problems.join(' | ').slice(0, 400)}`);
  });
});

// ---- 4. A CSS reset in the host -------------------------------------------------------------------------------------------------------

type Declaration = { property: string; value: string; specificity: [number, number, number]; order: number };
type Triple = [number, number, number];
const compare = (x: Triple, y: Triple): number => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
function specificity(selector: string): Triple {
  let a = 0, b = 0, c = 0, rest = selector;
  const functional = /:(is|not|where|has)\(((?:[^()]|\([^()]*\))*)\)/;
  for (let match = functional.exec(rest); match; match = functional.exec(rest)) {
    if (match[1] !== 'where') {
      const best = splitTopLevel(match[2]!).map(specificity).reduce<Triple>((top, next) => compare(next, top) > 0 ? next : top, [0, 0, 0]);
      a += best[0]; b += best[1]; c += best[2];
    }
    rest = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`;
  }
  rest = rest.replace(/\[[^\]]*\]/g, () => { b++; return ' '; }).replace(/#[\w-]+/g, () => { a++; return ' '; }).replace(/\.[\w-]+/g, () => { b++; return ' '; })
    .replace(/::[\w-]+/g, () => { c++; return ' '; }).replace(/:[\w-]+/g, () => { b++; return ' '; });
  for (const token of rest.split(/[\s>+~]+/)) if (/^[a-zA-Z][\w-]*$/.test(token)) c++;
  return [a, b, c];
}
const beats = (x: Declaration, y: Declaration): boolean => (compare(x.specificity, y.specificity) || x.order - y.order) > 0;
/** A small cascade: the declaration that wins `property` for `element`, then inheritance through `inherit` and for inherited properties. */
function cascade(sheets: string, element: Element, property: string): string | undefined {
  const declarations: Declaration[] = [];
  let order = 0;
  for (const rule of topLevelRules(sheets)) {
    for (const selector of rule.selectors) {
      let matched = false;
      try { matched = element.matches(selector); } catch { matched = false; }
      order++;
      if (!matched) continue;
      for (const part of rule.body.split(';')) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        const name = part.slice(0, colon).trim(), value = part.slice(colon + 1).trim();
        const wanted = property === 'list-style-type' ? name === 'list-style' || name === 'list-style-type'
          : property === 'text-decoration-line' ? name === 'text-decoration' || name === 'text-decoration-line' : name === property;
        if (!wanted) continue;
        const resolved = property === 'list-style-type' && name === 'list-style' ? (value.split(/\s+/).find((token) => !/^(outside|inside)$/.test(token)) ?? value)
          : property === 'text-decoration-line' && name === 'text-decoration' ? (value.split(/\s+/).find((token) => /^(none|underline|overline|line-through|inherit)$/.test(token)) ?? value) : value;
        declarations.push({ property, value: resolved, specificity: specificity(selector), order });
      }
    }
  }
  const winner = declarations.reduce<Declaration | undefined>((top, next) => !top || beats(next, top) ? next : top, undefined);
  if (winner && winner.value !== 'inherit') return winner.value;
  return element.parentElement ? cascade(sheets, element.parentElement, property) : undefined;
}
// What a modern CSS reset does (Tailwind's preflight, modern-normalize): type selectors, so they are the weakest rules there are,
// plus a few that are written more aggressively on purpose.
const RESET = `
  *, ::after, ::before { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid; }
  h1, h2, h3, h4, h5, h6 { font-size: inherit; font-weight: inherit; }
  ol, ul, menu { list-style: none; margin: 0; padding: 0; }
  li { list-style: none; }
  body ul, body ol { list-style-type: none; }
  :where(ul, ol) { list-style: none; }
`;

function fixtureDocument(): Element {
  const blocks: BlockInput[] = [
    { id: 'sec', parentId: null, citationIds: [], content: { type: 'section', title: 'Section' } },
    b.heading('h1', 1, 'One', { parentId: 'sec' }), b.heading('h2', 2, 'Two', { parentId: 'sec' }), b.heading('h3', 3, 'Three', { parentId: 'sec' }),
    b.list('bullets', ['a', 'b', 'c', 'd'], { indent: [0, 1, 2, 3], parentId: 'sec' }),
    b.list('numbers', ['x', 'y'], { ordered: true, style: 'number', parentId: 'sec' }),
    b.list('todo', ['t', 'u'], { style: 'todo', checked: [true, false], indent: [0, 1], parentId: 'sec' }),
    { id: 'toc', parentId: null, citationIds: [], content: { type: 'toc' } },
  ];
  const editor = seed(blocks, [{ type: 'addCitation', citation: { id: 'src', title: 'Source', url: 'https://example.com/s', accessedAt: at } }]);
  const dom = new JSDOM('<!doctype html><body></body>');
  const article = renderDocument(editor.getSnapshot(), { document: dom.window.document });
  dom.window.document.body.append(article);
  return article;
}

test('headings and list markers survive a CSS reset, whether it loads before or after the editor stylesheet', () => {
  const editorCss = inlineCss('styles.css');
  const article = fixtureDocument();
  const markers = (css: string): Record<string, string | undefined> => {
    const bullets = [...article.querySelectorAll('ul.se-list-bullet')], numbers = article.querySelector('ol.se-list-number')!, todo = article.querySelector('ul.se-list-todo')!;
    return {
      bullet1: cascade(css, bullets[0]!, 'list-style-type'), bullet2: cascade(css, bullets[1]!, 'list-style-type'), bullet3: cascade(css, bullets[2]!, 'list-style-type'), bullet4: cascade(css, bullets[3]!, 'list-style-type'),
      bulletItem: cascade(css, bullets[1]!.querySelector('li')!, 'list-style-type'),
      number: cascade(css, numbers, 'list-style-type'), numberItem: cascade(css, numbers.querySelector('li')!, 'list-style-type'),
      todo: cascade(css, todo, 'list-style-type'), todoItem: cascade(css, todo.querySelector('li')!, 'list-style-type'), todoNested: cascade(css, todo.querySelector('ul')!, 'list-style-type'),
      sources: cascade(css, article.querySelector('.super-editor-citations ol')!, 'list-style-type'), sourceItem: cascade(css, article.querySelector('.super-editor-citations li')!, 'list-style-type'),
      toc: cascade(css, article.querySelector('.se-toc ol')!, 'list-style-type'),
    };
  };
  const expected = { bullet1: 'disc', bullet2: 'circle', bullet3: 'square', bullet4: 'square', bulletItem: 'circle', number: 'decimal', numberItem: 'decimal', todo: 'none', todoItem: 'none', todoNested: 'none', sources: 'decimal', sourceItem: 'decimal', toc: 'none' };
  const headingRules = (css: string): string[] => {
    const out: string[] = [];
    for (const [selector, size] of [['h1.se-heading', '--se-h1-size'], ['h2.se-heading', '--se-h2-size'], ['h3.se-heading', '--se-h3-size'], ['h2.se-section-title', '--se-h2-size'], ['header h1', '--se-h1-size'], ['.super-editor-citations h2', '--se-h2-size']] as const) {
      const heading = article.querySelector(selector);
      assert.ok(heading, `fixture has ${selector}`);
      out.push(`${selector}: ${cascade(css, heading, 'font-size')} / ${cascade(css, heading, 'font-weight')}`);
      assert.equal(cascade(css, heading, 'font-size'), `var(${size})`, `${selector} font-size`);
      assert.equal(cascade(css, heading, 'font-weight'), 'var(--se-heading-weight)', `${selector} font-weight`);
    }
    return out;
  };
  for (const [name, css] of [['alone', editorCss], ['reset first', `${RESET}\n${editorCss}`], ['reset last', `${editorCss}\n${RESET}`]] as const) {
    assert.deepEqual(markers(css), expected, `list markers, ${name}`);
    headingRules(css);
  }
  // Without the fix the reset does win (the test would have caught it): the same page with a reset and no list or heading rules.
  const stripped = topLevelRules(editorCss).filter((rule) => !/list-style/.test(rule.body)).map((rule) => `${rule.selectors.join(', ')} {${rule.body}}`).join(' ');
  assert.notDeepEqual(markers(`${stripped}\n${RESET}`), expected, 'the check really can fail');
});

test('the list and heading rules use no !important and are scoped to the document', () => {
  const blocks = read('styles/blocks.css');
  const rules = topLevelRules(blocks).filter((rule) => /list-style|font-weight: var\(--se-heading-weight\)/.test(rule.body));
  assert.ok(rules.length >= 9);
  for (const rule of rules) {
    assert.doesNotMatch(rule.body, /!important/);
    assert.ok(rule.selectors.every((selector) => /^\.(super-editor-document|se-list-todo|se-toc)\b/.test(selector)), `scoped: ${rule.selectors.join(', ')}`);
  }
});

test('the published stylesheet carries the reset-proof rules', () => {
  const built = new URL('../packages/ui/dist/styles.css', import.meta.url);
  const inlined = inlineCss('styles.css');
  const sheets = [['styles.css inlined from src', inlined], ...(existsSync(built) ? [['packages/ui/dist/styles.css', readFileSync(built, 'utf8')] as const] : [])];
  for (const [name, css] of sheets) {
    assert.doesNotMatch(css, /@import/, `${name} is one file`);
    for (const rule of [
      '.super-editor-document ul.se-list-bullet { list-style: disc outside; }',
      '.super-editor-document ul.se-list-bullet ul.se-list-bullet { list-style-type: circle; }',
      '.super-editor-document ul.se-list-bullet ul.se-list-bullet ul.se-list-bullet { list-style-type: square; }',
      '.super-editor-document ol.se-list-number { list-style: decimal outside; }',
      '.super-editor-document ul.se-list-todo { list-style: none; }',
      '.super-editor-document .super-editor-block h2 { font-size: var(--se-h2-size); font-weight: var(--se-heading-weight);',
      '--se-chart-ink-dark:', '--se-chart-ink-light:', '.se-highlight-swatch {',
    ]) assert.ok(css.includes(rule), `${name} has ${rule}`);
    assert.ok(!/\.se-surface \.se-swatch\b/.test(css), `${name} has no rule that reaches chart swatches`);
  }
});

test('document links keep their underline under a reset; citation markers and the table of contents stay plain', () => {
  const editorCss = inlineCss('styles.css');
  const editor = seed([
    { id: 'sec', parentId: null, citationIds: [], content: { type: 'section', title: 'Section' } },
    { id: 'p', parentId: 'sec', citationIds: ['src'], content: { type: 'paragraph', runs: [{ text: 'Read the ' }, { text: 'note', href: 'https://example.com/note' }, { text: '.', citationId: 'src' }] } },
    { id: 'toc', parentId: null, citationIds: [], content: { type: 'toc' } },
  ], [{ type: 'addCitation', citation: { id: 'src', title: 'Source', url: 'https://example.com/s', accessedAt: at } }]);
  const dom = new JSDOM('<!doctype html><body></body>');
  const article = renderDocument(editor.getSnapshot(), { document: dom.window.document });
  dom.window.document.body.append(article);
  const link = article.querySelector('p a:not(.se-citation-link)'), toc = article.querySelector('.se-toc a'), cite = article.querySelector('a.se-citation-link');
  assert.ok(link && toc && cite, 'fixture has a paragraph link, a TOC link and a citation marker');
  const LINK_RESET = 'a { color: inherit; text-decoration: inherit; }';
  for (const [name, css] of [['alone', editorCss], ['reset first', `${LINK_RESET}
${editorCss}`], ['reset last', `${editorCss}
${LINK_RESET}`]] as const) {
    assert.equal(cascade(css, link, 'text-decoration-line'), 'underline', `paragraph link, ${name}`);
    assert.equal(cascade(css, link, 'color'), 'var(--se-link)', `paragraph link color, ${name}`);
    assert.equal(cascade(css, toc, 'text-decoration'), 'none', `TOC link, ${name}`);
    assert.equal(cascade(css, cite, 'text-decoration'), 'none', `citation marker, ${name}`);
  }
});

test('component buttons keep their own sizes: the generic control rule never outranks a component class', () => {
  const css = inlineCss('styles.css');
  const dom = new JSDOM('<!doctype html><body><div class="super-editor"><button class="se-chart-button">a</button><button class="se-legend-button">b</button><button class="se-link-button">c</button><button>plain</button></div></body>');
  const [chart, legend, linkButton, plain] = [...dom.window.document.querySelectorAll('button')];
  assert.equal(cascade(css, chart!, 'padding'), '.25rem .55rem');
  assert.equal(cascade(css, chart!, 'border'), '1px solid var(--se-border)');
  assert.equal(cascade(css, legend!, 'padding'), '.15rem .45rem');
  assert.equal(cascade(css, linkButton!, 'padding'), '0');
  assert.equal(cascade(css, linkButton!, 'border'), '0');
  // A bare button inside the editor still gets the generic control look.
  assert.equal(cascade(css, plain!, 'padding'), '.4rem .6rem');
});
