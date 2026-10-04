import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

/** Small, dependency-free controls for the demo chrome. The editor and its panels come from `@super-solution/editor-react`. */
const PATHS = {
  menu: <path d="M2 4h12M2 8h12M2 12h12" />,
  panel: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M10 3v10" /></>,
  sun: <><circle cx="8" cy="8" r="2.6" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" /></>,
  moon: <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" />,
  auto: <><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" /></>,
  roomy: <path d="M3 3.5h10M3 8h10M3 12.5h10" />,
  tight: <path d="M3 2.5h10M3 5.25h10M3 8h10M3 10.75h10M3 13.5h10" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  chevron: <path d="M4 6l4 4 4-4" />,
};
export type IconName = keyof typeof PATHS;
export function Icon({ name }: { name: IconName }): ReactNode {
  return <svg className="icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{PATHS[name]}</svg>;
}

export type Option<T extends string> = { value: T; label: string; icon?: IconName };
/** A segmented switch: one button per option, the chosen one is `aria-pressed`. The label hides on phones and the icon stays. */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly Option<T>[]; onChange(value: T): void }): ReactNode {
  return <div className="seg" role="group" aria-label={label}>
    {options.map((option) => <button key={option.value} type="button" className="seg-button" aria-pressed={value === option.value} title={`${label}: ${option.label}`} onClick={() => onChange(option.value)}>
      {option.icon ? <Icon name={option.icon} /> : null}<span className="seg-label">{option.label}</span>
    </button>)}
  </div>;
}

/** A button that opens a menu. Arrow keys move, Escape closes and returns focus, a click elsewhere closes. */
export function Menu({ label, items }: { label: string; items: readonly { label: string; onSelect(): void }[] }): ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape') { setOpen(false); root.current?.querySelector('button')?.focus(); } };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape); };
  }, [open]);
  const move = (event: KeyboardEvent<HTMLElement>): void => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const entries = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    entries[(entries.indexOf(document.activeElement as HTMLElement) + step + entries.length) % entries.length]?.focus();
  };
  return <div className="menu" ref={root}>
    <button type="button" className="se-button menu-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label}<Icon name="chevron" /></button>
    {open ? <div className="menu-list" role="menu" aria-label={label} onKeyDown={move}>
      {items.map((item) => <button key={item.label} type="button" role="menuitem" onClick={() => { setOpen(false); item.onSelect(); }}>{item.label}</button>)}
    </div> : null}
  </div>;
}

/** Tab buttons with the roving-tabindex keyboard model (left/right/home/end). Pair each with a `role="tabpanel"`. */
export function Tabs<T extends string>({ label, value, tabs, onChange }: { label: string; value: T; tabs: readonly { id: T; label: string; count?: number }[]; onChange(id: T): void }): ReactNode {
  const move = (event: KeyboardEvent): void => {
    const index = tabs.findIndex((tab) => tab.id === value);
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length]!;
    onChange(tab.id);
    requestAnimationFrame(() => document.getElementById(`tab-${tab.id}`)?.focus());
  };
  return <div className="tabs" role="tablist" aria-label={label} onKeyDown={move}>
    {tabs.map((tab) => <button key={tab.id} id={`tab-${tab.id}`} type="button" role="tab" aria-selected={value === tab.id} aria-controls={`panel-${tab.id}`} tabIndex={value === tab.id ? 0 : -1} onClick={() => onChange(tab.id)}>
      {tab.label}{tab.count ? <span className="tab-count">{tab.count}</span> : null}
    </button>)}
  </div>;
}
