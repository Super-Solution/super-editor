import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';

/** `useLayoutEffect` that stays quiet during server rendering. */
export const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
/** Keeps focus (and the text selection) in the editor when a toolbar or menu is pressed. */
export const keepFocus = (event: ReactMouseEvent | { preventDefault(): void }): void => { event.preventDefault(); };
/**
 * Vertical shift, in pixels, that brings a popup fully into the viewport. Measured after each render, so popups never open off screen.
 */
export function useKeepInViewport(ref: RefObject<HTMLElement | null>, active: boolean): number {
  const [shift, setShift] = useState(0);
  const last = useRef(0);
  useIsoLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element || typeof window === 'undefined') return;
    const rect = element.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) return;
    const bottom = rect.bottom + last.current, top = rect.top + last.current, overflow = bottom - (window.innerHeight - 8);
    const next = overflow > 0 ? Math.min(overflow, Math.max(0, top - 8)) : 0;
    if (next !== last.current) { last.current = next; setShift(next); }
  });
  return active ? shift : 0;
}
