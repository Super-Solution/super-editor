/**
 * Chart colors. In `css` mode every color is `var(--se-token, fallback)` so a host theme restyles charts live.
 * In `static` mode the fallback is baked in, which is what standalone SVG/PNG exports need.
 */
export type ChartTheme = 'light' | 'dark';
export type PaintMode = 'css' | 'static';
export type TokenName = 'text' | 'muted' | 'axis' | 'grid' | 'surface' | 'up' | 'down' | 'neutral' | 'heatPos' | 'heatNeg' | 'heatMid' | 'focus' | 'band';

export const SERIES_COUNT = 10;
const series: Record<ChartTheme, readonly string[]> = {
  light: ['#2563eb', '#f97316', '#16a34a', '#9333ea', '#db2777', '#0891b2', '#ca8a04', '#64748b', '#dc2626', '#4d7c0f'],
  dark: ['#60a5fa', '#fb923c', '#4ade80', '#c084fc', '#f472b6', '#22d3ee', '#facc15', '#94a3b8', '#f87171', '#a3e635'],
};
const tokens: Record<TokenName, { css: string; light: string; dark: string }> = {
  text: { css: '--se-text', light: '#1f2328', dark: '#e6e8eb' },
  muted: { css: '--se-muted', light: '#6b7280', dark: '#9aa3af' },
  axis: { css: '--se-chart-axis', light: '#9ca3af', dark: '#6b7280' },
  grid: { css: '--se-chart-grid', light: '#e5e7eb', dark: '#2a2f36' },
  surface: { css: '--se-surface', light: '#ffffff', dark: '#15181d' },
  up: { css: '--se-up', light: '#16a34a', dark: '#34d399' },
  down: { css: '--se-down', light: '#dc2626', dark: '#f87171' },
  neutral: { css: '--se-chart-neutral', light: '#64748b', dark: '#94a3b8' },
  heatPos: { css: '--se-heat-high', light: '#2563eb', dark: '#60a5fa' },
  heatNeg: { css: '--se-heat-low', light: '#ea580c', dark: '#fb923c' },
  heatMid: { css: '--se-heat-mid', light: '#f8fafc', dark: '#1c2026' },
  focus: { css: '--se-focus', light: '#2563eb', dark: '#60a5fa' },
  band: { css: '--se-chart-band', light: 'rgba(100,116,139,.10)', dark: 'rgba(148,163,184,.14)' },
};

export type Paint = {
  mode: PaintMode; theme: ChartTheme;
  /** Series color by index; `override` is the series' own validated color. */
  series(index: number, override?: string): string;
  token(name: TokenName): string;
  /** Mixes two colors; `ratio` of `b` into `a`. */
  mix(a: TokenName, b: TokenName, ratio: number): string;
};

/** A color a document may carry: hex, a CSS keyword, or var(--token). Anything else is dropped. */
export function safeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[A-Za-z]{3,30}|var\(--[A-Za-z0-9_-]{1,60}\))$/.test(value) ? value : null;
}

function hexToRgb(hex: string): [number, number, number] {
  const text = hex.startsWith('#') ? hex.slice(1) : hex;
  const full = text.length === 3 ? text.split('').map((char) => char + char).join('') : text.slice(0, 6);
  const value = Number.parseInt(full, 16);
  return Number.isNaN(value) ? [128, 128, 128] : [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
export function mixHex(a: string, b: string, ratio: number): string {
  const t = Math.max(0, Math.min(1, ratio)), x = hexToRgb(a), y = hexToRgb(b);
  const channel = (index: number): string => Math.round(x[index]! + (y[index]! - x[index]!) * t).toString(16).padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}
/** WCAG relative luminance of a #rrggbb color. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => { const c = channel / 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }) as [number, number, number];
  return .2126 * r + .7152 * g + .0722 * b;
}

export function createPaint(options: { mode?: PaintMode; theme?: ChartTheme } = {}): Paint {
  const mode = options.mode ?? 'css', theme = options.theme ?? 'light';
  const colors = series[theme];
  const token = (name: TokenName): string => mode === 'css' ? `var(${tokens[name].css}, ${tokens[name][theme]})` : tokens[name][theme];
  return {
    mode, theme, token,
    series(index, override) {
      const own = safeColor(override);
      if (own) return own;
      const slot = ((index % SERIES_COUNT) + SERIES_COUNT) % SERIES_COUNT;
      return mode === 'css' ? `var(--se-series-${slot + 1}, ${colors[slot]})` : colors[slot]!;
    },
    mix(a, b, ratio) {
      const t = Math.max(0, Math.min(1, ratio));
      if (mode === 'static') return mixHex(tokens[a][theme], tokens[b][theme], t);
      return `color-mix(in srgb, ${token(b)} ${Math.round(t * 100)}%, ${token(a)})`;
    },
  };
}

/** Kept for backwards compatibility with 0.1: the first six series colors as CSS expressions. */
export const chartColors: string[] = Array.from({ length: 6 }, (_, index) => `var(--se-series-${index + 1}, ${series.light[index]})`);
export const seriesHex = series;
export const tokenFallbacks = tokens;
