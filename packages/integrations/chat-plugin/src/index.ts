// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { createEditor, validateDocument, type ResearchDocument } from '@supersolutions/super-editor-core';
import { mountEditor, renderDocument } from '@supersolutions/super-editor-ui';
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

    const clear = (): void => {
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
        const unsubscribe = editor.subscribe(() => options.onChange?.(editor.getSnapshot(), spec));
        const mounted = mountEditor(container, editor, { document: doc, theme, actor: { id: 'chat-user', kind: 'human' } });
        inner = { destroy: () => { unsubscribe(); mounted.destroy(); } };
      } else {
        container.replaceChildren(renderDocument(checked.value, { document: doc, theme }));
      }
    };

    const render = (rawSpec: unknown, context: CardMountContext): void => {
      const signature = JSON.stringify([rawSpec, context.theme, context.partial === true]);
      if (signature === shown) return;
      shown = signature;
      clear();
      if (context.partial) return note(container, 'Document is still being written…');
      const valid = validateEditorCardSpec(rawSpec);
      if (!valid.ok) return note(container, valid.error, 'alert');
      const spec = rawSpec as EditorCardSpec;
      if (spec.document) return showDocument(spec, spec.document, spec.mode === 'edit', context);

      // A service reference is read-only: the plugin shows the server's document, it does not write back.
      const service = spec.service!;
      const url = (options.resolveServiceUrl ?? defaultServiceUrl)(service);
      const own = new AbortController();
      controller = own;
      note(container, 'Loading document…');
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
          note(container, error instanceof Error ? error.message : 'The document could not be loaded.', 'alert');
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
      version: '0.1.0',
      license: 'GPL-3.0-or-later',
      capabilities: [{ id: 'editor.document', surface: 'card', cardKind: EDITOR_CARD_KIND }],
    },
    cardKinds: [editorCardKind],
    mounts: { [EDITOR_CARD_KIND]: mount },
  };
}
