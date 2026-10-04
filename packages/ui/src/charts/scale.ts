/** Scales and tick generation. Pure math; no DOM. */
export type LinearScale = {
  (value: number): number;
  domain: readonly [number, number];
  range: readonly [number, number];
  invert(position: number): number;
};
export type Ticks = { ticks: number[]; min: number; max: number; step: number };

/** The largest magnitude a scale will work with, so ±Number.MAX_VALUE inputs stay finite. */
export const MAGNITUDE_CAP = 1e300;
export function clampMagnitude(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(-MAGNITUDE_CAP, Math.min(MAGNITUDE_CAP, value));
}

/** Heckbert "nice number": rounds `range` to 1, 2, 5 or 10 times a power of ten. */
export function niceNumber(range: number, round: boolean): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  const nice = round
    ? (fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10)
    : (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10);
  return nice * 10 ** exponent;
}

function tidy(value: number, step: number): number {
  const digits = Math.max(0, Math.min(12, Math.ceil(-Math.log10(step) + 2)));
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Nice axis ticks that cover [min, max]. `count` is a target; the result has roughly that many ticks.
 * A degenerate range (min === max) is widened around the value so a flat series still draws a plot.
 */
export function niceTicks(minimum: number, maximum: number, count = 5): Ticks {
  let min = clampMagnitude(Math.min(minimum, maximum)), max = clampMagnitude(Math.max(minimum, maximum));
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * .1;
    min -= pad; max += pad;
  }
  const target = Math.max(2, Math.floor(count));
  // Work on halves so a range spanning ±MAX_VALUE cannot overflow to Infinity.
  const range = Math.abs(max / 2 - min / 2) * 2;
  const step = niceNumber(niceNumber(range, false) / (target - 1), true);
  if (!(step > 0) || !Number.isFinite(step)) return { ticks: [min, max], min, max, step: max - min || 1 };
  const niceMin = Math.floor(min / step + 1e-9) * step, niceMax = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  const total = Math.min(200, Math.round((niceMax / 2 - niceMin / 2) * 2 / step));
  for (let index = 0; index <= total; index++) ticks.push(tidy(niceMin + index * step, step));
  return { ticks, min: ticks[0] ?? niceMin, max: ticks[ticks.length - 1] ?? niceMax, step };
}

export function linearScale(domain: readonly [number, number], range: readonly [number, number]): LinearScale {
  const [d0, d1] = [clampMagnitude(domain[0]), clampMagnitude(domain[1])], [r0, r1] = range;
  const span = d1 / 2 - d0 / 2;
  const scale = ((value: number): number => {
    if (span === 0) return (r0 + r1) / 2;
    const ratio = (clampMagnitude(value) / 2 - d0 / 2) / span;
    return r0 + ratio * (r1 - r0);
  }) as LinearScale;
  scale.domain = [d0, d1]; scale.range = range;
  scale.invert = (position) => r1 === r0 ? d0 : d0 + (position - r0) / (r1 - r0) * (d1 - d0);
  return scale;
}

export type BandScale = {
  (index: number): number;
  bandwidth: number; step: number; count: number;
  center(index: number): number;
  /** Index of the band under `position`, clamped to the valid range. */
  indexAt(position: number): number;
};
/** Evenly divides [start, end] into `count` bands separated by `paddingInner` of a step and edged by `paddingOuter`. */
export function bandScale(count: number, range: readonly [number, number], paddingInner = .2, paddingOuter = paddingInner / 2): BandScale {
  const [start, end] = range, n = Math.max(1, count);
  const steps = Math.max(1e-9, n - paddingInner + paddingOuter * 2);
  const step = (end - start) / steps, bandwidth = step * (1 - paddingInner);
  const offset = start + step * paddingOuter;
  const scale = ((index: number) => offset + step * index) as BandScale;
  scale.bandwidth = bandwidth; scale.step = step; scale.count = n;
  scale.center = (index) => offset + step * index + bandwidth / 2;
  scale.indexAt = (position) => Math.max(0, Math.min(n - 1, Math.floor((position - start) / (step || 1))));
  return scale;
}

/** Points evenly spaced on [start, end]; a single point sits in the middle. */
export type PointScale = { (index: number): number; step: number; count: number; indexAt(position: number): number };
export function pointScale(count: number, range: readonly [number, number], padding = 0): PointScale {
  const [start, end] = range, n = Math.max(1, count);
  const inner = (end - start) - padding * 2, step = n === 1 ? 0 : inner / (n - 1);
  const scale = ((index: number) => n === 1 ? (start + end) / 2 : start + padding + step * index) as PointScale;
  scale.step = step; scale.count = n;
  scale.indexAt = (position) => n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((position - start - padding) / (step || 1))));
  return scale;
}

export function extent(values: readonly number[]): [number, number] {
  let min = Infinity, max = -Infinity;
  for (const value of values) { if (!Number.isFinite(value)) continue; if (value < min) min = value; if (value > max) max = value; }
  return min > max ? [0, 1] : [min, max];
}

/** How many labels to skip so that labels of `labelWidth` fit in `available` pixels. */
export function labelStride(count: number, available: number, labelWidth: number): number {
  if (count <= 1) return 1;
  const fit = Math.max(1, Math.floor(available / Math.max(1, labelWidth)));
  return Math.max(1, Math.ceil(count / fit));
}

/** Approximate text width in px; avoids touching the DOM so layout is deterministic on the server. */
export function textWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) width += char.charCodeAt(0) > 0x2e80 ? fontSize : /[A-Z0-9%$€£¥@mwMW]/.test(char) ? fontSize * .64 : fontSize * .54;
  return width;
}
export function truncate(text: string, maxWidth: number, fontSize: number): string {
  if (textWidth(text, fontSize) <= maxWidth) return text;
  let out = '';
  for (const char of text) { if (textWidth(`${out}${char}…`, fontSize) > maxWidth) break; out += char; }
  return `${out}…`;
}
