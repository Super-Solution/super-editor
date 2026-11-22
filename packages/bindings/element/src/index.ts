// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { createEditor, validateDocument, type Actor, type Editor, type ResearchDocument } from '@supersolutions/super-editor-core';
import { mountEditor, releaseCards, renderDocument, type CardMount, type Density, type PartialLabels, type ThemeName } from '@supersolutions/super-editor-ui';

export type SuperEditorMode = 'view' | 'edit';
export type SuperEditorChangeDetail = { revision: number; document: ResearchDocument };
export type SuperEditorErrorDetail = { message: string };

export interface SuperEditorElement extends HTMLElement {
  /** The current document snapshot, or null before one was set. */
  readonly document: ResearchDocument | null;
  /** The live core editor behind the element, for hosts that apply transactions themselves. */
  readonly editor: Editor | null;
  /** Replaces the document. An invalid document is rejected: the previous one stays and an `error` event fires. */
  load(document: unknown): boolean;
  /** Fetches `src` again (or a new address set on the attribute) and loads the answer. Resolves to whether a document was loaded. */
  reload(): Promise<boolean>;
  mode: SuperEditorMode;
  /** UI strings (any subset); set as a property. Re-renders. */
  labels: PartialLabels | undefined;
}

const MODES: readonly string[] = ['view', 'edit'];
const THEMES: readonly string[] = ['light', 'dark', 'auto', 'host'];
const DENSITIES: readonly string[] = ['compact', 'comfortable', 'spacious'];

/**
 * Registers the custom element and returns its class. Safe to call more than
 * once with the same tag. Light DOM on purpose: load
 * `@supersolutions/super-editor-ui/styles.css` once on the page, and the host's
 * CSS tokens (`--se-*`) style the document.
 *
 * Attributes: `mode="view|edit"` (default view), `readonly` (forces view), `theme="light|dark|auto|host"`, `density="compact|comfortable|spacious"`,
 * `locale` and `time-zone` (dates and times), `actor` (id recorded on edits, default `element-user`), `src` (a URL whose JSON body is the
 * document; fetched when it is set and on `reload()`), `credentials="include|same-origin|omit"` for that fetch. Property: `labels`.
 * Events: `change` (detail: SuperEditorChangeDetail), `error` (detail: SuperEditorErrorDetail), `load` (a `src` document arrived).
 */
export function defineSuperEditor(options: { tag?: string; registry?: CustomElementRegistry; base?: typeof HTMLElement } = {}): CustomElementConstructor {
  const tag = options.tag ?? 'super-editor';
  const registry = options.registry ?? globalThis.customElements;
  const Base = options.base ?? globalThis.HTMLElement;
  if (!registry || !Base) throw new TypeError('defineSuperEditor needs a DOM with custom elements.');
  const existing = registry.get(tag);
  if (existing) return existing;

  class Element extends Base implements SuperEditorElement {
    static observedAttributes = ['mode', 'theme', 'readonly', 'density', 'locale', 'time-zone', 'actor', 'src'];
    #labels: PartialLabels | undefined;
    #cardMounts: Readonly<Record<string, CardMount>> | undefined;
    #controller: AbortController | null = null;
    #editor: Editor | null = null;
    #unsubscribe: (() => void) | null = null;
    #mounted: { destroy(): void } | null = null;
    #connected = false;

    get editor(): Editor | null { return this.#editor; }
    get document(): ResearchDocument | null { return this.#editor ? this.#editor.getSnapshot() : null; }

    get mode(): SuperEditorMode { const m = this.getAttribute('mode'); return m === 'edit' && !this.hasAttribute('readonly') ? 'edit' : 'view'; }
    get labels(): PartialLabels | undefined { return this.#labels; }
    set labels(value: PartialLabels | undefined) { this.#labels = value; this.#render(); }
    /** Draws `card` blocks by card kind (a chat plugin's `mounts`); without one a card shows its text. */
    get cardMounts(): Readonly<Record<string, CardMount>> | undefined { return this.#cardMounts; }
    set cardMounts(value: Readonly<Record<string, CardMount>> | undefined) { this.#cardMounts = value; this.#render(); }
    set mode(value: SuperEditorMode) {
      if (!MODES.includes(value)) throw new RangeError(`mode must be one of ${MODES.join(', ')}.`);
      this.setAttribute('mode', value);
    }

    load(document: unknown): boolean {
      const checked = validateDocument(document as ResearchDocument);
      if (!checked.ok) {
        this.#emit('error', { message: checked.issues[0]?.message ?? 'Invalid document.' });
        return false;
      }
      this.#unsubscribe?.();
      this.#editor = createEditor(checked.value);
      this.#unsubscribe = this.#editor.subscribe(() => {
        const snapshot = this.#editor!.getSnapshot();
        this.#emit('change', { revision: snapshot.revision, document: snapshot });
        if (this.mode === 'view') this.#render();
      });
      this.#render();
      return true;
    }

    async reload(): Promise<boolean> {
      const src = this.getAttribute('src');
      if (!src) return false;
      this.#controller?.abort();
      const own = this.#controller = new AbortController();
      try {
        const credentials = this.getAttribute('credentials');
        const response = await globalThis.fetch(src, { signal: own.signal, headers: { accept: 'application/json' }, ...(credentials === 'include' || credentials === 'same-origin' || credentials === 'omit' ? { credentials } : {}) });
        if (!response.ok) throw new Error(`The document service answered ${response.status}.`);
        const body: unknown = await response.json();
        if (own.signal.aborted) return false;
        const loaded = this.load(body);
        if (loaded) this.dispatchEvent(new ((this.ownerDocument.defaultView ?? globalThis) as typeof globalThis).CustomEvent('load', { bubbles: true }));
        return loaded;
      } catch (error) {
        if (!own.signal.aborted) this.#emit('error', { message: error instanceof Error ? error.message : 'The document could not be loaded.' });
        return false;
      }
    }

    connectedCallback(): void { this.#connected = true; this.#render(); if (this.hasAttribute('src') && !this.#editor) void this.reload(); }
    disconnectedCallback(): void { this.#connected = false; this.#controller?.abort(); this.#teardown(); }
    attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
      if (name === 'src') { if (this.#connected && next && next !== previous) void this.reload(); return; }
      this.#render();
    }

    #emit(type: 'change' | 'error', detail: SuperEditorChangeDetail | SuperEditorErrorDetail): void {
      const view = (this.ownerDocument.defaultView ?? globalThis) as typeof globalThis;
      this.dispatchEvent(new view.CustomEvent(type, { detail, bubbles: true }));
    }

    #teardown(): void {
      this.#mounted?.destroy();
      this.#mounted = null;
      releaseCards(this);
      this.replaceChildren();
    }

    #render(): void {
      if (!this.#connected) return;
      this.#teardown();
      const editor = this.#editor;
      if (!editor) return;
      const themeAttr = this.getAttribute('theme');
      const theme = themeAttr && THEMES.includes(themeAttr) ? (themeAttr as ThemeName) : undefined;
      const doc = this.ownerDocument;
      const densityAttr = this.getAttribute('density'), locale = this.getAttribute('locale'), timeZone = this.getAttribute('time-zone');
      const common = {
        document: doc, ...(theme ? { theme } : {}), ...(densityAttr && DENSITIES.includes(densityAttr) ? { density: densityAttr as Density } : {}),
        ...(locale ? { locale } : {}), ...(timeZone ? { timeZone } : {}), ...(this.#labels ? { labels: this.#labels } : {}),
        ...(this.#cardMounts ? { cardMounts: this.#cardMounts } : {}),
      };
      if (this.mode === 'edit') {
        const actor: Actor = { id: this.getAttribute('actor') || 'element-user', kind: 'human' };
        this.#mounted = mountEditor(this, editor, { actor, ...common });
      } else {
        this.append(renderDocument(editor.getSnapshot(), common));
      }
    }
  }
  registry.define(tag, Element);
  return Element;
}
