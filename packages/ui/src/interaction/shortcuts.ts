import type { Platform } from './types.js';

/** Platform-aware keyboard shortcut registry. `Mod` is Cmd on macOS and Ctrl elsewhere. Headless: it only needs event-shaped objects. */
export type KeyEventLike = {
  key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean;
  isComposing?: boolean; keyCode?: number; repeat?: boolean; preventDefault(): void; stopPropagation?(): void;
};
export type ParsedShortcut = { mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string };
const ALIASES: Record<string, string> = { esc: 'escape', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', space: ' ', del: 'delete', return: 'enter', plus: '+' };

export function detectPlatform(navigatorLike: { platform?: string; userAgent?: string } | undefined = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator): Platform {
  const text = `${navigatorLike?.platform ?? ''} ${navigatorLike?.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/i.test(text) ? 'mac' : 'other';
}
export function parseShortcut(spec: string): ParsedShortcut {
  const parts = spec.split('+').map((part) => part.trim()).filter(Boolean);
  if (spec.trim().endsWith('++')) parts.push('+');
  const result: ParsedShortcut = { mod: false, ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'mod') result.mod = true;
    else if (lower === 'ctrl' || lower === 'control') result.ctrl = true;
    else if (lower === 'alt' || lower === 'option') result.alt = true;
    else if (lower === 'shift') result.shift = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') result.meta = true;
    else result.key = ALIASES[lower] ?? lower;
  }
  if (!result.key) throw new TypeError(`Shortcut "${spec}" has no key.`);
  return result;
}
function keyMatches(shortcut: ParsedShortcut, event: KeyEventLike): boolean {
  const key = (event.key ?? '').toLowerCase(), code = event.code ?? '';
  if (/^[a-z]$/.test(shortcut.key)) return key === shortcut.key || (!/^[a-z]$/.test(key) && code === `Key${shortcut.key.toUpperCase()}`);
  if (/^[0-9]$/.test(shortcut.key)) return code === `Digit${shortcut.key}` || code === `Numpad${shortcut.key}` || key === shortcut.key;
  return key === shortcut.key;
}
export function matchesShortcut(shortcut: ParsedShortcut, event: KeyEventLike, platform: Platform): boolean {
  const wantMeta = shortcut.meta || (shortcut.mod && platform === 'mac'), wantCtrl = shortcut.ctrl || (shortcut.mod && platform !== 'mac');
  if (!!event.metaKey !== wantMeta || !!event.ctrlKey !== wantCtrl || !!event.altKey !== shortcut.alt) return false;
  // Characters that need Shift on some layouts ("?", "/") do not require it in the spec.
  const symbol = shortcut.key.length === 1 && !/[a-z0-9]/.test(shortcut.key);
  if (!symbol && !!event.shiftKey !== shortcut.shift) return false;
  return keyMatches(shortcut, event);
}
const MAC_SYMBOLS: Record<string, string> = { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' };
const KEY_LABELS: Record<string, string> = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', escape: 'Esc', enter: 'Enter', backspace: 'Backspace', delete: 'Del', tab: 'Tab', ' ': 'Space' };
/** Human label: `⌘⇧S` on macOS, `Ctrl+Shift+S` elsewhere. */
export function formatShortcut(spec: string, platform: Platform): string {
  const shortcut = parseShortcut(spec), key = KEY_LABELS[shortcut.key] ?? shortcut.key.toUpperCase();
  if (platform === 'mac') return `${shortcut.ctrl ? MAC_SYMBOLS.ctrl : ''}${shortcut.alt ? MAC_SYMBOLS.alt : ''}${shortcut.shift ? MAC_SYMBOLS.shift : ''}${shortcut.mod || shortcut.meta ? MAC_SYMBOLS.mod : ''}${key}`;
  return [shortcut.mod || shortcut.ctrl ? 'Ctrl' : '', shortcut.meta ? 'Meta' : '', shortcut.alt ? 'Alt' : '', shortcut.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

export type ShortcutDefinition<C> = {
  id: string; keys: readonly string[]; description: string; group: string;
  /** The shortcut is only considered while this returns true. */
  when?: (context: C) => boolean;
  /** Higher runs first. Default 0. Context-specific bindings (slash menu open) use 100. */
  priority?: number;
  /** Return false to decline the event so lower-priority bindings and the browser can handle it. */
  run(context: C, event: KeyEventLike): boolean | void;
  /** Hide from help listings (internal navigation keys). */
  hidden?: boolean;
};
export type ShortcutInfo = { id: string; group: string; description: string; keys: string[]; display: string[]; hidden: boolean; disabled: boolean };
export type ShortcutRegistry<C> = {
  register(definition: ShortcutDefinition<C>): () => void;
  /** Replace the keys of a binding. `null` disables it. Unknown ids are remembered and applied if they register later. */
  override(id: string, keys: readonly string[] | null): void;
  keysFor(id: string): string[];
  list(): ShortcutInfo[];
  handle(event: KeyEventLike, context: C): boolean;
  setPlatform(platform: Platform): void;
  readonly platform: Platform;
};
export function createShortcutRegistry<C>(options: { platform?: Platform } = {}): ShortcutRegistry<C> {
  let platform = options.platform ?? detectPlatform();
  const definitions: ShortcutDefinition<C>[] = [];
  const overrides = new Map<string, readonly string[] | null>();
  const parsedCache = new Map<string, ParsedShortcut>();
  const parse = (spec: string): ParsedShortcut => { let parsed = parsedCache.get(spec); if (!parsed) { parsed = parseShortcut(spec); parsedCache.set(spec, parsed); } return parsed; };
  const keys = (definition: ShortcutDefinition<C>): readonly string[] => overrides.has(definition.id) ? overrides.get(definition.id) ?? [] : definition.keys;
  return {
    get platform() { return platform; },
    setPlatform(next) { platform = next; },
    register(definition) {
      for (const spec of definition.keys) parse(spec);
      const index = definitions.findIndex((entry) => entry.id === definition.id);
      if (index !== -1) definitions.splice(index, 1);
      definitions.push(definition);
      return () => { const at = definitions.indexOf(definition); if (at !== -1) definitions.splice(at, 1); };
    },
    override(id, next) { if (next) for (const spec of next) parse(spec); overrides.set(id, next); },
    keysFor(id) { const definition = definitions.find((entry) => entry.id === id); return definition ? [...keys(definition)] : []; },
    list() {
      return definitions.map((definition) => ({ id: definition.id, group: definition.group, description: definition.description, keys: [...keys(definition)], display: keys(definition).map((spec) => formatShortcut(spec, platform)), hidden: !!definition.hidden, disabled: keys(definition).length === 0 }));
    },
    handle(event, context) {
      if (event.isComposing || event.keyCode === 229) return false;
      const ordered = definitions.map((definition, index) => ({ definition, index })).sort((a, b) => (b.definition.priority ?? 0) - (a.definition.priority ?? 0) || a.index - b.index);
      for (const { definition } of ordered) {
        if (!keys(definition).some((spec) => matchesShortcut(parse(spec), event, platform))) continue;
        if (definition.when && !definition.when(context)) continue;
        if (definition.run(context, event) === false) continue;
        event.preventDefault();
        return true;
      }
      return false;
    },
  };
}
