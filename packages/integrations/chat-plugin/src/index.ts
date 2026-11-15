// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { createEditor, validateDocument, type ResearchDocument } from '@supersolutions/super-editor-core';
import { mountEditor, renderDocument, type PartialLabels } from '@supersolutions/super-editor-ui';
import {
  EDITOR_CARD_KIND,
  editorCardKind,
  validateEditorCardSpec,
  type CardMount,
  type CardMountContext,
  type ChatPlugin,
  type EditorCardSpec,
} from '@supersolutions/super-protocol';

export type EditorChatPluginOptions = {
  /** Called when the user edits an inline document in the chat, so the host can persist it. */
  onChange?: (document: ResearchDocument, spec: EditorCardSpec) => void;
  /** Where a `service` reference is read from. Default: `${baseUrl}/documents/${documentId}/document`. */
  resolveServiceUrl?: (service: NonNullable<EditorCardSpec['service']>) => string;
  /** Extra request headers (authentication) for service reads. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof fetch;
  /** Who edits in the chat. Default `{ id: 'chat-user' }`; the kind is always human. */
  actor?: { id: string };
  /** Texts the plugin shows itself, for translation. The editor's own strings are `labels`. */
  messages?: { loading?: string; writing?: string; invalid?: string; loadFailed?: string };
  /** UI strings of the rendered document and the classic editor controls (see `Labels` in the UI package). */
  labels?: PartialLabels;
  /** Waits this long after the last edit before calling `onChange` (trailing; a pending call is flushed when the card is removed). Default 0: every revision. */
  debounceMs?: number;
};

const defaultServiceUrl = (s: NonNullable<EditorCardSpec['service']>): string =>
  `${s.baseUrl.replace(/\/+$/, '')}/documents/${encodeURIComponent(s.documentId)}/document`;

function note(container: HTMLElement, text: string, role?: string): void {
  const p = container.ownerDocument.createElement('p');
  p.className = 'super-editor-error';
  if (role) p.setAttribute('role', role);
  p.textContent = text;
  container.replaceChildren(p);
}

/** The chat plugin that shows `super-editor.document` cards. License: GPL-3.0-or-later. */
export function createEditorChatPlugin(options: EditorChatPluginOptions = {}): ChatPlugin {
  const mount: CardMount = (container, initialSpec, initialContext) => {
    let destroyed = false;
    let inner: { destroy(): void } | null = null;
    let controller: AbortController | null = null;
    let shown = '';
    let echoKey = '';
    let local: { id: string; editor: ReturnType<typeof createEditor> } | null = null;
    let pending: { document: ResearchDocument; spec: EditorCardSpec } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const text = { loading: 'Loading document…', writing: 'Document is still being written…', loadFailed: 'The document could not be loaded.', ...options.messages };
    const deliver = (): void => {
      clearTimeout(timer); timer = undefined;
      const call = pending; pending = null;
      if (call) options.onChange?.(call.document, call.spec);
    };

    const clear = (): void => {
      deliver();
      local = null;
      controller?.abort();
      controller = null;
      inner?.destroy();
      inner = null;
      container.replaceChildren();
    };

    const showDocument = (spec: EditorCardSpec, document: unknown, editable: boolean, context: CardMountContext): void => {
      const checked = validateDocument(document as ResearchDocument);
      if (!checked.ok) return note(container, checked.issues[0]?.message ?? 'Invalid document.', 'alert');
      const theme = context.theme;
      const doc = container.ownerDocument;
      if (editable) {
        const editor = createEditor(checked.value);
        local = { id: checked.value.id, editor };
        const unsubscribe = editor.subscribe(() => {
          pending = { document: editor.getSnapshot(), spec };
          if (options.debounceMs && options.debounceMs > 0) { clearTimeout(timer); timer = setTimeout(deliver, options.debounceMs); } else deliver();
        });
        const mounted = mountEditor(container, editor, { document: doc, theme, ...(context.locale ? { locale: context.locale } : {}), ...(options.labels ? { labels: options.labels } : {}), actor: { id: options.actor?.id ?? 'chat-user', kind: 'human' } });
        inner = { destroy: () => { unsubscribe(); mounted.destroy(); } };
      } else {
        container.replaceChildren(renderDocument(checked.value, { document: doc, theme, ...(context.locale ? { locale: context.locale } : {}), ...(options.labels ? { labels: options.labels } : {}) }));
      }
    };

    const render = (rawSpec: unknown, context: CardMountContext): void => {
      const signature = JSON.stringify([rawSpec, context.theme, context.locale ?? null, context.partial === true]);
      if (signature === shown) return;
      // A host that saves `onChange` and feeds the saved document back is echoing what the editor already shows: keep the editor
      // (and the caret) when the incoming copy is not newer than the local one and nothing else about the card changed.
      if (local && !context.partial && rawSpec && typeof rawSpec === 'object') {
        const incoming = (rawSpec as { document?: { id?: unknown; revision?: unknown } }).document;
        if (incoming && incoming.id === local.id && typeof incoming.revision === 'number' && incoming.revision <= local.editor.getSnapshot().revision) {
          const rest = JSON.stringify([{ ...(rawSpec as object), document: null }, context.theme, context.locale ?? null, false]);
          if (rest === echoKey) { shown = signature; return; }
        }
      }
      shown = signature;
      clear();
      echoKey = JSON.stringify([{ ...(rawSpec && typeof rawSpec === 'object' ? rawSpec as object : {}), document: null }, context.theme, context.locale ?? null, false]);
      if (context.partial) return note(container, text.writing);
      const valid = validateEditorCardSpec(rawSpec);
      if (!valid.ok) return note(container, options.messages?.invalid ?? valid.error, 'alert');
      const spec = rawSpec as EditorCardSpec;
      if (spec.document) return showDocument(spec, spec.document, spec.mode === 'edit', context);

      // A service reference is read-only: super-protocol rejects `mode: "edit"` with a service, and the plugin never writes to it.
      const service = spec.service!;
      const url = (options.resolveServiceUrl ?? defaultServiceUrl)(service);
      const own = new AbortController();
      controller = own;
      note(container, text.loading);
      void (async () => {
        try {
          const send = options.fetch ?? globalThis.fetch;
          const extra = options.headers ? await options.headers() : {};
          const response = await send(url, { signal: own.signal, headers: { accept: 'application/json', ...extra } });
          if (!response.ok) throw new Error(`The editor service answered ${response.status}.`);
          const body: unknown = await response.json();
          if (destroyed || own.signal.aborted) return;
          showDocument(spec, body, false, context);
        } catch (error) {
          if (destroyed || own.signal.aborted) return;
          note(container, error instanceof Error ? error.message : text.loadFailed, 'alert');
        }
      })();
    };

    render(initialSpec, initialContext);
    return {
      update: render,
      destroy() {
        destroyed = true;
        clear();
      },
    };
  };

  return {
    manifest: {
      manifestVersion: 0,
      name: '@supersolutions/super-editor-chat-plugin',
      version: '0.2.0',
      license: 'GPL-3.0-or-later',
      capabilities: [{ id: 'editor.document', surface: 'card', cardKind: EDITOR_CARD_KIND }],
    },
    cardKinds: [editorCardKind],
    mounts: { [EDITOR_CARD_KIND]: mount },
  };
}
