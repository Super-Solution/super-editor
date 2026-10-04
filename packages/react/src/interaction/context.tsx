import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Box, Interaction, InteractionState, SurfaceBinding } from '@super-solution/editor-ui';
import { defaultLabels, mergeLabels } from './labels.js';
import type { InteractionLabels } from './labels.js';

export const InteractionContext = createContext<Interaction | null>(null);
/** Pointer/layout binding of the surface the components live in. Null until the surface has mounted (and during server rendering). */
export const SurfaceContext = createContext<SurfaceBinding | null>(null);
export const LabelsContext = createContext<InteractionLabels>(defaultLabels);

export function InteractionProvider({ interaction, labels, children }: { interaction: Interaction; labels?: Partial<InteractionLabels>; children?: ReactNode }): ReactNode {
  return <InteractionContext.Provider value={interaction}><LabelsContext.Provider value={mergeLabels(labels)}>{children}</LabelsContext.Provider></InteractionContext.Provider>;
}
export function useInteraction(explicit?: Interaction): Interaction {
  const context = useContext(InteractionContext);
  const interaction = explicit ?? context;
  if (!interaction) throw new Error('Pass an interaction, or render inside <InteractionProvider> / <ReportEditor>.');
  return interaction;
}
export function useLabels(): InteractionLabels { return useContext(LabelsContext); }
export function useSurface(): SurfaceBinding | null { return useContext(SurfaceContext); }

/**
 * Subscribes to a slice of the interaction state. The component re-renders only when the selected value changes
 * (compared with Object.is, or `equals`). Return primitives or existing state objects from `select`, never fresh objects.
 */
export function useInteractionState<T>(interaction: Interaction, select: (state: InteractionState) => T, equals: (a: T, b: T) => boolean = Object.is): T {
  const last = useRef<{ value: T } | null>(null);
  const read = (): T => {
    const next = select(interaction.getState());
    if (last.current && equals(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  };
  return useSyncExternalStore(interaction.subscribe, read, read);
}
/** Re-renders when the document changes, so layout measurements taken after render see the new DOM. */
export function useDocumentRevision(interaction: Interaction): number {
  return useSyncExternalStore(interaction.editor.subscribe, () => interaction.editor.getSnapshot().revision, () => interaction.editor.getSnapshot().revision);
}
const sameBox = (a: Box | null, b: Box | null): boolean => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom);
/** Content-space box of a rendered block, re-measured after every render and whenever layout may have changed. */
export function useBlockRect(id: string | null): Box | null {
  const binding = useSurface();
  const [rect, setRect] = useState<Box | null>(null);
  const measure = (): void => { const next = id && binding ? binding.rectOf(id) : null; setRect((previous) => sameBox(previous, next) ? previous : next); };
  useLayoutEffect(measure);
  useLayoutEffect(() => binding?.subscribe(measure), [binding, id]);
  return binding ? rect : null;
}
/** True on touch-first devices, where hover does not exist and handles must be reachable another way. */
export function useCoarsePointer(): boolean {
  const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null;
  return useSyncExternalStore(
    (listener) => { query?.addEventListener?.('change', listener); return () => query?.removeEventListener?.('change', listener); },
    () => !!query?.matches, () => false);
}
