// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { createEditor, validateDocument, type Actor, type Editor, type ResearchDocument } from '@supersolutions/super-editor-core';
import { mountEditor, renderDocument, type ThemeName } from '@supersolutions/super-editor-ui';

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
  mode: SuperEditorMode;
}

const MODES: readonly string[] = ['view', 'edit'];
const THEMES: readonly string[] = ['light', 'dark', 'auto'];

/**
 * Registers the custom element and returns its class. Safe to call more than
 * once with the same tag. Light DOM on purpose: load
 * `@supersolutions/super-editor-ui/styles.css` once on the page, and the host's
 * CSS tokens (`--se-*`) style the document.
 *
 * Attributes: `mode="view|edit"` (default view), `theme="light|dark|auto"`.
 * Events: `change` (detail: SuperEditorChangeDetail), `error` (detail: SuperEditorErrorDetail).
 */
export function defineSuperEditor(options: { tag?: string; registry?: CustomElementRegistry; base?: typeof HTMLElement } = {}): CustomElementConstructor {
  const tag = options.tag ?? 'super-editor';
  const registry = options.registry ?? globalThis.customElements;
  const Base = options.base ?? globalThis.HTMLElement;
  if (!registry || !Base) throw new TypeError('defineSuperEditor needs a DOM with custom elements.');
  const existing = registry.get(tag);
  if (existing) return existing;

  class Element extends Base implements SuperEditorElement {
    static observedAttributes = ['mode', 'theme'];
    #editor: Editor | null = null;
    #unsubscribe: (() => void) | null = null;
    #mounted: { destroy(): void } | null = null;
    #connected = false;

    get editor(): Editor | null { return this.#editor; }
    get document(): ResearchDocument | null { return this.#editor ? this.#editor.getSnapshot() : null; }

    get mode(): SuperEditorMode { const m = this.getAttribute('mode'); return m === 'edit' ? 'edit' : 'view'; }
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

    connectedCallback(): void { this.#connected = true; this.#render(); }
    disconnectedCallback(): void { this.#connected = false; this.#teardown(); }
    attributeChangedCallback(): void { this.#render(); }

    #emit(type: 'change' | 'error', detail: SuperEditorChangeDetail | SuperEditorErrorDetail): void {
      const view = (this.ownerDocument.defaultView ?? globalThis) as typeof globalThis;
      this.dispatchEvent(new view.CustomEvent(type, { detail, bubbles: true }));
    }

    #teardown(): void {
      this.#mounted?.destroy();
      this.#mounted = null;
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
      if (this.mode === 'edit') {
        const actor: Actor = { id: 'element-user', kind: 'human' };
        this.#mounted = mountEditor(this, editor, { actor, document: doc, ...(theme ? { theme } : {}) });
      } else {
        this.append(renderDocument(editor.getSnapshot(), { document: doc, ...(theme ? { theme } : {}) }));
      }
    }
  }
  registry.define(tag, Element);
  return Element;
}
