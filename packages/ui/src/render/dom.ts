import { safeUrl } from '@super-solution/editor-core';
import { SVG_NS, type SceneNode } from '../charts/scene.js';

/** Small DOM construction helpers. Text is always set through textContent, never as markup. */
export function element<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function attributes(node: Element, values: Record<string, string | number | boolean | undefined>): void {
  for (const [key, value] of Object.entries(values)) { if (value === undefined || value === false) continue; node.setAttribute(key, value === true ? '' : String(value)); }
}
export function safeLink(document: Document, url: string, label: string, unsafeLabel = `${label} (unsafe URL omitted)`): HTMLElement {
  const safe = safeUrl(url);
  if (!safe) return element(document, 'span', unsafeLabel);
  const link = element(document, 'a', label);
  link.href = safe; link.target = '_blank'; link.rel = 'noopener noreferrer';
  return link;
}
export function timeElement(document: Document, at: string, label?: string): HTMLElement {
  const node = element(document, 'time', label ? `${label}: ${at}` : at);
  node.dateTime = at;
  return node;
}
export function srOnly(document: Document, text: string): HTMLElement { return element(document, 'span', text, 'se-sr'); }

/** Builds real SVG elements from a scene. Only scene nodes produced by the chart engine reach this function. */
export function sceneToDom(document: Document, nodes: readonly SceneNode[], parent: Element): void {
  for (const node of nodes) {
    const child = document.createElementNS(SVG_NS, node.tag);
    for (const [key, value] of Object.entries(node.attrs)) child.setAttribute(key, String(value));
    if (node.text !== undefined) child.textContent = node.text;
    if (node.children) sceneToDom(document, node.children, child);
    parent.append(child);
  }
}
export function svgElement(document: Document, tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node as SVGElement;
}
/** The hostname of a URL for compact source labels, or an empty string. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
export const prefersReducedMotion = (win?: Window | null): boolean => !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Scrolls to a block, opening any collapsed toggles above it first, and moves focus there for keyboard and
 * screen-reader users. Works on DOM rendered by either the headless renderer or the React view.
 */
export function revealBlock(root: ParentNode, blockId: string, options: { behavior?: ScrollBehavior; focus?: boolean } = {}): HTMLElement | null {
  const target = Array.from(root.querySelectorAll<HTMLElement>('[data-block-id]')).find((node) => node.dataset.blockId === blockId);
  if (!target) return null;
  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.classList.contains('se-toggle-body') && ancestor.hidden) {
      const button = ancestor.parentElement?.querySelector<HTMLElement>(':scope > .se-toggle-button');
      button?.click();
    }
  }
  const win = target.ownerDocument.defaultView;
  target.scrollIntoView?.({ block: 'start', behavior: options.behavior ?? (prefersReducedMotion(win) ? 'auto' : 'smooth') });
  if (options.focus !== false) { if (!target.hasAttribute('tabindex')) target.tabIndex = -1; target.focus({ preventScroll: true }); }
  return target;
}
