/**
 * Chart colors. In `css` mode every color is `var(--se-token, fallback)` so a host theme restyles charts live.
 * In `static` mode the fallback is baked in, which is what standalone SVG/PNG exports need.
 */
export type ChartTheme = 'light' | 'dark';
export type PaintMode = 'css' | 'static';
export type TokenName = 'text' | 'muted' | 'axis' | 'grid' | 'surface' | 'up' | 'down' | 'neutral' | 'heatPos' | 'heatNeg' | 'heatMid' | 'focus' | 'band' | 'inkDark' | 'inkLight';
/** Colors read from the live page, as `#rrggbb`, keyed by token. Only the tokens a layout needs to reason about are ever read. */
export type TokenColors = Partial<Record<TokenName, string>>;

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
  // Label ink for text drawn on a data-driven fill (heat-map cells): one dark and one light, and the engine picks per fill.
  // Pure black and white by default, because together they reach WCAG 4.5:1 on every possible fill.
  inkDark: { css: '--se-chart-ink-dark', light: '#000000', dark: '#000000' },
  inkLight: { css: '--se-chart-ink-light', light: '#ffffff', dark: '#ffffff' },
};

export type Paint = {
  mode: PaintMode; theme: ChartTheme;
  /**
   * The color a token really has, as `#rrggbb`: the live value when the host supplied one (`createPaint({ colors })`), else the
   * theme's built-in value. Layouts use it to reason about contrast; `token` is what goes into the scene.
   */
  value(name: TokenName): string;
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

/** WCAG 2.x contrast ratio between two #rrggbb colors, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
/** WCAG AA for normal-size text. */
export const MIN_TEXT_CONTRAST = 4.5;
/**
 * Which of two inks reads better on `background`. An ink that reaches `MIN_TEXT_CONTRAST` beats one that does not; when both
 * reach it, or neither does, the higher ratio wins. `value` is whatever the caller wants back (for example the token expression).
 */
export function pickInk<T>(background: string, dark: { color: string; value: T }, light: { color: string; value: T }): T {
  const onDark = contrastRatio(background, dark.color), onLight = contrastRatio(background, light.color);
  const darkPasses = onDark >= MIN_TEXT_CONTRAST, lightPasses = onLight >= MIN_TEXT_CONTRAST;
  if (darkPasses !== lightPasses) return darkPasses ? dark.value : light.value;
  return onDark >= onLight ? dark.value : light.value;
}

const channelHex = (channel: number): string => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0');
const rgbHex = (r: number, g: number, b: number): string => `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`;
const KEYWORDS: Record<string, string> = { black: '#000000', white: '#ffffff' };
/** A CSS number, or a percentage of `scale`. */
const amount = (text: string, scale: number): number => text.endsWith('%') ? Number.parseFloat(text) / 100 * scale : Number.parseFloat(text);
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
function oklabToRgb(lightness: number, a: number, b: number): [number, number, number] {
  const l = (lightness + .3963377774 * a + .2158037573 * b) ** 3, m = (lightness - .1055613458 * a - .0638541728 * b) ** 3, s = (lightness - .0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [4.0767416621 * l - 3.3077115913 * m + .2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s, -.0041960863 * l - .7034186147 * m + 1.707614701 * s];
  return linear.map((value) => { const c = Math.max(0, Math.min(1, value)); return (c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055) * 255; }) as [number, number, number];
}
/**
 * Reads a CSS color a host may have put in a token (`#rgb`, `#rrggbb`, `rgb()`, `hsl()`, `oklch()`, `oklab()`, black and white) as `#rrggbb`.
 * Alpha is ignored. Anything else (`color-mix()`, other keywords, system colors) returns null and the caller keeps its built-in value.
 */
export function parseColor(value: string | null | undefined): string | null {
  const text = (value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text in KEYWORDS) return KEYWORDS[text]!;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    const digits = hex[1]!;
    return `#${digits.length <= 4 ? digits.slice(0, 3).split('').map((char) => char + char).join('') : digits.slice(0, 6)}`;
  }
  const call = /^(rgba?|hsla?|oklch|oklab)\(([^)]*)\)$/.exec(text);
  if (!call) return null;
  const parts = call[2]!.replace(/\s*\/.*$/, '').split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => /[a-z]{2,}/.test(part.replace(/deg|rad|turn|grad/, '')))) return null;
  const [p0, p1, p2] = parts as [string, string, string];
  let rgb: [number, number, number];
  if (call[1] === 'rgb' || call[1] === 'rgba') rgb = [amount(p0, 255), amount(p1, 255), amount(p2, 255)];
  else if (call[1] === 'hsl' || call[1] === 'hsla') rgb = hslToRgb(((Number.parseFloat(p0) % 360) + 360) % 360, amount(p1, 1), amount(p2, 1));
  else if (call[1] === 'oklch') { const c = amount(p1, .4), h = Number.parseFloat(p2) * Math.PI / 180; rgb = oklabToRgb(amount(p0, 1), c * Math.cos(h), c * Math.sin(h)); }
  else rgb = oklabToRgb(amount(p0, 1), amount(p1, .4), amount(p2, .4));
  return rgb.every(Number.isFinite) ? rgbHex(...rgb) : null;
}

export function createPaint(options: { mode?: PaintMode; theme?: ChartTheme; colors?: TokenColors } = {}): Paint {
  const mode = options.mode ?? 'css', theme = options.theme ?? 'light';
  const colors = series[theme], live = mode === 'css' ? options.colors : undefined;
  const token = (name: TokenName): string => mode === 'css' ? `var(${tokens[name].css}, ${tokens[name][theme]})` : tokens[name][theme];
  const value = (name: TokenName): string => live?.[name] ?? parseColor(tokens[name][theme]) ?? '#808080';
  return {
    mode, theme, token, value,
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
