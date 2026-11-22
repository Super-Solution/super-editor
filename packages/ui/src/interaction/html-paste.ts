// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { LIMITS, safeUrl } from '@supersolutions/super-editor-core';
import type { BlockContent, BlockInput, InlineRun } from '@supersolutions/super-editor-core';
import type { IdFactory } from './plan.js';

/**
 * Rich paste: turns the `text/html` flavour of the clipboard (a web page, Word, Google Docs, another editor) into blocks.
 *
 * The HTML is parsed with `DOMParser`, which builds an inert document (no script runs, no resource loads), and only a small
 * allow-list of structure is read: headings, paragraphs, lists (with nesting), block quotes, preformatted text, tables, rules and
 * images with an https `src`; inline bold, italic, underline, strike, code, highlight and links. Styles, classes, ids, event
 * handlers, `data:` images and every other element are dropped; their text content is kept where it is visible text.
 */
const MAX_HTML = 1_000_000;
const SKIP = new Set(['script', 'style', 'template', 'noscript', 'head', 'title', 'meta', 'link', 'iframe', 'object', 'embed', 'svg', 'canvas', 'form', 'button', 'select', 'textarea', 'input']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'figure', 'figcaption', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'details', 'summary', 'dl', 'dt', 'dd', 'address', 'fieldset']);
type Marks = { bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; underline?: boolean; highlight?: boolean; href?: string };

const tag = (node: Node): string => node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : '';
const isBlockElement = (node: Node): boolean => BLOCKS.has(tag(node));

function mergeRuns(list: InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const run of list) {
    if (run.text === '') continue;
    const last = out[out.length - 1];
    if (last && last.bold === run.bold && last.italic === run.italic && last.code === run.code && last.strike === run.strike && last.underline === run.underline && last.highlight === run.highlight && last.href === run.href) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}
/** Collapses runs of whitespace the way a browser lays out text, and trims the ends of the paragraph. */
function normalizeRuns(list: InlineRun[], preserve = false): InlineRun[] {
  const merged = mergeRuns(list);
  if (preserve) return merged;
  let previousSpace = true;
  for (const run of merged) {
    let text = '';
    for (const char of run.text.replace(/ /g, ' ')) {
      const space = /\s/.test(char);
      if (space) { if (!previousSpace) text += ' '; previousSpace = true; } else { text += char; previousSpace = false; }
    }
    run.text = text;
  }
  const result = mergeRuns(merged);
  const last = result[result.length - 1];
  if (last) last.text = last.text.replace(/ +$/, '');
  return result.filter((run) => run.text !== '');
}

class Walker {
  blocks: BlockInput[] = [];
  constructor(private readonly createId: IdFactory, private readonly linkSchemes: 'https' | 'http-https') {}
  private add(content: BlockContent): void {
    if (this.blocks.length >= LIMITS.blocksPerOperation) return;
    this.blocks.push({ id: this.createId('block'), parentId: null, citationIds: [], content });
  }
  private href(value: string | null): string | undefined {
    if (!value) return undefined;
    const url = safeUrl(value.trim(), this.linkSchemes === 'http-https' ? {} : { httpsOnly: true });
    return url ?? undefined;
  }
  /** Inline content of a node as runs. Block-level children inside are flattened to their text with a space between. */
  inline(node: Node, marks: Marks = {}, into: InlineRun[] = []): InlineRun[] {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const text = child.nodeValue ?? '';
        if (text) into.push({ text, ...(marks.bold ? { bold: true } : {}), ...(marks.italic ? { italic: true } : {}), ...(marks.code ? { code: true } : {}), ...(marks.strike ? { strike: true } : {}), ...(marks.underline ? { underline: true } : {}), ...(marks.highlight ? { highlight: 'yellow' as const } : {}), ...(marks.href ? { href: marks.href } : {}) });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const name = tag(child), element = child as Element;
      if (SKIP.has(name) || element.hasAttribute('hidden') || /display\s*:\s*none/i.test(element.getAttribute('style') ?? '')) continue;
      if (name === 'br') { into.push({ text: ' ' }); continue; }
      const next: Marks = { ...marks };
      if (name === 'b' || name === 'strong') next.bold = true;
      else if (name === 'i' || name === 'em' || name === 'cite' || name === 'dfn') next.italic = true;
      else if (name === 'u' || name === 'ins') next.underline = true;
      else if (name === 's' || name === 'strike' || name === 'del') next.strike = true;
      else if (name === 'code' || name === 'kbd' || name === 'samp' || name === 'tt') next.code = true;
      else if (name === 'mark') next.highlight = true;
      else if (name === 'a') { const href = this.href(element.getAttribute('href')); if (href) next.href = href; }
      else if (name === 'span') {
        // Word and Google Docs carry bold and italic as inline styles on spans.
        const style = element.getAttribute('style') ?? '';
        if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(style)) next.bold = true;
        if (/font-style\s*:\s*italic/i.test(style)) next.italic = true;
        if (/text-decoration[^;]*underline/i.test(style) && !next.href) next.underline = true;
        if (/text-decoration[^;]*line-through/i.test(style)) next.strike = true;
      }
      if (isBlockElement(child)) into.push({ text: ' ' });
      this.inline(child, next, into);
      if (isBlockElement(child)) into.push({ text: ' ' });
    }
    return into;
  }
  private paragraph(node: Node): void {
    const runs = normalizeRuns(this.inline(node));
    if (runs.length) this.add({ type: 'paragraph', runs });
  }
  private plain(node: Node): string { return normalizeRuns(this.inline(node)).map((run) => run.text).join(''); }
  private list(element: Element, depth: number, state: { items: string[]; indent: number[]; checked: boolean[]; todo: boolean }): void {
    for (const child of Array.from(element.children)) {
      const name = tag(child);
      if (name === 'ul' || name === 'ol') { this.list(child, Math.min(depth + 1, LIMITS.listIndent), state); continue; }
      if (name !== 'li') continue;
      const own = child.cloneNode(true) as Element;
      for (const nested of Array.from(own.querySelectorAll('ul, ol'))) nested.remove();
      const box = own.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      const text = this.plain(own);
      if (text && state.items.length < LIMITS.listItems) {
        state.items.push(text.slice(0, LIMITS.listItemText)); state.indent.push(depth);
        state.checked.push(box ? box.hasAttribute('checked') : false);
        if (box) state.todo = true;
      }
      for (const nested of Array.from(child.children)) if (tag(nested) === 'ul' || tag(nested) === 'ol') this.list(nested, Math.min(depth + 1, LIMITS.listIndent), state);
    }
  }
  private table(element: Element): void {
    const rows = Array.from(element.querySelectorAll('tr')).filter((row) => row.closest('table') === element)
      .map((row) => Array.from(row.children).filter((cell) => tag(cell) === 'td' || tag(cell) === 'th').map((cell) => this.plain(cell).slice(0, LIMITS.tableCellText)));
    const grid = rows.filter((row) => row.length).slice(0, LIMITS.tableRows + 1);
    if (!grid.length) return;
    const width = Math.min(Math.max(...grid.map((row) => row.length)), LIMITS.tableColumns);
    const pad = (row: string[]): string[] => Array.from({ length: width }, (_, index) => row[index] ?? '');
    const [head, ...body] = grid.map(pad);
    const caption = element.querySelector('caption');
    const captionText = caption ? this.plain(caption).slice(0, LIMITS.caption) : '';
    this.add({ type: 'table', columns: head!, rows: body.length ? body : [pad([])], ...(captionText ? { caption: captionText } : {}) });
  }
  /** Walks block structure; stray inline content between blocks becomes paragraphs. */
  children(node: Node): void {
    let pending: Node[] = [];
    const flush = (): void => {
      if (!pending.length) return;
      const holder = node.ownerDocument!.createElement('div');
      for (const child of pending) holder.append(child.cloneNode(true));
      this.paragraph(holder); pending = [];
    };
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 8) continue;
      if (child.nodeType === 1 && (SKIP.has(tag(child)) || (child as Element).hasAttribute('hidden'))) continue;
      if (child.nodeType === 1 && tag(child) === 'img') { flush(); this.image(child as Element); continue; }
      if (child.nodeType === 1 && isBlockElement(child)) { flush(); this.block(child as Element); continue; }
      if (child.nodeType === 1 && (child as Element).querySelector('p, div, ul, ol, table, h1, h2, h3, h4, h5, h6, pre, blockquote, hr, img')) { flush(); this.children(child); continue; }
      if (child.nodeType === 3 || child.nodeType === 1) pending.push(child);
    }
    flush();
  }
  private image(element: Element): void {
    const src = safeUrl(element.getAttribute('src') ?? '', { httpsOnly: true });
    if (!src) return;
    const alt = (element.getAttribute('alt') ?? '').trim().slice(0, LIMITS.caption);
    this.add({ type: 'image', url: src, alt: alt || 'Image' });
  }
  private block(element: Element): void {
    const name = tag(element);
    switch (name) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const text = this.plain(element).slice(0, LIMITS.text);
        if (text) this.add({ type: 'heading', level: Math.min(Number(name[1]), 3) as 1 | 2 | 3, text });
        return;
      }
      case 'p': case 'address': case 'dt': case 'dd': case 'summary': case 'figcaption': {
        // A paragraph that wraps an image (common in pasted pages) keeps the image.
        if (element.querySelector('img')) { this.children(element); return; }
        this.paragraph(element); return;
      }
      case 'ul': case 'ol': {
        const state = { items: [] as string[], indent: [] as number[], checked: [] as boolean[], todo: false };
        this.list(element, 0, state);
        if (!state.items.length) return;
        const nested = state.indent.some((level) => level > 0);
        this.add({ type: 'list', ordered: name === 'ol', items: state.items, ...(state.todo ? { style: 'todo' as const, checked: state.checked } : name === 'ol' ? { style: 'number' as const } : {}), ...(nested ? { indent: state.indent } : {}) });
        return;
      }
      case 'blockquote': {
        const runs = normalizeRuns(this.inline(element));
        if (runs.length) this.add({ type: 'quote', runs });
        return;
      }
      case 'pre': {
        const text = (element.textContent ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').slice(0, LIMITS.text);
        const language = /(?:language|lang)-([a-z0-9+#-]{1,40})/i.exec((element.querySelector('code')?.getAttribute('class') ?? '') + ' ' + (element.getAttribute('class') ?? ''))?.[1] ?? '';
        if (text.trim()) this.add({ type: 'code', language: language.toLowerCase(), text });
        return;
      }
      case 'table': this.table(element); return;
      case 'hr': this.add({ type: 'divider' }); return;
      case 'li': this.paragraph(element); return;
      default: this.children(element);
    }
  }
}

export type HtmlPasteOptions = { linkSchemes?: 'https' | 'http-https'; parse?: (html: string) => Document | null };
const defaultParse = (html: string): Document | null => {
  const Parser = (globalThis as { DOMParser?: new () => { parseFromString(source: string, type: string): Document } }).DOMParser;
  return Parser ? new Parser().parseFromString(html, 'text/html') : null;
};
/** Blocks for the HTML flavour of a paste, or `null` when there is no usable structure (plain text then decides). */
export function htmlToBlocks(html: string | undefined, createId: IdFactory, options: HtmlPasteOptions = {}): BlockInput[] | null {
  if (!html || html.length > MAX_HTML || !/<[a-z][^>]*>/i.test(html)) return null;
  let document: Document | null;
  try { document = (options.parse ?? defaultParse)(html); } catch { return null; }
  if (!document?.body) return null;
  const walker = new Walker(createId, options.linkSchemes ?? 'https');
  walker.children(document.body);
  return walker.blocks.length ? walker.blocks : null;
}
