import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';

/** `useLayoutEffect` that stays quiet during server rendering. */
export const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
/** Keeps focus (and the text selection) in the editor when a toolbar or menu is pressed. */
export const keepFocus = (event: ReactMouseEvent | { preventDefault(): void }): void => { event.preventDefault(); };
/**
 * Pixels (right, up) that bring a popup fully into the viewport. Measured after each render, so popups never open off screen.
 * The popup is moved with a CSS transform, so the shift never changes its layout position.
 */
export function useKeepInViewport(ref: RefObject<HTMLElement | null>, active: boolean): { x: number; y: number } {
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const last = useRef(shift);
  useIsoLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element || typeof window === 'undefined') return;
    const rect = element.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) return;
    const bottom = rect.bottom + last.current.y, top = rect.top + last.current.y, right = rect.right + last.current.x, left = rect.left + last.current.x;
    const overY = bottom - (window.innerHeight - 8), overX = right - (window.innerWidth - 8);
    const next = { y: overY > 0 ? Math.min(overY, Math.max(0, top - 8)) : 0, x: overX > 0 ? Math.min(overX, Math.max(0, left - 8)) : 0 };
    if (next.x !== last.current.x || next.y !== last.current.y) { last.current = next; setShift(next); }
  });
  return active ? shift : { x: 0, y: 0 };
}
export const shiftTransform = (shift: { x: number; y: number }, base = ''): string | undefined => shift.x || shift.y ? `${base} translate(${-shift.x}px, ${-shift.y}px)`.trim() : base || undefined;
