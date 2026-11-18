// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { createEditor, createReportService, validateDocument, type Actor, type AsyncReportService, type ReportService, type ResearchDocument } from '@supersolutions/super-editor-core';
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
import { readHostTheme, type HostCardContext, type HostTheme, type ThemeToken } from './protocol-next.js';
import { createEditorTools, type EditorToolTarget } from './tools.js';

export type EditorChatPluginOptions = {
  /** Documents the agent's tools can reach by id without a card on screen, such as ones kept in the host's database. */
  resolveDocument?: (documentId: string) => ReportService | AsyncReportService | undefined | Promise<ReportService | AsyncReportService | undefined>;
  /** Recorded on every revision the agent's tools create. Default `{ id: 'chat-agent', kind: 'agent' }`. */
  agentActor?: Actor;
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

const MAX_KEPT_EDITORS = 64;

const THEME_VARIABLES: Readonly<Record<string, ThemeToken>> = {
  '--se-bg': 'background', '--se-surface': 'surface', '--se-subtle': 'surface-raised', '--se-hover': 'surface-raised', '--se-code-bg': 'surface-raised',
  '--se-text': 'text', '--se-muted': 'text-muted', '--se-border': 'border', '--se-border-strong': 'border',
  '--se-accent': 'accent', '--se-accent-contrast': 'accent-contrast', '--se-link': 'accent', '--se-focus': 'accent',
  '--se-up': 'positive', '--se-tone-success': 'positive', '--se-down': 'negative', '--se-error': 'negative', '--se-tone-danger': 'negative',
  '--se-tone-warning': 'warning', '--se-tone-info': 'info', '--se-font-sans': 'font-sans', '--se-font-mono': 'font-mono', '--se-radius': 'radius',
};

/** Puts the host's look on the card's own container, where the document inherits it. Returns how to take it off again. */
function applyHostTheme(container: HTMLElement, theme: HostTheme): () => void {
  container.dataset.seTheme = theme.mode;
  const set: string[] = [];
  for (const [variable, token] of Object.entries(THEME_VARIABLES)) {
    const value = theme.tokens[token];
    if (value !== undefined) { container.style.setProperty(variable, value); set.push(variable); }
  }
  return () => { delete container.dataset.seTheme; for (const variable of set) container.style.removeProperty(variable); };
}

/** The chat plugin for `super-editor.document` cards and the tools an agent edits them with. License: GPL-3.0-or-later. */
export function createEditorChatPlugin(options: EditorChatPluginOptions = {}): ChatPlugin {
  const onScreen = new Map<string, EditorToolTarget>();
  const release = (id: string, target: EditorToolTarget): void => { if (onScreen.get(id) === target) onScreen.delete(id); };
  // A chat host may remount a card at any time (a finished turn does). The editor outlives the mount, so what the user and the
  // agent wrote is still there when the same card comes back. A card with a different document starts fresh.
  const kept = new Map<string, { source: string; editor: ReturnType<typeof createEditor> }>();
  const editorFor = (document: ResearchDocument): ReturnType<typeof createEditor> => {
    const source = JSON.stringify(document);
    const existing = kept.get(document.id);
    const editor = existing?.source === source ? existing.editor : createEditor(document);
    kept.delete(document.id);
    kept.set(document.id, { source, editor });
    if (kept.size > MAX_KEPT_EDITORS) kept.delete(kept.keys().next().value as string);
    return editor;
  };

  const mount: CardMount = (container, initialSpec, initialContext) => {
    let destroyed = false;
    let shownTarget: { id: string; target: EditorToolTarget } | null = null;
    let removeTheme: (() => void) | null = null;
    let themeKey = '';
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
      if (shownTarget) release(shownTarget.id, shownTarget.target);
      shownTarget = null;
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
      // With a host theme the container carries the look; a theme attribute on the document would override what it inherits.
      const theme = readHostTheme((context as HostCardContext).hostTheme) ? undefined : context.theme;
      const doc = container.ownerDocument;
      const expose = (service: ReportService): void => {
        const target = { service, writable: editable };
        // Re-inserted so the newest card is the default target.
        onScreen.delete(checked.value.id);
        onScreen.set(checked.value.id, target);
        shownTarget = { id: checked.value.id, target };
      };
      if (editable) {
        const editor = editorFor(checked.value);
        expose(createReportService(editor));
        local = { id: checked.value.id, editor };
        const unsubscribe = editor.subscribe(() => {
          pending = { document: editor.getSnapshot(), spec };
          if (options.debounceMs && options.debounceMs > 0) { clearTimeout(timer); timer = setTimeout(deliver, options.debounceMs); } else deliver();
        });
        const mounted = mountEditor(container, editor, { document: doc, ...(theme ? { theme } : {}), ...(context.locale ? { locale: context.locale } : {}), ...(options.labels ? { labels: options.labels } : {}), actor: { id: options.actor?.id ?? 'chat-user', kind: 'human' } });
        inner = { destroy: () => { unsubscribe(); mounted.destroy(); } };
      } else {
        expose(createReportService(createEditor(checked.value)));
        container.replaceChildren(renderDocument(checked.value, { document: doc, ...(theme ? { theme } : {}), ...(context.locale ? { locale: context.locale } : {}), ...(options.labels ? { labels: options.labels } : {}) }));
      }
    };

    const render = (rawSpec: unknown, context: CardMountContext): void => {
      const hostTheme = readHostTheme((context as HostCardContext).hostTheme);
      const nextThemeKey = hostTheme ? JSON.stringify(hostTheme) : '';
      if (nextThemeKey !== themeKey) {
        removeTheme?.();
        removeTheme = hostTheme ? applyHostTheme(container, hostTheme) : null;
      }
      themeKey = nextThemeKey;
      // A host theme lives on the container, so changing it never remounts the document or loses an edit.
      const themeInSignature = hostTheme ? 'host' : context.theme;
      const signature = JSON.stringify([rawSpec, themeInSignature, context.locale ?? null, context.partial === true]);
      if (signature === shown) return;
      // A host that saves `onChange` and feeds the saved document back is echoing what the editor already shows: keep the editor
      // (and the caret) when the incoming copy is not newer than the local one and nothing else about the card changed.
      if (local && !context.partial && rawSpec && typeof rawSpec === 'object') {
        const incoming = (rawSpec as { document?: { id?: unknown; revision?: unknown } }).document;
        if (incoming && incoming.id === local.id && typeof incoming.revision === 'number' && incoming.revision <= local.editor.getSnapshot().revision) {
          const rest = JSON.stringify([{ ...(rawSpec as object), document: null }, themeInSignature, context.locale ?? null, false]);
          if (rest === echoKey) { shown = signature; return; }
        }
      }
      shown = signature;
      const nextRest = JSON.stringify([{ ...(rawSpec && typeof rawSpec === 'object' ? rawSpec as object : {}), document: null }, themeInSignature, context.locale ?? null, false]);
      clear();
      echoKey = nextRest;
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
        removeTheme?.();
        removeTheme = null;
      },
    };
  };

  const tools = createEditorTools({
    actor: options.agentActor ?? { id: 'chat-agent', kind: 'agent' },
    resolve: async (documentId) => {
      if (documentId === undefined) return [...onScreen.values()].pop();
      const shown = onScreen.get(documentId);
      if (shown) return shown;
      const service = await options.resolveDocument?.(documentId);
      return service ? { service, writable: true } : undefined;
    },
    list: async () => Promise.all([...onScreen.entries()].map(async ([documentId, target]) => {
      const document = await target.service.read();
      return { documentId, title: document.title, revision: document.revision, writable: target.writable };
    })),
  });

  return {
    manifest: {
      manifestVersion: 0,
      name: '@supersolutions/super-editor-chat-plugin',
      version: '0.2.0',
      license: 'GPL-3.0-or-later',
      capabilities: [
        { id: 'editor.document', surface: 'card', cardKind: EDITOR_CARD_KIND },
        ...tools.map((tool) => ({ id: `editor.tool.${tool.name.replace(/^editor_/, '').replace(/_/g, '-')}`, surface: 'tool' as const, toolName: tool.name })),
      ],
    },
    cardKinds: [editorCardKind],
    mounts: { [EDITOR_CARD_KIND]: mount },
    tools,
  };
}
