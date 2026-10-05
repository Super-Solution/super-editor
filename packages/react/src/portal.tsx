import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { watchTheme } from '@super-solution/editor-ui';

/**
 * Where modal and floating layers (the shortcut dialog, the toast stack) are mounted.
 *  - `null`, or `undefined` when no `PortalProvider` above says otherwise: `document.body`. This is the default, because a layer drawn
 *    with `position: fixed` is positioned against the nearest ancestor that has a `transform`, `filter`, `perspective`,
 *    `container-type`, `contain` or `will-change`; under <body> nothing of the host's layout can trap it.
 *  - an element, or a function returning one: that element, for hosts that scope their own theme, z-index or inert handling to a root.
 *  - `false`: do not portal; the layer renders in place, inside the editor.
 */
export type PortalContainer = HTMLElement | (() => HTMLElement | null | undefined) | null | undefined | false;

type PortalSetting = { container: PortalContainer };
const PortalContext = createContext<PortalSetting | null>(null);

/**
 * Sets the portal container for every layer below it (`ReportEditor` does this from its `portalContainer` prop).
 * Without a `container` it keeps the one it inherits, if any.
 */
export function PortalProvider({ container, children }: { container?: PortalContainer; children?: ReactNode }): ReactNode {
  const inherited = useContext(PortalContext);
  const chosen = container !== undefined ? container : inherited?.container;
  const value = useMemo<PortalSetting>(() => ({ container: chosen }), [chosen]);
  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}
/** The portal setting of the nearest `PortalProvider`, or null outside one. */
export function usePortalSetting(): PortalSetting | null { return useContext(PortalContext); }

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
const never = (): (() => void) => () => undefined;
/** False while rendering on the server and while hydrating, true on the client afterwards: no `document` access before it flips. */
function useClientReady(): boolean { return useSyncExternalStore(never, () => true, () => false); }

type Look = { theme?: string | undefined; density?: string | undefined; dir?: string | undefined; lang?: string | undefined };
const NO_LOOK: Look = {};
const attribute = (from: Element, name: string): string | undefined => from.closest(`[${name}]`)?.getAttribute(name) ?? undefined;

/**
 * Renders `children` under another element (default `document.body`) so ancestors of the editor cannot trap or clip them.
 * The content sits in a `<div class="super-editor se-portal">` with the `data-se-theme`, `data-se-density`, `dir` and `lang` of the
 * place it was declared in, so the `--se-*` tokens (theme, density, anything the host scoped to those) resolve exactly as they do
 * inside the editor; the wrapper itself generates no box (`display: contents`). It renders nothing on the server.
 */
export function OverlayPortal({ container, children }: { container?: PortalContainer; children?: ReactNode }): ReactNode {
  const setting = useContext(PortalContext);
  const where = container !== undefined ? container : setting?.container;
  const ready = useClientReady();
  const marker = useRef<HTMLSpanElement>(null);
  const [look, setLook] = useState<Look>(NO_LOOK);
  const portaled = where !== false && ready;
  // The marker stays where the layer was declared; the look is read from there, and again whenever the theme changes.
  useIsoLayoutEffect(() => {
    const node = marker.current;
    if (!portaled || !node) return;
    const read = (): void => {
      const next: Look = { theme: attribute(node, 'data-se-theme'), density: attribute(node, 'data-se-density'), dir: attribute(node, 'dir'), lang: attribute(node, 'lang') };
      setLook((current) => current.theme === next.theme && current.density === next.density && current.dir === next.dir && current.lang === next.lang ? current : next);
    };
    read();
    return watchTheme(node, read);
  }, [portaled]);
  if (where === false) return <>{children}</>;
  if (!ready) return null;
  const target = typeof where === 'function' ? where() : where;
  const root = target ?? document.body;
  return <>
    <span ref={marker} hidden data-se-portal-anchor="" />
    {createPortal(<div className="super-editor se-portal" data-se-theme={look.theme} data-se-density={look.density} dir={look.dir} lang={look.lang}>{children}</div>, root)}
  </>;
}
