// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import type { CardMountContext, PluginTool } from '@supersolutions/super-protocol';

/**
 * The parts of `@supersolutions/super-protocol` 0.2.0 this plugin uses while the package still pins 0.1.0 from npm.
 * The shapes match 0.2.0 exactly. Once 0.2.0 is published, import them from the protocol and delete this file.
 */
export type PluginToolAuthority = 'read' | 'draft' | 'act';
export type PluginToolRunContext = { signal?: AbortSignal; confirmed?: boolean };
export type AuthorizedPluginTool = Omit<PluginTool, 'run'> & {
  authority: PluginToolAuthority;
  confirm?: boolean;
  run(input: unknown, context: PluginToolRunContext): Promise<unknown>;
};

export const THEME_TOKENS = ['background', 'surface', 'surface-raised', 'border', 'text', 'text-muted', 'accent', 'accent-contrast', 'positive', 'negative', 'warning', 'info', 'font-sans', 'font-mono', 'radius'] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];
export type HostTheme = { mode: 'light' | 'dark'; tokens: Partial<Record<ThemeToken, string>> };
export type HostCardContext = CardMountContext & { hostTheme?: HostTheme };

const UNSAFE_VALUE = /[;{}<>\\]|\/\*|url\s*\(|expression\s*\(|@import/i;
const isThemeValue = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 256 && !UNSAFE_VALUE.test(value);

/** Reads an untrusted theme: unknown tokens and unsafe values are dropped one by one; an unknown mode means no theme. */
export function readHostTheme(value: unknown): HostTheme | null {
  if (typeof value !== 'object' || value === null) return null;
  const { mode, tokens } = value as { mode?: unknown; tokens?: unknown };
  if (mode !== 'light' && mode !== 'dark') return null;
  const out: HostTheme['tokens'] = {};
  if (typeof tokens === 'object' && tokens !== null) {
    for (const token of THEME_TOKENS) {
      const candidate = (tokens as Record<string, unknown>)[token];
      if (isThemeValue(candidate)) out[token] = candidate.trim();
    }
  }
  return { mode, tokens: out };
}
