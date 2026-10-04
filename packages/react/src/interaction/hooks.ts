import { useEffect, useMemo, useRef, useState } from 'react';
import { attachInteraction, createInteraction, formatShortcut, groupSlashItems, indicatorFor } from '@super-solution/editor-ui';
import type { DropIndicator, DropTarget, Interaction, InteractionOptions, ShortcutInfo, SlashGroup, SlashItem, SlashState, SurfaceBinding, SurfaceOptions } from '@super-solution/editor-ui';
import type { Editor } from '@super-solution/editor-core';
import { useDocumentRevision, useInteraction, useInteractionState, useSurface } from './context.js';
import { useIsoLayoutEffect } from './util.js';

/**
 * Creates the interaction layer for an editor and ties its lifetime to the component: it follows the document while mounted and
 * commits pending typing when unmounted. Option callbacks may change on every render without recreating the layer.
 */
export function useCreateInteraction(editor: Editor, options: InteractionOptions = {}): Interaction {
  const latest = useRef(options);
  latest.current = options;
  const interaction = useMemo(() => createInteraction(editor, {
    ...options, autoStart: false,
    onConflict: (info) => latest.current.onConflict?.(info),
    onFeedback: (event) => latest.current.onFeedback?.(event),
    copyText: (text) => latest.current.copyText ? latest.current.copyText(text) : (globalThis as { navigator?: { clipboard?: { writeText(value: string): Promise<void> } } }).navigator?.clipboard?.writeText(text),
    // The actor, shortcuts, slash items and other creation-time options are read once per editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [editor]);
  useEffect(() => { interaction.activate(); return () => interaction.deactivate(); }, [interaction]);
  const readOnly = !!options.readOnly;
  useIsoLayoutEffect(() => { if (interaction.getState().readOnly !== readOnly) interaction.setReadOnly(readOnly); }, [interaction, readOnly]);
  return interaction;
}

/** Block selection: ids in document order, and the actions that change them. */
export function useSelection(explicit?: Interaction): {
  ids: readonly string[]; count: number; anchorId: string | null; focusId: string | null; isSelected(id: string): boolean;
  select: Interaction['selection']['select']; set: Interaction['selection']['set']; selectAll(): void; clear(): void; move: Interaction['selection']['move'];
} {
  const interaction = useInteraction(explicit);
  const selection = useInteractionState(interaction, (state) => state.selection);
  return useMemo(() => ({
    ids: selection.ids, count: selection.ids.length, anchorId: selection.anchorId, focusId: selection.focusId, isSelected: (id: string) => selection.ids.includes(id),
    select: interaction.selection.select, set: interaction.selection.set, selectAll: interaction.selection.selectAll, clear: interaction.selection.clear, move: interaction.selection.move,
  }), [interaction, selection]);
}
/** Every document command (delete, duplicate, move, turn into, insert, undo/redo, table and chart edits) with human attribution and version guards. */
export function useCommands(explicit?: Interaction): Interaction['commands'] & { readOnly: boolean } {
  const interaction = useInteraction(explicit);
  const readOnly = useInteractionState(interaction, (state) => state.readOnly);
  return useMemo(() => ({ ...interaction.commands, readOnly }), [interaction, readOnly]);
}
/** The shortcut registry: grouped listing for help UIs, rebinding, and a key handler for custom event targets. */
export function useShortcuts(explicit?: Interaction): {
  groups: { group: string; items: ShortcutInfo[] }[]; list(): ShortcutInfo[]; override(id: string, keys: readonly string[] | null): void;
  handleKeyDown: Interaction['shortcuts']['handleKeyDown']; label(id: string): string | undefined; platform: Interaction['platform'];
} {
  const interaction = useInteraction(explicit);
  return useMemo(() => {
    const registry = interaction.shortcuts;
    const list = (): ShortcutInfo[] => registry.list().filter((entry) => !entry.hidden);
    const groups = new Map<string, ShortcutInfo[]>();
    for (const entry of list()) { if (entry.disabled) continue; const items = groups.get(entry.group); if (items) items.push(entry); else groups.set(entry.group, [entry]); }
    return {
      groups: [...groups].map(([group, items]) => ({ group, items })), list, override: registry.override, handleKeyDown: registry.handleKeyDown, platform: interaction.platform,
      label: (id: string) => { const key = registry.keysFor(id)[0]; return key ? formatShortcut(key, interaction.platform) : undefined; },
    };
  }, [interaction]);
}
/** State and actions of the "/" menu. */
export function useSlashMenu(explicit?: Interaction): {
  open: boolean; state: SlashState | null; query: string; items: readonly SlashItem[]; groups: SlashGroup[]; activeIndex: number;
  openAfter(blockId: string): void; setQuery(query: string): void; move(delta: -1 | 1): void; setActive(index: number): void; run(item?: SlashItem, input?: string): void; close(): void;
} {
  const interaction = useInteraction(explicit);
  const state = useInteractionState(interaction, (current) => current.slash);
  const slash = interaction.slash;
  return useMemo(() => ({
    open: state !== null, state, query: state?.query ?? '', items: state?.items ?? [], groups: groupSlashItems(state?.items ?? []), activeIndex: state?.activeIndex ?? 0,
    openAfter: slash.openAfter, setQuery: slash.setQuery, move: slash.move, setActive: slash.setActive, run: (item?: SlashItem, input?: string) => { slash.run(item, input); }, close: slash.close,
  }), [state, slash]);
}
/** Drag-and-drop state for custom drag UIs; the default pointer handling is attached by the surface. */
export function useDragAndDrop(explicit?: Interaction): {
  dragging: boolean; ids: readonly string[]; target: DropTarget | null; indicator: DropIndicator | null;
  start(ids: readonly string[], pointerType?: string): boolean; cancel(): void; drop(): void;
} {
  const interaction = useInteraction(explicit), binding = useSurface();
  const drag = useInteractionState(interaction, (state) => state.drag);
  useDocumentRevision(interaction);
  const indicator = drag?.target && binding ? indicatorFor(binding.layout(), drag.target, { expandLeft: 56 }, drag.ids) : null;
  return { dragging: drag !== null, ids: drag?.ids ?? [], target: drag?.target ?? null, indicator, start: interaction.drag.start, cancel: interaction.drag.cancel, drop: () => { interaction.drag.drop(); } };
}

/** Binds pointer, keyboard and clipboard handling to a root element; returns the layout binding overlays measure with. */
export function useSurfaceBinding(interaction: Interaction, options?: SurfaceOptions): { ref: (element: HTMLElement | null) => void; binding: SurfaceBinding | null } {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [binding, setBinding] = useState<SurfaceBinding | null>(null);
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!element) return;
    const attached = attachInteraction(element, interaction, latest.current);
    setBinding(attached);
    return () => { attached.destroy(); setBinding(null); };
  }, [element, interaction]);
  return { ref: setElement, binding };
}
