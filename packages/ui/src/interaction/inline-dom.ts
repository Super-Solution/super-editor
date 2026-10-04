import { HIGHLIGHTS, safeUrl } from '@super-solution/editor-core';
import type { Highlight, InlineRun } from '@super-solution/editor-core';
import { normalizeRuns } from './inline.js';

/** DOM side of inline editing: runs <-> contenteditable markup, and text-offset based selection. Citation markers are atoms of zero text length. */
const SHOW_TEXT = 4;
type Format = Omit<InlineRun, 'text' | 'citationId'>;

export function renderRunsInto(root: HTMLElement, runs: readonly InlineRun[], options: { citationLabel?: (id: string) => string } = {}): void {
  const doc = root.ownerDocument;
  root.textContent = '';
  const fragment = doc.createDocumentFragment();
  let lastText = '';
  for (const run of runs) {
    if (run.text !== '') {
      let node: Node = doc.createTextNode(run.text);
      const wrap = (tag: 'code' | 'em' | 'strong' | 's' | 'u' | 'mark' | 'a'): HTMLElement => { const wrapper = doc.createElement(tag); wrapper.append(node); node = wrapper; return wrapper; };
      if (run.code) wrap('code');
      if (run.italic) wrap('em');
      if (run.bold) wrap('strong');
      if (run.strike) wrap('s');
      if (run.underline) wrap('u');
      if (run.highlight) wrap('mark').dataset.highlight = run.highlight;
      const safe = run.href ? safeUrl(run.href) : null;
      if (safe) { const anchor = wrap('a') as HTMLAnchorElement; anchor.setAttribute('href', safe); anchor.setAttribute('rel', 'noopener noreferrer'); }
      fragment.append(node);
      lastText = run.text;
    }
    if (run.citationId) {
      const marker = doc.createElement('sup');
      marker.setAttribute('contenteditable', 'false'); marker.setAttribute('data-se-atom', ''); marker.dataset.citationId = run.citationId;
      marker.textContent = `[${options.citationLabel?.(run.citationId) ?? '?'}]`;
      fragment.append(marker);
    }
  }
  // A trailing newline only shows its empty line when something follows it.
  if (lastText.endsWith('\n')) { const pad = doc.createElement('br'); pad.setAttribute('data-se-pad', ''); fragment.append(pad); }
  root.append(fragment);
}

export function readRunsFrom(root: HTMLElement): InlineRun[] {
  const out: InlineRun[] = [];
  const visit = (node: Node, format: Format): void => {
    if (node.nodeType === 3) { const text = node.nodeValue ?? ''; if (text) out.push({ ...format, text }); return; }
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement;
    if (element.hasAttribute('data-se-atom')) {
      const id = element.getAttribute('data-citation-id');
      if (id) { const last = out[out.length - 1]; if (last && last.citationId === undefined) last.citationId = id; else out.push({ text: '', citationId: id }); }
      return;
    }
    if (element.tagName === 'BR') return;
    const next: Format = { ...format };
    switch (element.tagName) {
      case 'STRONG': case 'B': next.bold = true; break;
      case 'EM': case 'I': next.italic = true; break;
      case 'U': next.underline = true; break;
      case 'S': case 'STRIKE': case 'DEL': next.strike = true; break;
      case 'CODE': next.code = true; break;
      case 'MARK': { const color = element.getAttribute('data-highlight'); next.highlight = (HIGHLIGHTS as readonly string[]).includes(color ?? '') ? color as Highlight : 'yellow'; break; }
      case 'A': { const href = safeUrl(element.getAttribute('href') ?? ''); if (href) next.href = href; break; }
    }
    const style = element.style;
    if (style) {
      if (style.fontWeight === 'bold' || Number(style.fontWeight) >= 600) next.bold = true;
      if (style.fontStyle === 'italic') next.italic = true;
      if (style.textDecoration?.includes('underline')) next.underline = true;
      if (style.textDecoration?.includes('line-through')) next.strike = true;
    }
    element.childNodes.forEach((child) => visit(child, next));
  };
  root.childNodes.forEach((child) => visit(child, {}));
  return normalizeRuns(out);
}
/** Plain text of an editable, ignoring layout placeholders and atoms. */
export function readTextFrom(root: HTMLElement): string {
  let text = '';
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!insideAtom(node)) text += node.nodeValue ?? '';
  return text;
}
export function renderTextInto(root: HTMLElement, text: string): void {
  root.textContent = text;
  if (text.endsWith('\n')) { const pad = root.ownerDocument.createElement('br'); pad.setAttribute('data-se-pad', ''); root.append(pad); }
}

function insideAtom(node: Node): boolean {
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  return !!element?.closest('[data-se-atom],sup[data-citation-id]');
}
function textNodes(root: HTMLElement): Text[] {
  const found: Text[] = [], walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!insideAtom(node)) found.push(node as Text);
  return found;
}
/** UTF-16 offset of a DOM boundary point within the text of `root`. */
export function textOffsetOf(root: HTMLElement, container: Node, offset: number): number {
  let total = 0;
  const boundary = container.nodeType === 1 ? container.childNodes[offset] ?? null : null;
  for (const node of textNodes(root)) {
    if (node === container) return total + offset;
    if (container.nodeType === 1) {
      if (boundary) { if (node === boundary || boundary.contains(node) || (boundary.compareDocumentPosition(node) & 4 /* FOLLOWING */)) return total; }
      else if (!container.contains(node) && (container.compareDocumentPosition(node) & 4)) return total;
    }
    total += node.length;
  }
  return total;
}
export function locateOffset(root: HTMLElement, offset: number): { node: Node; offset: number } {
  const nodes = textNodes(root);
  if (!nodes.length) return { node: root, offset: 0 };
  let remaining = Math.max(0, offset);
  for (const node of nodes) { if (remaining <= node.length) return { node, offset: remaining }; remaining -= node.length; }
  const last = nodes[nodes.length - 1]!;
  return { node: last, offset: last.length };
}
export type TextSelectionOffsets = { start: number; end: number };
export function getSelectionOffsets(root: HTMLElement): TextSelectionOffsets | null {
  const selection = root.ownerDocument.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const a = textOffsetOf(root, range.startContainer, range.startOffset), b = textOffsetOf(root, range.endContainer, range.endOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}
export function setSelectionOffsets(root: HTMLElement, start: number, end: number = start): void {
  const doc = root.ownerDocument, selection = doc.getSelection?.();
  if (!selection) return;
  const from = locateOffset(root, start), to = start === end ? from : locateOffset(root, end);
  const range = doc.createRange();
  range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset);
  selection.removeAllRanges(); selection.addRange(range);
}
export function textLength(root: HTMLElement): number { return textNodes(root).reduce((sum, node) => sum + node.length, 0); }
/** Bounding rectangle of the current selection inside `root` (viewport coordinates), when the environment can measure it. */
export function selectionClientRect(root: HTMLElement): { left: number; top: number; right: number; bottom: number } | null {
  const selection = root.ownerDocument.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const rect = range.getBoundingClientRect?.();
  if (rect && (rect.width > 0 || rect.height > 0)) return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  const rects = range.getClientRects?.();
  const first = rects && rects.length ? rects[0] : undefined;
  return first && (first.width > 0 || first.height > 0) ? { left: first.left, top: first.top, right: first.right, bottom: first.bottom } : null;
}
/** Whether the caret is on the first/last visual line. Without layout (no measurable caret) a block counts as a single line. */
export function caretLine(root: HTMLElement): { first: boolean; last: boolean } {
  const rect = selectionClientRect(root);
  if (!rect) return { first: true, last: true };
  const box = root.getBoundingClientRect(), view = root.ownerDocument.defaultView;
  const style = view?.getComputedStyle?.(root);
  const height = Math.max(rect.bottom - rect.top, 8);
  const top = box.top + (parseFloat(style?.paddingTop ?? '') || 0), bottom = box.bottom - (parseFloat(style?.paddingBottom ?? '') || 0);
  return { first: rect.top - top < height * .6, last: bottom - rect.bottom < height * .6 };
}
