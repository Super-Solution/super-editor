import { parseColor, tokenFallbacks, type TokenColors, type TokenName } from './palette.js';

/**
 * The tokens a layout reasons about numerically (contrast), as opposed to just painting. In the browser these have the host's
 * values, which the engine cannot know from the theme name alone: a page can be dark through `data-se-theme`, a class, a media
 * query or its own `--se-heat-*` overrides, and the SVG is painted from the variables either way.
 */
const LIVE_TOKENS: readonly TokenName[] = ['heatPos', 'heatNeg', 'heatMid', 'inkDark', 'inkLight'];

/** Reads the live value of those tokens at `element`. Tokens that are unset or not parseable are left out (the built-in value applies). */
export function readTokenColors(element: Element | null | undefined): TokenColors {
  const view = element?.ownerDocument?.defaultView;
  if (!element || !view || !element.isConnected) return {};
  const style = view.getComputedStyle(element), colors: TokenColors = {};
  for (const name of LIVE_TOKENS) {
    const parsed = parseColor(style.getPropertyValue(tokenFallbacks[name].css));
    if (parsed) colors[name] = parsed;
  }
  return colors;
}
/** A string that changes exactly when `readTokenColors` would give a different answer. */
export const tokenColorsKey = (colors: TokenColors): string => LIVE_TOKENS.map((name) => colors[name] ?? '').join('|');

type Registry = { observer: MutationObserver | null; query: MediaQueryList | null; entries: Set<WeakRef<Element>> };
const registries = new WeakMap<Document, Registry>();
const callbacks = new WeakMap<Element, Set<() => void>>();
const refs = new WeakMap<Element, WeakRef<Element>>();
const OBSERVED_ATTRIBUTES = ['class', 'style', 'data-se-theme', 'data-se-density', 'data-theme'];

function notify(registry: Registry): void {
  for (const ref of [...registry.entries]) {
    const element = ref.deref();
    if (!element || !element.isConnected) { registry.entries.delete(ref); continue; }
    for (const callback of [...(callbacks.get(element) ?? [])]) callback();
  }
}
function registryFor(document: Document): Registry {
  let registry = registries.get(document);
  if (registry) return registry;
  const view = document.defaultView;
  const created: Registry = { observer: null, query: null, entries: new Set() };
  // One observer and one media query per document, holding elements only weakly: charts that are re-rendered and dropped (the
  // headless mount re-renders the whole document) never stay alive because they once asked to be told about a theme change.
  if (view && typeof view.MutationObserver === 'function') created.observer = new view.MutationObserver(() => notify(created));
  if (view && typeof view.matchMedia === 'function') {
    created.query = view.matchMedia('(prefers-color-scheme: dark)');
    created.query.addEventListener?.('change', () => notify(created));
  }
  registries.set(document, created);
  registry = created;
  return registry;
}

/**
 * Calls `onChange` when something that can change the theme at `element` changes: an attribute of the element or of any ancestor
 * (`data-se-theme`, `data-se-density`, class, inline style), or the operating system's color scheme. It only says "look again";
 * compare what you read (for example with `tokenColorsKey`). Returns a function that stops watching; elements that are simply
 * dropped need not call it, because only weak references are kept.
 */
export function watchTheme(element: Element, onChange: () => void): () => void {
  const registry = registryFor(element.ownerDocument);
  if (registry.entries.size > 64) for (const ref of [...registry.entries]) { const known = ref.deref(); if (!known || !known.isConnected) registry.entries.delete(ref); }
  let ref = refs.get(element);
  if (!ref) { ref = new WeakRef(element); refs.set(element, ref); }
  registry.entries.add(ref);
  const set = callbacks.get(element) ?? new Set<() => void>();
  set.add(onChange); callbacks.set(element, set);
  if (registry.observer) for (let node: Element | null = element; node; node = node.parentElement) registry.observer.observe(node, { attributes: true, attributeFilter: OBSERVED_ATTRIBUTES });
  const entry = ref;
  return () => { set.delete(onChange); if (!set.size) registry.entries.delete(entry); };
}
