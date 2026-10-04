import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Interaction, MenuAction } from '@super-solution/editor-ui';
import { useBlockRect, useDocumentRevision, useInteraction, useInteractionState, useInteractionLabels, useSurface } from './context.js';
import { useIsoLayoutEffect, useKeepInViewport } from './util.js';

/**
 * The block menu opened from the gutter handle: turn into, duplicate, copy id/link, move and delete. Arrow keys move through the
 * items, Right opens "Turn into", Left or Esc goes back, and focus returns to the document when it closes.
 */
export function BlockActionMenu({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit), labels = useInteractionLabels(), binding = useSurface();
  const menu = useInteractionState(interaction, (state) => state.menu);
  useDocumentRevision(interaction);
  const rect = useBlockRect(menu?.anchorId ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const shift = useKeepInViewport(ref, !!menu);
  const submenu = menu?.submenu ?? null;
  // Focus the first enabled item whenever the menu (or its submenu) opens.
  useIsoLayoutEffect(() => {
    if (!menu || !rect) return;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true });
  }, [!!menu && !!rect, submenu]);
  useIsoLayoutEffect(() => {
    if (!menu || !rect || typeof document === 'undefined') return;
    const away = (event: Event): void => { const target = event.target as Node | null; if (target && ref.current && !ref.current.contains(target) && !(target as Element).closest?.('[data-se-drag-handle]')) interaction.menu.close(); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [!!menu && !!rect]);
  if (!menu || !rect) return null;
  const actions = interaction.menu.actions();
  const items: MenuAction[] = submenu === 'turn-into' ? actions.find((action) => action.id === 'turn-into')?.children ?? [] : actions;
  const close = (): void => { interaction.menu.close(); binding?.root.focus({ preventScroll: true }); };
  const onKeyDown = (event: KeyboardEvent): void => {
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const at = nodes.indexOf(event.target as HTMLElement);
    const focus = (index: number): void => { event.preventDefault(); nodes[(index + nodes.length) % nodes.length]?.focus(); };
    switch (event.key) {
      case 'ArrowDown': focus(at + 1); break;
      case 'ArrowUp': focus(at <= 0 ? nodes.length - 1 : at - 1); break;
      case 'Home': focus(0); break;
      case 'End': focus(nodes.length - 1); break;
      case 'ArrowRight': if ((event.target as HTMLElement).getAttribute('aria-haspopup')) { event.preventDefault(); (event.target as HTMLElement).click(); } break;
      case 'ArrowLeft': if (submenu) { event.preventDefault(); interaction.menu.openSubmenu(null); } break;
      case 'Escape': event.preventDefault(); event.stopPropagation(); if (submenu) interaction.menu.openSubmenu(null); else close(); break;
      case 'Tab': close(); break;
    }
  };
  return <div ref={ref} className="se-popup se-menu" data-se-popup role="menu" aria-label={submenu ? labels.turnInto : labels.blockMenu} onKeyDown={onKeyDown}
    style={{ left: Math.max(0, rect.left - 4), top: rect.top + 30, ...(shift ? { transform: `translateY(-${shift}px)` } : {}) }}>
    {submenu ? <button type="button" role="menuitem" className="se-menu-item se-menu-back" tabIndex={-1} onClick={() => interaction.menu.openSubmenu(null)}><span className="se-menu-icon" aria-hidden="true">{'←'}</span><span className="se-menu-label">{labels.turnInto}</span></button> : null}
    {items.map((action) => <button key={action.id} type="button" role="menuitem" tabIndex={-1} className={`se-menu-item${action.danger ? ' se-menu-danger' : ''}${action.current ? ' se-menu-current' : ''}`}
      aria-disabled={action.disabled ? true : undefined} aria-haspopup={action.children ? 'menu' : undefined} aria-current={action.current ? 'true' : undefined} data-se-action={action.id}
      onClick={() => { if (!action.disabled) interaction.menu.run(action.id); }}>
      {action.icon ? <span className="se-menu-icon" aria-hidden="true">{action.icon}</span> : null}
      <span className="se-menu-label">{action.label}</span>
      {action.shortcut ? <kbd className="se-menu-shortcut">{action.shortcut}</kbd> : null}
      {action.children ? <span className="se-menu-chevron" aria-hidden="true">{'›'}</span> : null}
    </button>)}
  </div>;
}
