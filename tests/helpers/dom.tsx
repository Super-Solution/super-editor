import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { createDocument, createEditor } from '@super-solution/editor-core';
import type { BlockInput, Editor, Operation, ResearchDocument } from '@super-solution/editor-core';

export const at = '2026-10-05T12:00:00.000Z';
export const actor = { id: 'tester', kind: 'human' as const };
let counter = 0;
export function apply(editor: Editor, operations: Operation[], who: { id: string; kind: 'human' | 'agent' | 'system' } = actor) {
  const result = editor.apply({ id: `t-${++counter}`, actor: who, baseRevision: editor.getSnapshot().revision, operations });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}
export const paragraph = (id: string, text: string, parentId: string | null = null, extra: Partial<BlockInput> = {}): BlockInput => ({ id, parentId, citationIds: [], content: { type: 'paragraph', runs: [{ text }] }, ...extra });

/** A document containing every block type, a citation, a nested toggle and every callout tone. */
export function everyBlock(): Editor {
  const editor = createEditor(createDocument({ id: 'all', title: 'Every block' }, { now: () => at }), { now: () => at });
  const labels = ['Jan', 'Feb', 'Mar'];
  const blocks: BlockInput[] = [
    { id: 'toc', parentId: null, citationIds: [], content: { type: 'toc' } },
    { id: 'metrics', parentId: null, citationIds: [], content: { type: 'metrics', items: [{ label: 'Price', value: '$67,420', change: 2.4, hint: 'vs 7d' }, { label: 'Spread', value: '0.1%', change: -1.1 }, { label: 'Funding', value: '0.01%' }] } },
    { id: 'sec', parentId: null, citationIds: [], content: { type: 'section', title: 'Summary' } },
    { id: 'h1', parentId: 'sec', citationIds: [], content: { type: 'heading', level: 1, text: 'Heading one' } },
    { id: 'h2', parentId: 'sec', citationIds: [], content: { type: 'heading', level: 2, text: 'Heading two' } },
    { id: 'para', parentId: 'sec', citationIds: ['src1'], content: { type: 'paragraph', runs: [
      { text: 'Plain ' }, { text: 'bold', bold: true }, { text: 'italic', italic: true }, { text: 'struck', strike: true }, { text: 'under', underline: true },
      { text: 'marked', highlight: 'green' }, { text: 'code', code: true }, { text: 'link', href: 'https://example.com/a' }, { text: '', citationId: 'src1' },
    ] } },
    { id: 'quote', parentId: 'sec', citationIds: [], content: { type: 'quote', runs: [{ text: 'A quote' }], attribution: 'Someone' } },
    ...(['info', 'success', 'warning', 'danger', 'note'] as const).map((tone): BlockInput => ({ id: `callout-${tone}`, parentId: 'sec', citationIds: [], content: { type: 'callout', tone, ...(tone === 'info' ? { title: 'Titled' } : {}), runs: [{ text: `A ${tone} callout` }] } })),
    { id: 'todo', parentId: 'sec', citationIds: [], content: { type: 'list', ordered: false, style: 'todo', items: ['One', 'Two', 'Three', 'Four'], checked: [true, false, true, false], indent: [0, 1, 1, 0] } },
    { id: 'ordered', parentId: 'sec', citationIds: [], content: { type: 'list', ordered: true, style: 'number', items: ['First', 'Second'] } },
    { id: 'bullets', parentId: 'sec', citationIds: [], content: { type: 'list', ordered: false, items: ['Alpha', 'Beta', 'Gamma'], indent: [0, 1, 2] } },
    { id: 'table', parentId: 'sec', citationIds: [], content: { type: 'table', columns: ['Asset', 'Return', 'Note'], rows: [['BTC', '12.4%', 'core'], ['ETH', '-3.2%', 'beta']], align: ['left', 'right', 'center'], caption: 'Returns', headerColumn: true } },
    { id: 'numeric', parentId: 'sec', citationIds: [], content: { type: 'table', columns: ['Name', 'Value'], rows: [['a', '1,200'], ['b', '$35.5']] } },
    { id: 'line', parentId: 'sec', citationIds: [], content: { type: 'chart', spec: { kind: 'line', title: 'Line chart', labels, series: [{ name: 'A', values: [1, 2, 3] }, { name: 'B', values: [3, 2, 1] }], source: 'OKX', asOf: at, caption: 'A caption' } } },
    { id: 'pie', parentId: 'sec', citationIds: [], content: { type: 'chart', spec: { kind: 'donut', title: 'Donut chart', labels, series: [{ name: 'W', values: [50, 30, 20] }] } } },
    { id: 'code', parentId: 'sec', citationIds: [], content: { type: 'code', language: 'ts', text: 'const x = 1;' } },
    { id: 'divider', parentId: 'sec', citationIds: [], content: { type: 'divider' } },
    { id: 'image', parentId: 'sec', citationIds: [], content: { type: 'image', url: 'https://example.com/a.png', alt: 'An image', caption: 'Caption', width: 'wide' } },
    { id: 'toggle', parentId: null, citationIds: [], content: { type: 'toggle', title: 'Details', open: false } },
    { id: 'inner', parentId: 'toggle', citationIds: [], content: { type: 'paragraph', runs: [{ text: 'Inside the toggle' }] } },
    { id: 'embed', parentId: null, citationIds: [], content: { type: 'embed', provider: 'superchart', title: 'Live chart', url: 'https://charts.example.com/r/1', height: 500 } },
    { id: 'stamp', parentId: null, citationIds: [], content: { type: 'timestamp', at, label: 'Checked' } },
    { id: 'break', parentId: null, citationIds: [], content: { type: 'pageBreak' } },
  ];
  apply(editor, [{ type: 'addCitation', citation: { id: 'src1', title: 'Source <one>', url: 'https://www.example.com/source', accessedAt: at, publishedAt: at } }, ...blocks.map((block): Operation => ({ type: 'insertBlock', block }))]);
  return editor;
}

export function manyParagraphs(count: number): Editor {
  const editor = createEditor(createDocument({ id: 'big', title: 'Big' }, { now: () => at }), { now: () => at });
  apply(editor, [{ type: 'insertBlocks', blocks: Array.from({ length: count }, (_, index) => paragraph(`p${index}`, `Paragraph ${index}`)) }]);
  return editor;
}

const KEYS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
export type DomHarness = { dom: JSDOM; document: Document; container: HTMLElement; root: Root; render(node: ReactNode): Promise<void>; flush(): Promise<void>; type(input: HTMLInputElement, value: string): Promise<void> };

/** Runs `run` with a jsdom window installed as the global DOM, a mounted React root, and everything restored after. */
export async function withDom<T>(run: (harness: DomHarness) => Promise<T>, url = 'https://app.example.com'): Promise<T> {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url, pretendToBeVisual: true });
  const descriptors = new Map(KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Element: dom.window.Element, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let mounted: Root | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const container = dom.window.document.getElementById('app')!, root = createRoot(container);
    mounted = root;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    const harness: DomHarness = {
      dom, document: dom.window.document, container, root,
      render: (node) => act(async () => root.render(node)),
      flush: () => act(async () => { await Promise.resolve(); }),
      // Uses the native setter so React sees the same change a browser user would make.
      type: (input, value) => act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }),
    };
    return await run(harness);
  } finally {
    // Unmount so effects clean up their timers and observers; otherwise intervals keep the process alive.
    await act(async () => { mounted?.unmount(); });
    for (const key of KEYS) { const descriptor = descriptors.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
}
export const click = (dom: JSDOM, node: Element | null): void => { if (!node) throw new Error('Missing element to click'); node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); };
export const doc = (editor: Editor): ResearchDocument => editor.getSnapshot();
